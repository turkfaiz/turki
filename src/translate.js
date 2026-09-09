function hasArabic(text) {
  return /[\u0600-\u06FF]/.test(String(text || ""));
}

function arabicRatio(text) {
  const chars = String(text || "").replace(/\s/g, "");
  if (!chars.length) return 0;
  const ar = (chars.match(/[\u0600-\u06FF]/g) || []).length;
  return ar / chars.length;
}

async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function translateGtx(text) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ar&dt=t&q=${encodeURIComponent(text)}`;
  const data = await fetchJson(url);
  return (data?.[0] || []).map((part) => part?.[0] || "").join("").trim();
}

async function translateMyMemory(text) {
  const url = `https://api.mymemory.translated.net/get?langpair=autodetect|ar&q=${encodeURIComponent(text)}`;
  const data = await fetchJson(url);
  return String(data?.responseData?.translatedText || "").trim();
}

export async function translateToAr(text) {
  const input = String(text || "").replace(/\s+/g, " ").trim().slice(0, 900);
  if (!input) return "";
  if (arabicRatio(input) >= 0.45) return input;
  try {
    const out = await translateGtx(input);
    if (out) return out;
  } catch {
    /* fall through */
  }
  try {
    return (await translateMyMemory(input)) || "";
  } catch {
    return "";
  }
}

export { hasArabic, arabicRatio };

export async function translatePending(env, limit = 30) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, snippet FROM items
     WHERE title_ar IS NULL OR title_ar = ''
     ORDER BY created_at DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all();
  const rows = results || [];
  const queue = [...rows];
  async function pump() {
    while (queue.length) {
      const row = queue.shift();
      const titleAr = await translateToAr(row.title);
      const snippetAr = await translateToAr(row.snippet || "");
      await env.DB.prepare(`UPDATE items SET title_ar = ?, snippet_ar = ? WHERE id = ?`)
        .bind(titleAr || row.title, snippetAr || row.snippet || "", row.id)
        .run();
    }
  }
  await Promise.all([pump(), pump(), pump()]);
  return rows.length;
}
