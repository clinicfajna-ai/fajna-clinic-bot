const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');
const crypto = require('crypto');

async function sync() {
  const auth = new JWT({
    email: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON).client_email,
    key: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON).private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"],
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  await doc.loadInfo();
  
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const pc = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const index = pc.index('clinic-base'); 

  // --- ЕТАП 1: Оновлення листів з API ---
  const priceRes = await fetch("https://des.fajna.clinic/for_inboost/get_routines.php?json=1");
  const priceData = await priceRes.json();
  const priceSheet = doc.sheetsByTitle['all_services'];
  await priceSheet.loadHeaderRow();
  await priceSheet.clearRange('A2:E5000');
  await priceSheet.addRows(priceData.map(item => [item.code || "", item.group || "Загальне", item.name || "", item.price || "0", item.durationsingle || ""]));

  const docRes = await fetch("https://des.fajna.clinic/for_inboost/get_docs.php?json=1");
  const docData = await docRes.json();
  const docSheet = doc.sheetsByTitle['doctors_knowledge_base'];
  await docSheet.loadHeaderRow();
  await docSheet.clearRange('A2:A5000');
  await docSheet.addRows(docData.map(docItem => {
    let docText = `Інформація про спеціаліста. Лікар: ${docItem.title}\nСпеціалізація: ${docItem.profession}\nНапрямки: ${(docItem.main_way || []).join(", ")}\nПацієнти: ${(docItem.patients || []).join(", ")}\nПрактикує з: ${docItem.first_practice_year}\nФілії: ${(docItem.clinics || []).join(" | ")}\nOnline: ${docItem.online_consultations}\nСторінка: ${docItem.url}\n\nПро лікаря: ${docItem.about || ""}\n\n${docItem.public_activity ? "Громадська діяльність: " + docItem.public_activity + "\n\n" : ""}${docItem.services ? "Послуги:\n" + docItem.services.map(s => "• " + s.name + " (Код: " + s.code + ")").join("\n") : ""}`;
    return [docText];
  }));

  const specSheet = doc.sheetsByTitle['specialties_summary'];
  await specSheet.loadHeaderRow();
  await specSheet.clearRange('A2:A5000');
  let specialtyMap = {};
  docData.forEach(d => (d.main_way || []).forEach(s => {
    if(!specialtyMap[s.trim()]) specialtyMap[s.trim()] = [];
    specialtyMap[s.trim()].push(`• ${d.title} (${d.profession})`);
  }));
  await specSheet.addRows(Object.keys(specialtyMap).map(spec => [`Зведення: ${spec}\nФахівці:\n${specialtyMap[spec].join("\n")}`]));

  // --- ЕТАП 2: Формування масиву finalRows ---
  const vectorSheet = doc.sheetsByTitle['Vector_Data'];
  const oldRows = await vectorSheet.getRows();
  const existingMap = new Map(oldRows.map(r => [r._rawData[0], {text: r._rawData[1], status: r._rawData[2]}]));

  let finalRows = [];
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

  for (const config of sheetsToCollect) {
    const sheet = doc.sheetsByTitle[config.name];
    if (!sheet) continue;
    const rows = await sheet.getRows();
    rows.forEach((row) => {
      let text = row._rawData[0] || "";
      if (config.name === 'all_services') {
        text = `Категорія: ${row._rawData[1] || 'Загальне'}. Послуга: ${row._rawData[2]}. Код: ${row._rawData[0]}. Ціна: ${row._rawData[3] || '0'} грн. Тривалість: ${row._rawData[4] || ''} хв.`;
      }
      if (!text || text === 'Питання' || text.includes('Загальна інформація')) return;
      const id = config.prefix + '_' + crypto.createHash('md5').update(String(text)).digest('hex').substring(0, 15);
      finalRows.push({ id, text, status: existingMap.has(id) && existingMap.get(id).text === text ? existingMap.get(id).status : 'pending', chunk_type: config.default_chunk_type });
    });
  }

  // --- ЕТАП 3: Синхронізація (Видалення старого з Pinecone) ---
  console.log("=== ЕТАП 3: Синхронізація (Видалення старого) ===");
  const currentIds = new Set(finalRows.map(r => r.id));
  const idsToDelete = [...existingMap.keys()].filter(id => !currentIds.has(id));
  
  if (idsToDelete.length > 0) {
    for (let i = 0; i < idsToDelete.length; i += 100) {
      await index.deleteMany(idsToDelete.slice(i, i + 100));
    }
    console.log(`Видалено застарілих записів: ${idsToDelete.length}`);
  }

  // --- Оновлення таблиці ---
  await vectorSheet.clearRange('A2:D5000');
  await vectorSheet.addRows(finalRows.map(r => [r.id, r.text, r.status, r.chunk_type]));
  
  // --- Завантаження нових ---
  const toUpload = finalRows.filter(r => r.status === 'pending');
  for (let i = 0; i < toUpload.length; i += 100) {
    const chunk = toUpload.slice(i, i + 100);
    const embeddingResponse = await openai.embeddings.create({ model: "text-embedding-3-small", input: chunk.map(c => c.text) });
    await index.upsert(chunk.map((item, idx) => ({ id: item.id, values: embeddingResponse.data[idx].embedding, metadata: { text: item.text, chunk_type: item.chunk_type } })));
  }

  // --- Оновлення статусів ---
  await vectorSheet.loadHeaderRow();
  const cells = await vectorSheet.loadCells(`C2:C${finalRows.length + 1}`);
  for (let i = 0; i < finalRows.length; i++) cells.getCell(i, 0).value = 'uploaded';
  await vectorSheet.saveUpdatedCells();
  
  console.log("=== СИНХРОНІЗАЦІЮ ЗАВЕРШЕНО УСПІШНО! ===");
}
sync();
