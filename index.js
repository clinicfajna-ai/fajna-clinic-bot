const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { Pinecone } = require('@pinecone-database/pinecone'); // РОЗКОМЕНТОВАНО
const OpenAI = require('openai'); // РОЗКОМЕНТОВАНО
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
  
  // ПІДКЛЮЧЕННЯ ДО ШІ ТА БД (РОЗКОМЕНТОВАНО)
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const index = pc.index('clinic-base'); // Переконайтесь, що назва індексу правильна!

  console.log("=== ЕТАП 1: Оновлення листів з API ===");
  
  // 1. Оновлення прайсу
  console.log("Завантаження прайсу з DocDream...");
  const priceRes = await fetch("https://des.fajna.clinic/for_inboost/get_routines.php?json=1");
  const priceData = await priceRes.json();
  const priceSheet = doc.sheetsByTitle['all_services'];
  await priceSheet.clearRows();
  
  const priceRowsToInsert = priceData.map(item => [
    item.code || "",
    item.group || "Загальне",
    item.name || "",
    item.price || "0",
    item.durationsingle || ""
  ]);
  
  if(priceRowsToInsert.length > 0) {
    await priceSheet.addRows(priceRowsToInsert);
  }
  console.log(`Оновлено лист all_services: ${priceRowsToInsert.length} рядків.`);

  // 2. Оновлення лікарів
  console.log("Завантаження лікарів з DocDream...");
  const docRes = await fetch("https://des.fajna.clinic/for_inboost/get_docs.php?json=1");
  const docData = await docRes.json();
  const docSheet = doc.sheetsByTitle['doctors_knowledge_base'];
  await docSheet.clearRows();
  
  const docRowsToInsert = docData.map(docItem => {
    let docText = "Інформація про спеціаліста. Лікар: " + docItem.title + "\n";
    docText += "**Спеціалізація:** " + docItem.profession + "\n";
    docText += "**Напрямки:** " + (docItem.main_way ? docItem.main_way.join(", ") : "") + "\n";
    docText += "**Пацієнти:** " + (docItem.patients ? docItem.patients.join(", ") : "") + "\n";
    docText += "**Практикує з:** " + docItem.first_practice_year + "\n";
    docText += "**Філії де приймає:** " + (docItem.clinics ? docItem.clinics.join(" | ") : "") + "\n";
    docText += "**Online-консультації:** " + docItem.online_consultations + "\n";
    if (docItem.languages) docText += "**Мови:** " + docItem.languages + "\n";
    docText += "**Сторінка:** " + docItem.url + "\n\n";
    docText += "Про лікаря:\n" + (docItem.about || "") + "\n\n";
    
    if (docItem.public_activity) {
      docText += "**Громадська діяльність:**\n" + docItem.public_activity + "\n\n";
    }
    
    if (docItem.services && docItem.services.length > 0) {
      docText += "**Послуги лікаря:**\n";
      docItem.services.forEach(s => {
        docText += "• " + s.name + " (Код: " + s.code + ")\n";
      });
    }
    return [docText];
  });
  
  if (docRowsToInsert.length > 0) {
    await docSheet.addRows(docRowsToInsert);
  }
  console.log(`Оновлено лист doctors_knowledge_base: ${docRowsToInsert.length} рядків.`);


  console.log("\n=== ЕТАП 2: Формування Vector_Data ===");
  
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

      if (config.name === 'all_services') {
        const code = row._rawData[0];
        const category = row._rawData[1] || 'Загальне';
        const name = row._rawData[2];
        const price = row._rawData[3] || '0';
        const duration = row._rawData[4];
        
        if (!code || !name || code === 'Код послуги') return;
        
        text = "Категорія: " + category + ". Назва послуги: " + name + ". Код: " + code + ". Ціна: " + price + " грн.";
        if (duration) {
          text += " Тривалість: " + duration + " хв.";
        }
      } else {
        if (!text || text === 'Питання' || text.includes('Загальна інформація')) return;
      }

      const textHash = crypto.createHash('md5').update(text).digest('hex').substring(0, 15);
      const generatedId = config.prefix + '_' + textHash;
      
      let status = "pending";
      if (existingMap.has(generatedId) && existingMap.get(generatedId).text === text) {
        status = existingMap.get(generatedId).status;
      }

      finalRows.push({ id: generatedId, text, status, chunk_type });
    });
  }

  await vectorSheet.clearRows();
  await vectorSheet.addRows(finalRows);
  console.log(`Лист Vector_Data оновлено. Всього рядків: ${finalRows.length}`);

  // ========================================================
  // ЕТАП 3: БЛОК ЗАВАНТАЖЕННЯ У PINECONE (РОЗКОМЕНТОВАНО)
  // ========================================================
  
  const toUpload = finalRows.filter(r => r.status === 'pending');
  console.log("До завантаження в Pinecone: " + toUpload.length);

  const batchSize = 100;
  for (let i = 0; i < toUpload.length; i += batchSize) {
    const chunk = toUpload.slice(i, i + batchSize);
    try {
      const inputs = chunk.map(item => item.text);

      // Створення векторів через OpenAI
      const embeddingResponse = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: inputs,
      });

      // Формування об'єктів для Pinecone
      const vectors = chunk.map((item, idx) => {
        const safeText = String(item.text).replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
        let metadata = { text: safeText, chunk_type: item.chunk_type };
        
        return {
          id: String(item.id),
          values: embeddingResponse.data[idx].embedding,
          metadata: metadata
        };
      });

      // Відправка в базу
      await index.upsert(vectors);
      console.log("Успішно завантажено пачку з " + i + " по " + (i + chunk.length));
    } catch (e) {
      console.error("Помилка завантаження пачки на індексі " + i + ": " + e.message);
    }
  }

  // Оновлення статусів у таблиці на 'uploaded'
  const totalCount = finalRows.length;
  if (totalCount > 0) {
    await vectorSheet.loadCells({
      startRowIndex: 1,
      endRowIndex: totalCount + 1,
      startColumnIndex: 2, // Зверніть увагу: це колонка C (статуси)
      endColumnIndex: 3
    });

    for (let i = 0; i < totalCount; i++) {
      const cell = vectorSheet.getCell(i + 1, 2);
      cell.value = 'uploaded';
    }
    await vectorSheet.saveUpdatedCells();
  }

  console.log("=== СИНХРОНІЗАЦІЮ ЗАВЕРШЕНО УСПІШНО! ===");
}

sync();
