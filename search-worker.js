// Професійна функція генерації Sparse векторів (з фільтром стоп-слів)
function generateSparseVector(text) {
  const words = text.toLowerCase().match(/[\u0400-\u04FF\w]+/g) || [];
  const stopWords = new Set(['на', 'до', 'за', 'від', 'про', 'для', 'що', 'як', 'це', 'та', 'чи', 'по', 'із', 'зі', 'ми', 'ви', 'не', 'або', 'вже', 'все', 'під']);
  const termFrequencies = {};

  words.forEach(word => {
    if (stopWords.has(word) || word.length < 2) return; 

    let hash = 0;
    for (let i = 0; i < word.length; i++) {
      hash = ((hash << 5) - hash) + word.charCodeAt(i);
      hash |= 0;
    }
    const index = Math.abs(hash); 
    const currentFreq = termFrequencies[index] || 0;
    termFrequencies[index] = Math.min(currentFreq + 1, 3);
  });

  const indices = Object.keys(termFrequencies).map(Number);
  const values = Object.values(termFrequencies).map(count => count * 2.0);

  return { indices, values };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") return new Response("Тільки POST запити", { status: 405 });

    try {
      // ❌ ПРИБРАНО ПРИЙОМ ФІЛЬТРА: тепер приймаємо тільки query
      const { query } = await request.json();
      if (!query) return new Response(JSON.stringify({ error: "Запит порожній" }), { status: 400 });

      let queryText = query.replace(/узд/gi, "ультразвукове дослідження");

      // 1. Створення Embedding (Dense Vector від OpenAI)
      const embRes = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ model: "text-embedding-3-small", input: queryText })
      });

      const embData = await embRes.json();
      
      if (!embData.data || !embData.data[0]) {
        return new Response(JSON.stringify({ 
          status: "error", 
          message: "OpenAI Error: " + (embData.error?.message || "Невідома помилка API")
        }), { status: 500 });
      }

      const vector = embData.data[0].embedding;
      
      // 🟢 ГЕНЕРУЄМО SPARSE ВЕКТОР ІЗ ЗАПИТУ ПАЦІЄНТА
      const sparse = generateSparseVector(queryText);

      // 2. Формування payload для Pinecone
      // ❌ ПРИБРАНО ПЕРЕДАЧУ ФІЛЬТРА: шукаємо відразу по всьому
      const pineconePayload = {
        vector: vector,
        sparseVector: sparse, // 🟢 ДОДАНО ДЛЯ ГІБРИДУ
        topK: 15,
        includeMetadata: true
      };

      if (env.PINECONE_NAMESPACE) {
        pineconePayload.namespace = env.PINECONE_NAMESPACE;
      }

      const searchRes = await fetch(`${env.PINECONE_HOST}/query`, {
        method: "POST",
        headers: {
          "Api-Key": env.PINECONE_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(pineconePayload)
      });

      if (!searchRes.ok) {
        const errorText = await searchRes.text();
        return new Response(JSON.stringify({ 
          status: "error", 
          message: "Pinecone Error: " + errorText 
        }), { status: 500 });
      }

      const searchData = await searchRes.json();

      let contextText = "";
      let topScore = 0;
      const matches = searchData.matches || [];
      const threshold = env.SCORE_THRESHOLD ? parseFloat(env.SCORE_THRESHOLD) : 0.30;

      const results = matches
        .filter(match => match.score > threshold)
        .map((match, index) => {
          if (index === 0) topScore = match.score;
          contextText += `[Джерело ${index + 1}]: ${match.metadata.text}\n\n`;
          return {
            score: (match.score * 100).toFixed(1) + "%",
            text: match.metadata.text
          };
        });

      const scoreString = topScore ? (topScore * 100).toFixed(1) + "%" : "0%";

      // 3. Відправка логу у фоновому режимі (❌ прибрали filter з логів)
      if (env.GOOGLE_SCRIPT_LOG_URL) {
        const logPromise = fetch(env.GOOGLE_SCRIPT_LOG_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "log_only",
            query: queryText,
            context: contextText,
            score: scoreString
          })
        }).catch(e => console.error("Log error:", e.message));

        ctx.waitUntil(logPromise);
      }

      // ❌ ПРИБРАНО filter_applied з фінальної відповіді
      return new Response(JSON.stringify({
        status: "success",
        query: queryText,
        found_matches: results.length,
        context_for_ai: contextText.trim(),
        raw_results: results
      }), { headers: { "Content-Type": "application/json" } });

    } catch (error) {
      return new Response(JSON.stringify({ status: "error", message: error.message }), { status: 500 });
    }
  }
};
