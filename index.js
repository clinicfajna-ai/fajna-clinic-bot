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

  console.log("=== ЕТАП 1: Оновлення листів Google Sheets ===");
  
  // 1. Оновлення прайсу
  const priceRes = await fetch("https://des.fajna.clinic/for_inboost/get_routines.php?json=1");
  const priceData = await priceRes.json();
  const priceSheet = doc.sheetsByTitle['all_services'];
  await priceSheet.clearRows();
  await priceSheet.setHeaderRow(['Код', 'Категорія', 'Назва', 'Ціна', 'Тривалість']);
  await priceSheet.addRows(priceData.map(item => [item.code || "", item.group || "Загальне", item.name || "", item.price || "0", item.durationsingle || ""]));

  // 2. Оновлення лікарів
  const docRes = await fetch("https://des.fajna.clinic/for_inboost/get_docs.php?json=1");
  const docData = await docRes.json();
  const docSheet = doc.sheetsByTitle['doctors_knowledge_base'];
  await docSheet.clearRows();
  await docSheet.setHeaderRow(['Інформація про лікаря']);
  await docSheet.addRows(docData.map(d => [`Лікар: ${d.title}\nСпеціалізація: ${d.profession}\nНапрямки: ${(d.main_way || []).join(", ")}\nПрактикує з: ${d.first_practice_year}\nФілії: ${(d.clinics || []).join(" | ")}\nOnline: ${d.online_consultations}\n\nПро: ${d.about || ""}\n\nПослуги:\n${d.services ? d.services.map(s => "• " + s.name + " (" + s.code + ")").join("\n") : ""}`]));

  // 3. Зведення спеціальностей
  const specSheet = doc.sheetsByTitle['specialties_summary'];
  await specSheet.clearRows();
  await specSheet.setHeaderRow(['Зведення']);
  let specialtyMap = {};
  docData.forEach(d => (d.main_way || []).forEach(s => {
    if(!specialtyMap[s.trim()]) specialtyMap[s.trim()] = [];
    specialtyMap[s.trim()].push(`• ${d.title} (${d.profession})`);
  }));
  await specSheet.addRows(Object.keys(specialtyMap).map(spec => [`Зведення: ${spec}\nФахівці:\n${specialtyMap[spec].join("\n")}`]));

  console.log("\n=== ЕТАП 2: Формування масиву даних ===");
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

  // --- ЕТАП 3: Глибока синхронізація (Видалення сиріт з Pinecone) ---
  console.log("=== ЕТАП 3: Видалення 'сиріт' з Pinecone ===");
  const currentIds = new Set(finalRows.map(r => r.id));
  
  let allPineconeIds = [];
  let paginationToken = undefined;
  
  do {
    const list = await index.listPaginated({ limit: 1000, paginationToken });
    if (list.vectors) {
      allPineconeIds.push(...list.vectors.map(v => v.id));
    }
    paginationToken = list.pagination?.next;
  } while (paginationToken);

  const idsToDelete = allPineconeIds.filter(id => !currentIds.has(id));
  
  if (idsToDelete.length > 0) {
    console.log(`Знайдено ${idsToDelete.length} застарілих записів, видаляємо...`);
    for (let i = 0; i < idsToDelete.length; i += 100) {
      await index.deleteMany(idsToDelete.slice(i, i + 100));
    }
    console.log("Видалення завершено.");
  } else {
    console.log("Pinecone чистий, видалень не потрібно.");
  }

  // --- Оновлення таблиці ---
  await vectorSheet.clearRows();
  await vectorSheet.setHeaderRow(['id', 'text', 'status', 'chunk_type']);
  await vectorSheet.addRows(finalRows.map(r => [r.id, r.text, r.status, r.chunk_type]));
  
  // --- Завантаження нових ---
  const toUpload = finalRows.filter(r => r.status === 'pending');
  for (let i = 0; i < toUpload.length; i += 100) {
    const chunk = toUpload.slice(i, i + 100);
    const embeddingResponse = await openai.embeddings.create({ model: "text-embedding-3-small", input: chunk.map(c => c.text) });
    await index.upsert(chunk.map((item, idx) => ({ id: item.id, values: embeddingResponse.data[idx].embedding, metadata: { text: item.text, chunk_type: item.chunk_type } })));
  }

  // --- Оновлення статусів ---
  await vectorSheet.loadCells(`C2:C${finalRows.length + 1}`);
  for (let i = 0; i < finalRows.length; i++) {
     const cell = vectorSheet.getCell(i + 1, 2); 
     cell.value = 'uploaded';
  }
  await vectorSheet.saveUpdatedCells();
  
  console.log("=== СИНХРОНІЗАЦІЮ ЗАВЕРШЕНО УСПІШНО! ===");
}
sync();
