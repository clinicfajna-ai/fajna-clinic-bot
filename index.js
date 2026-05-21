const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
// const { Pinecone } = require('@pinecone-database/pinecone');
// const OpenAI = require('openai');
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
  
  // ТИМЧАСОВО ВІДКЛЮЧЕНО ДЛЯ ТЕСТУ
  // const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  // const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  // const index = pc.index('clinic-base');

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
    item.durationsingle || "" // <--- ДОДАНО ЧАС ВИКОНАННЯ
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
    docText += "**Онлайн-консультації:** " + docItem.online_consultations + "\n";
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
      let meta_1 = "";
      let meta_2 = "";
      let meta_3 = "";

      if (config.name === 'all_services') {
        const code = row._rawData[0];
        const category = row._rawData[1] || 'Загальне';
        const name = row._rawData[2];
        const price = row._rawData[3] || '0';
        const duration = row._rawData[4]; // <--- Зчитуємо час з 5-ї колонки (E)
        
        if (!code || !name || code === 'Код послуги') return;
        
        // Формуємо текст з урахуванням часу
        text = "Категорія: " + category + ". Назва послуги: " + name + ". Код: " + code + ". Ціна: " + price + " грн.";
        if (duration) {
          text += " Тривалість: " + duration + " хв.";
        }
        
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
  console.log(`Лист Vector_Data оновлено. Всього рядків: ${finalRows.length}`);

  // ========================================================
  // БЛОК ЗАВАНТАЖЕННЯ У PINECONE - ТИМЧАСОВО ЗАКОМЕНТОВАНО
  // ========================================================
  
  /*
  const toUpload = finalRows.filter(r => r.status === 'pending');
  console.log("До завантаження в Pinecone: " + toUpload.length);

  const batchSize = 100;
  for (let i = 0; i < toUpload.length; i += batchSize) {
    // ... логіка Pinecone
  }
  */

  console.log("ТЕСТОВИЙ РЕЖИМ: Збір даних успішний, але відправку до Pinecone відключено.");
}

sync();
