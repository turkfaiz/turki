const MOZHI_HOSTS = [
  "https://mozhi.aryak.me",
  "https://translate.projectsegfau.lt",
  "https://mozhi.ducks.party",
  "https://mozhi.pussthecat.org",
];

export function arabicRatio(text) {
  const chars = String(text || "").replace(/\s/g, "");
  if (!chars.length) return 0;
  return (chars.match(/[\u0600-\u06FF]/g) || []).length / chars.length;
}

export function splitHeadline(title) {
  const raw = decodeEntities(String(title || "")).replace(/\s+/g, " ").trim();
  const m = raw.match(/^(.*)\s+[-–—|]\s+(.{2,48})$/);
  if (m && !/https?:/i.test(m[2])) {
    return { headline: m[1].trim(), outlet: m[2].trim() };
  }
  return { headline: raw, outlet: "" };
}

export function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchJson(url, options = {}, timeoutMs = 14000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function translateDeepL(text, env) {
  const key = env?.DEEPL_API_KEY;
  if (!key) return "";
  const endpoint = key.endsWith(":fx")
    ? "https://api-free.deepl.com/v2/translate"
    : "https://api.deepl.com/v2/translate";
  const body = new URLSearchParams({ text, target_lang: "AR" });
  const data = await fetchJson(endpoint, {
    method: "POST",
    headers: { Authorization: `DeepL-Auth-Key ${key}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return String(data?.translations?.[0]?.text || "").trim();
}

async function translateYandex(text) {
  const q = new URLSearchParams({
    engine: "yandex",
    from: "auto",
    to: "ar",
    text,
  });
  let lastErr = null;
  for (const host of MOZHI_HOSTS) {
    try {
      const data = await fetchJson(`${host}/api/translate?${q.toString()}`, {
        headers: { Accept: "application/json" },
      }, 12000);
      const out = String(data?.["translated-text"] || data?.translated_text || "").trim();
      if (out) return out;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return "";
}

export async function translateToAr(text, env) {
  const { headline } = splitHeadline(text);
  const input = headline.slice(0, 850);
  if (!input) return { text: "", engine: "empty" };
  if (arabicRatio(input) >= 0.45) return { text: input, engine: "original" };
  try {
    const deepl = await translateDeepL(input, env);
    if (deepl && arabicRatio(deepl) >= 0.35) return { text: deepl, engine: "deepl" };
  } catch {
    /* optional key */
  }
  const yandex = await translateYandex(input);
  return { text: yandex, engine: yandex ? "yandex" : "failed" };
}

export async function translatePending(env, limit = 24) {
  const { results } = await env.DB.prepare(
    `SELECT id, title, snippet FROM items
     WHERE trans_engine IS NULL OR trans_engine NOT IN ('yandex', 'deepl', 'original')
     ORDER BY COALESCE(published_at, created_at) DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all();
  const rows = results || [];
  const queue = [...rows];
  async function pump() {
    while (queue.length) {
      const row = queue.shift();
      let titleRes = { text: "", engine: "failed" };
      let snippetAr = "";
      try {
        titleRes = await translateToAr(row.title, env);
        const snip = decodeEntities(row.snippet || "").slice(0, 280);
        if (snip && snip.length >= 40 && snip !== titleRes.text) {
          const sn = await translateToAr(snip, env);
          snippetAr = sn.text;
        }
      } catch {
        titleRes = { text: splitHeadline(row.title).headline, engine: "failed" };
        snippetAr = decodeEntities(row.snippet || "");
      }
      await env.DB.prepare(
        `UPDATE items SET title_ar = ?, snippet_ar = ?, trans_engine = ? WHERE id = ?`,
      )
        .bind(titleRes.text || "", snippetAr || "", titleRes.engine, row.id)
        .run();
    }
  }
  await Promise.all([pump(), pump(), pump(), pump(), pump()]);
  return rows.length;
}
