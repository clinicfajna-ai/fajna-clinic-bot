const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { Pinecone } = require('@pinecone-database/pinecone');
const OpenAI = require('openai');
const crypto = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────
const PINECONE_INDEX    = process.env.PINECONE_INDEX || 'clinic-base';
const BATCH_SIZE        = 100;
const HASH_LENGTH       = 20;
const EMBED_CONCURRENCY = 3; // max паралельних батчів embeddings

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeId(prefix, text) {
  return prefix + '_' + crypto.createHash('md5').update(String(text)).digest('hex').substring(0, HASH_LENGTH);
}

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} при запиті ${url}`);
  return res.json();
}

function formatDoctorText(d) {
  const services = d.services
    ? d.services.map(s => `• ${s.name} (${s.code})`).join('\n')
    : '';
  return [
    `Лікар: ${d.title}`,
    `Спеціалізація: ${d.profession}`,
    `Напрямки: ${(d.main_way || []).join(', ')}`,
    `Практикує з: ${d.first_practice_year}`,
    `Філії: ${(d.clinics || []).join(' | ')}`,
    `Online: ${d.online_consultations}`,
    '',
    `Про: ${d.about || ''}`,
    '',
    'Послуги:',
    services,
  ].join('\n');
}

// Виконує масив задач із обмеженням паралельності
async function pAll(items, concurrency, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...await Promise.all(batch.map(fn)));
  }
  return results;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function withRetry(fn, retries = 3, delayMs = 1000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`  ⚠️  Спроба ${attempt} невдала: ${err.message}. Повтор через ${delayMs * attempt}ms...`);
      await sleep(delayMs * attempt);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function sync() {
  // ── Ініціалізація клієнтів ──────────────────────────────────────────────────
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON не є валідним JSON');
  }

  const auth = new JWT({
    email:  serviceAccount.client_email,
    key:    serviceAccount.private_key,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });

  const doc    = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, auth);
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const pc     = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  const index  = pc.index(PINECONE_INDEX);

  await doc.loadInfo();

  // ── ЕТАП 1: Оновлення аркушів Google Sheets ────────────────────────────────
  console.log('\n=== ЕТАП 1: Оновлення листів Google Sheets ===');

  // 1а. Прайс
  console.log('  → Завантажую прайс...');
  const priceData = await withRetry(() =>
    fetchJSON('https://des.fajna.clinic/for_inboost/get_routines.php?json=1')
  );
  const priceSheet = doc.sheetsByTitle['all_services'];
  await priceSheet.clearRows();
  await priceSheet.setHeaderRow(['Код', 'Категорія', 'Назва', 'Ціна', 'Тривалість']);
  await priceSheet.addRows(
    priceData.map(item => [
      item.code           || '',
      item.group          || 'Загальне',
      item.name           || '',
      item.price          || '0',
      item.durationsingle || '',
    ])
  );
  console.log(`  ✓ Прайс: ${priceData.length} позицій`);

  // 1б. Лікарі
  console.log('  → Завантажую лікарів...');
  const docData = await withRetry(() =>
    fetchJSON('https://des.fajna.clinic/for_inboost/get_docs.php?json=1')
  );
  const docSheet = doc.sheetsByTitle['doctors_knowledge_base'];
  await docSheet.clearRows();
  await docSheet.setHeaderRow(['Інформація про лікаря']);
  await docSheet.addRows(docData.map(d => [formatDoctorText(d)]));
  console.log(`  ✓ Лікарі: ${docData.length} записів`);

  // 1в. Зведення по спеціальностях
  const specialtyMap = {};
  docData.forEach(d =>
    (d.main_way || []).forEach(s => {
      const key = s.trim();
      if (!specialtyMap[key]) specialtyMap[key] = [];
      specialtyMap[key].push(`• ${d.title} (${d.profession})`);
    })
  );
  const specSheet = doc.sheetsByTitle['specialties_summary'];
  await specSheet.clearRows();
  await specSheet.setHeaderRow(['Зведення']);
  await specSheet.addRows(
    Object.entries(specialtyMap).map(([spec, doctors]) => [
      `Зведення: ${spec}\nФахівці:\n${doctors.join('\n')}`,
    ])
  );
  console.log(`  ✓ Спеціальності: ${Object.keys(specialtyMap).length} категорій`);

  // ── ЕТАП 2: Формування масиву для векторизації ──────────────────────────────
  console.log('\n=== ЕТАП 2: Формування масиву даних ===');

  const vectorSheet = doc.sheetsByTitle['Vector_Data'];
  const oldRows     = await vectorSheet.getRows();
  const existingMap = new Map(
    oldRows.map(r => [r._rawData[0], { text: r._rawData[1], status: r._rawData[2] }])
  );

  const sheetsToCollect = [
    { name: 'all_services',           prefix: 'price',  chunk_type: 'price'        },
    { name: 'doctors_knowledge_base', prefix: 'doc',    chunk_type: 'doctor'       },
    { name: 'specialties_summary',    prefix: 'spec',   chunk_type: 'specialty'    },
    { name: 'preparation',            prefix: 'prep',   chunk_type: 'preparation'  },
    { name: 'general_info',           prefix: 'info',   chunk_type: 'general_info' },
    { name: 'vaccination',            prefix: 'vac',    chunk_type: 'vaccination'  },
    { name: 'upsell_logic',           prefix: 'upsell', chunk_type: 'upsell_rule'  },
    { name: 'navigation',             prefix: 'nav',    chunk_type: 'navigation'   },
    { name: 'insurance',              prefix: 'ins',    chunk_type: 'insurance'    },
  ];

  const finalRows = [];

  for (const config of sheetsToCollect) {
    const sheet = doc.sheetsByTitle[config.name];
    if (!sheet) {
      console.warn(`  ⚠️  Аркуш "${config.name}" не знайдено, пропускаю`);
      continue;
    }

    const rows = await sheet.getRows();

    rows.forEach(row => {
      let text = row._rawData[0] || '';

      if (config.name === 'all_services') {
        text = `Категорія: ${row._rawData[1] || 'Загальне'}. Послуга: ${row._rawData[2]}. Код: ${row._rawData[0]}. Ціна: ${row._rawData[3] || '0'} грн. Тривалість: ${row._rawData[4] || ''} хв.`;
      }

      if (!text || text === 'Питання' || text.includes('Загальна інформація')) return;

      const id       = makeId(config.prefix, text);
      const existing = existingMap.get(id);
      const status   = existing && existing.text === text ? existing.status : 'pending';

      finalRows.push({ id, text, status, chunk_type: config.chunk_type });
    });

    console.log(`  ✓ ${config.name}: ${rows.length} рядків`);
  }

  const pendingCount = finalRows.filter(r => r.status === 'pending').length;
  console.log(`\n  Разом: ${finalRows.length} записів, нових/змінених: ${pendingCount}`);

  // ── ЕТАП 3: Видалення "сиріт" з Pinecone ───────────────────────────────────
  console.log('\n=== ЕТАП 3: Видалення "сиріт" з Pinecone ===');

  const currentIds     = new Set(finalRows.map(r => r.id));
  const allPineconeIds = [];
  let paginationToken  = undefined;

  do {
    const list = await withRetry(() =>
      index.listPaginated({ limit: BATCH_SIZE, paginationToken })
    );
    if (list.vectors) allPineconeIds.push(...list.vectors.map(v => v.id));
    paginationToken = list.pagination?.next;
  } while (paginationToken);

  const idsToDelete = allPineconeIds.filter(id => !currentIds.has(id));

  if (idsToDelete.length > 0) {
    console.log(`  → Знайдено ${idsToDelete.length} застарілих записів, видаляємо...`);
    for (let i = 0; i < idsToDelete.length; i += BATCH_SIZE) {
      await withRetry(() => index.deleteMany(idsToDelete.slice(i, i + BATCH_SIZE)));
    }
    console.log('  ✓ Видалення завершено');
  } else {
    console.log('  ✓ Pinecone чистий, видалень не потрібно');
  }

  // ── ЕТАП 4: Збереження Vector_Data ─────────────────────────────────────────
  console.log('\n=== ЕТАП 4: Збереження Vector_Data ===');
  await vectorSheet.clearRows();
  await vectorSheet.setHeaderRow(['id', 'text', 'status', 'chunk_type']);
  await vectorSheet.addRows(finalRows.map(r => [r.id, r.text, r.status, r.chunk_type]));
  console.log(`  ✓ Записано ${finalRows.length} рядків`);

  // ── ЕТАП 5: Завантаження нових embeddings ──────────────────────────────────
  console.log('\n=== ЕТАП 5: Завантаження embeddings до Pinecone ===');

  const toUpload = finalRows.filter(r => r.status === 'pending');

  if (toUpload.length === 0) {
    console.log('  ✓ Нових записів немає, пропускаю');
  } else {
    const batches = [];
    for (let i = 0; i < toUpload.length; i += BATCH_SIZE) {
      batches.push(toUpload.slice(i, i + BATCH_SIZE));
    }

    let uploaded = 0;
    await pAll(batches, EMBED_CONCURRENCY, async (chunk) => {
      const embRes = await withRetry(() =>
        openai.embeddings.create({
          model: 'text-embedding-3-small',
          input: chunk.map(c => c.text),
        })
      );

      await withRetry(() =>
        index.upsert(
          chunk.map((item, idx) => ({
            id:     item.id,
            values: embRes.data[idx].embedding,
            metadata: { text: item.text, chunk_type: item.chunk_type },
          }))
        )
      );

      uploaded += chunk.length;
      console.log(`  → ${uploaded}/${toUpload.length} завантажено`);
    });

    console.log(`  ✓ Embeddings завантажено: ${toUpload.length} записів`);
  }

  // ── ЕТАП 6: Оновлення статусів у таблиці ───────────────────────────────────
  console.log('\n=== ЕТАП 6: Оновлення статусів ===');
  await vectorSheet.loadCells(`C2:C${finalRows.length + 1}`);
  for (let i = 0; i < finalRows.length; i++) {
    vectorSheet.getCell(i + 1, 2).value = 'uploaded';
  }
  await vectorSheet.saveUpdatedCells();
  console.log('  ✓ Усі статуси → "uploaded"');

  console.log('\n✅ СИНХРОНІЗАЦІЮ ЗАВЕРШЕНО УСПІШНО!');
}

// ─── Entry point ──────────────────────────────────────────────────────────────
sync().catch(err => {
  console.error('\n❌ КРИТИЧНА ПОМИЛКА:', err.message);
  console.error(err.stack);
  process.exit(1);
});
