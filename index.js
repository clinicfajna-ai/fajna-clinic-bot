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

  console.log("=== ЕТАП 1: Оновлення листів з API ===");
  
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

  console.log("Завантаження лікарів з DocDream...");
  const docRes = await fetch("https://des.fajna.clinic/for_inboost/get_docs.php?json=1");
  const docData = await docRes.json();
  const docSheet = doc.sheetsByTitle['doctors_knowledge_base'];
  await docSheet.clearRows();
  
  const docRowsToInsert = docData.map(docItem => {
    let docText = "Інформація про спеціаліста. Лікар: " + docItem.title + "\n";
    docText += "Спеціалізація: " + docItem.profession + "\n";
    docText += "Напрямки: " + (docItem.main_way ? docItem.main_way.join(", ") : "") + "\n";
    docText += "Пацієнти: " + (docItem.patients ? docItem.patients.join(", ") : "") + "\n";
    docText += "Практикує з: " + docItem.first_practice_year + "\n";
    docText += "Філії де приймає: " + (docItem.clinics ? docItem.clinics.join(" | ") : "") + "\n";
    docText += "Online-консультації: " + docItem.online_consultations + "\n";
    if (docItem.languages) docText += "Мови: " + docItem.languages + "\n";
    docText += "Сторінка: " + docItem.url + "\n\n";
    docText += "Про лікаря:\n" + (docItem.about || "") + "\n\n";
    
    if (docItem.public_activity) {
      docText += "Громадська діяльність:\n" + docItem.public_activity + "\n\n";
    }
    
    if (docItem.services && docItem.services.length > 0) {
      docText += "Послуги лікаря:\n";
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

  console.log("Формування зведених карток по спеціальностях...");
  let specialtyMap = {};
  
  docData.forEach(docItem => {
    if(docItem.main_way && docItem.main_way.length > 0) {
      docItem.main_way.forEach(spec => {
        let cleanSpec = spec.trim();
        if(!specialtyMap[cleanSpec]) {
          specialtyMap[cleanSpec] = [];
        }
        specialtyMap[cleanSpec].push(`• ${docItem.title} (${docItem.profession})`);
      });
    }
  });

  const specSheet = doc.sheetsByTitle['specialties_summary'];
  if (specSheet) {
    await specSheet.clearRows();
    let specRowsToInsert = [];
    
    for (let spec in specialtyMap) {
      let specText = `Зведення лікарів за напрямком: ${spec}\n`;
      specText += `У клініці приймають такі фахівці:\n`;
      specText += specialtyMap[spec].join("\n");
      specText += `\n(Щоб дізнатися деталі, освіту чи ціни конкретного лікаря, шукайте за його прізвищем).`;
      
      specRowsToInsert.push([specText]);
    }
    
    if (specRowsToInsert.length > 0) {
      await specSheet.addRows(specRowsToInsert);
    }
    console.log(`Оновлено лист specialties_summary: ${specRowsToInsert.length} карток.`);
  } else {
    console.log("Лист specialties_summary не знайдено, пропускаємо цей крок. Створіть його у таблиці!");
  }

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
    { name: 'specialties_summary', prefix: 'spec', default_chunk_type: 'specialty' },
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
