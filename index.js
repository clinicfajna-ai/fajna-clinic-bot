const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');
const crypto = require('crypto');

async function sync() {
const auth = new JWT({
email: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON).client_email,
key: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON).private_key,
scopes: [
"https://www.googleapis.com/auth/spreadsheets",
"https://www.googleapis.com/auth/drive"
],
});

const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
await doc.loadInfo();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const index = pc.index('clinic-base');

const vectorSheet = doc.sheetsByTitle['Vector_Data'];
const oldRows = await vectorSheet.getRows();
const existingMap = new Map();

oldRows.forEach(row => {
const id = row._rawData[0];
if (id) {
existingMap.set(id, {
text: row._rawData[1],
status: row._rawData[2]
});
}
});

const sheetsToCollect = [
{ name: 'all_services', prefix: 'price', default_chunk_type: 'price' },
{ name: 'doctors_knowledge_base', prefix: 'doc', default_chunk_type: 'doctor' },
{ name: 'preparation', prefix: 'prep', default_chunk_type: 'preparation' },
{ name: 'general_info', prefix: 'info', default_chunk_type: 'general_info' },
{ name: 'vaccination', prefix: 'vac', default_chunk_type: 'vaccination' },
{ name: 'upsell_logic', prefix: 'upsell', default_chunk_type: 'upsell_rule' },
{ name: 'navigation', prefix: 'nav', default_chunk_type: 'navigation' },
{ name: 'insurance', prefix: 'ins', default_chunk_type: 'insurance' }
];

let finalRows = [];

for (const config of sheetsToCollect) {
const sheet = doc.sheetsByTitle[config.name];
if (!sheet) continue;

const rows = await sheet.getRows();

rows.forEach((row) => {
  let text = row._rawData[0];
  let chunk_type = config.default_chunk_type;
  let meta_1 = "";
  let meta_2 = "";
  let meta_3 = "";

  if (config.name === 'all_services') {
    const code = row._rawData[0];
    const category = row._rawData[1] || 'Загальне';
    const name = row._rawData[2];
    const price = row._rawData[3] || '0';
    if (!code || !name || code === 'Код послуги') return;
    text = "Категорія: " + category + ". Назва послуги: " + name + ". Код: " + code + ". Ціна: " + price + " грн.";
    meta_1 = category;
  } else {
    if (!text || text === 'Питання' || text.includes('Загальна інформація')) return;
    
    if (config.name === 'doctors_knowledge_base') {
      const parts = text.split(':');
      
      if (parts.length > 1) {
        let categoryRaw = parts[0].trim();
        if (categoryRaw.includes('. Лікар')) {
          categoryRaw = categoryRaw.replace('. Лікар', '');
        }
        meta_1 = categoryRaw;
        
        const namePart = parts[1].trim().split(' ')[0];
        meta_3 = namePart.replace(/[*,]/g, ''); 
      } else {
        meta_1 = 'general';
      }

      const meta1Lower = meta_1.toLowerCase();
      
      if (meta1Lower.includes('дитяч') || meta1Lower.includes('дітям')) {
        meta_2 = 'child';
      } else if (meta1Lower.includes('доросл')) {
        meta_2 = 'adult';
      } else if (text.includes('Пацієнти: Дорослі, Діти')) {
        meta_2 = 'both';
      } else if (text.includes('Пацієнти: Дорослі')) {
        meta_2 = 'adult';
      } else if (text.includes('Пацієнти: Діти')) {
        meta_2 = 'child';
      } else {
        meta_2 = 'both';
      }
    }
    else if (['preparation', 'general_info', 'navigation'].includes(config.name)) {
      meta_1 = text.split('\n')[0].trim();
    }
    else if (config.name === 'vaccination') {
      const vPart = text.split('Вакцина:')[1];
      if (vPart) meta_1 = vPart.split('\n')[0].trim();
      const dPart = text.split('Від чого захищає:')[1];
      if (dPart) meta_2 = dPart.split('\n')[0].trim();
    }
    else if (config.name === 'upsell_logic') {
      const bPart = text.split('Основна послуга:')[1];
      if (bPart) meta_1 = bPart.split('\n')[0].trim();
      const tPart = text.split('Пропозиція:')[1];
      if (tPart) meta_2 = tPart.split('\n')[0].trim();
    }
  }

  const textHash = crypto.createHash('md5').update(text).digest('hex').substring(0, 15);
  const generatedId = config.prefix + '_' + textHash;
  
  let status = "pending";
  if (existingMap.has(generatedId) && existingMap.get(generatedId).text === text) {
    status = existingMap.get(generatedId).status;
  }

  finalRows.push({ id: generatedId, text, status, chunk_type, meta_1, meta_2, meta_3 });
});
}

await vectorSheet.clearRows();
await vectorSheet.addRows(finalRows);

const toUpload = finalRows.filter(r => r.status === 'pending');
console.log("До завантаження в Pinecone: " + toUpload.length);

const batchSize = 100;
for (let i = 0; i < toUpload.length; i += batchSize) {
const chunk = toUpload.slice(i, i + batchSize);
try {
const inputs = chunk.map(item => item.text);

  const embeddingResponse = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: inputs,
  });

  const vectors = chunk.map((item, idx) => {
    const safeText = String(item.text).replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
    let metadata = { text: safeText, chunk_type: item.chunk_type };
    if (item.meta_1) metadata.meta_1 = item.meta_1;
    if (item.meta_2) metadata.meta_2 = item.meta_2;
    if (item.meta_3) metadata.meta_3 = item.meta_3;
    
    return {
      id: String(item.id),
      values: embeddingResponse.data[idx].embedding,
      metadata: metadata
    };
  });

  await index.upsert(vectors);
  console.log("Успішно завантажено пачку з " + i + " по " + (i + chunk.length));
} catch (e) {
  console.error("Помилка завантаження пачки на індексі " + i + ": " + e.message);
}
}

const totalCount = finalRows.length;
if (totalCount > 0) {
await vectorSheet.loadCells({
startRowIndex: 1,
endRowIndex: totalCount + 1,
startColumnIndex: 2,
endColumnIndex: 3
});

for (let i = 0; i < totalCount; i++) {
  const cell = vectorSheet.getCell(i + 1, 2);
  cell.value = 'uploaded';
}
await vectorSheet.saveUpdatedCells();
}

console.log("Синхронізація з Pinecone завершена успішно за лічені секунди!");
}

sync();
