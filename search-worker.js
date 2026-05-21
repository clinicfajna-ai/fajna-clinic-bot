export default {
async fetch(request, env, ctx) {
if (request.method !== "POST") return new Response("Тільки POST запити", { status: 405 });

try {
  // Додали прийом об'єкта filter із запиту
  const { query, filter } = await request.json();
  if (!query) return new Response(JSON.stringify({ error: "Запит порожній" }), { status: 400 });

  let queryText = query.replace(/узд/gi, "ультразвукове дослідження");

  // 1. Створення Embedding
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

  // 2. Формування payload для Pinecone
  const pineconePayload = {
    vector: vector,
    topK: 15,
    includeMetadata: true
  };

  // Якщо передано фільтр у запиті від бота, додаємо його в Pinecone payload
  if (filter && typeof filter === 'object' && Object.keys(filter).length > 0) {
    pineconePayload.filter = filter;
  }

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

  // 3. Відправка логу у фоновому режимі
  if (env.GOOGLE_SCRIPT_LOG_URL) {
    const logPromise = fetch(env.GOOGLE_SCRIPT_LOG_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "log_only",
        query: queryText,
        filter: filter, // <-- Обов'язково додай цей рядок сюди
        context: contextText,
        score: scoreString
      })
    }).catch(e => console.error("Log error:", e.message));

    ctx.waitUntil(logPromise);
  }

  return new Response(JSON.stringify({
    status: "success",
    query: queryText,
    filter_applied: filter || "none",
    found_matches: results.length,
    context_for_ai: contextText.trim(),
    raw_results: results
  }), { headers: { "Content-Type": "application/json" } });

} catch (error) {
  return new Response(JSON.stringify({ status: "error", message: error.message }), { status: 500 });
}
}
};
