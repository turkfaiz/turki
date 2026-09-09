import { MAYORS, buildSearchQueries, mayorById, relevanceTokens } from "./mayors.js";
import { googleNewsRssUrl, parseRssItems } from "./rss.js";
import { fingerprint, isRelevant, normalizeTitle, pickConfidence } from "./dedup.js";

const FETCH_HEADERS = {
  "User-Agent": "MayorWatch/0.1 (municipal briefing desk)",
  Accept: "application/rss+xml, application/xml, text/xml, */*",
};

async function fetchText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function collectRss(url, sourceTag, language) {
  const xml = await fetchText(url);
  return parseRssItems(xml).slice(0, 10).map((item) => ({ ...item, source: sourceTag, language }));
}

async function collectGoogleNews(query, hl, gl) {
  try {
    return await collectRss(googleNewsRssUrl(query, hl, gl), "google_news", hl);
  } catch (err) {
    const bing = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss`;
    try {
      return await collectRss(bing, "google_news", hl);
    } catch {
      throw err;
    }
  }
}

function inoreaderEnabled(env) {
  return Boolean(env.INOREADER_APP_ID && env.INOREADER_APP_KEY && env.INOREADER_ACCESS_TOKEN);
}

async function collectInoreader(env, query) {
  if (!inoreaderEnabled(env)) return [];
  const url = `https://www.inoreader.com/reader/api/0/search/stream/0/search?q=${encodeURIComponent(query)}&output=json&num=10`;
  const res = await fetch(url, {
    headers: {
      AppId: env.INOREADER_APP_ID,
      AppKey: env.INOREADER_APP_KEY,
      Authorization: `GoogleLogin auth=${env.INOREADER_ACCESS_TOKEN}`,
    },
  });
  if (!res.ok) throw new Error(`Inoreader HTTP ${res.status}`);
  const data = await res.json();
  const items = data.items || data.Items || [];
  return items.slice(0, 10).map((it) => ({
    title: it.title || it.Title || "",
    url: it.canonical?.[0]?.href || it.alternate?.[0]?.href || it.url || "",
    published_at: it.published ? new Date(it.published * 1000).toISOString() : null,
    snippet: (it.summary?.content || it.origin?.title || "").replace(/<[^>]+>/g, " ").trim(),
    source: "inoreader",
    language: "und",
  }));
}

export function sourceStatus(env) {
  return {
    inoreader: inoreaderEnabled(env) ? "ready" : "unconfigured",
    google_news: "ready",
    official: "ready",
  };
}

async function gatherForMayor(env, mayor, extraQuery) {
  const q = buildSearchQueries(mayor, extraQuery);
  const errors = [];
  const buckets = [];

  const jobs = [
    collectGoogleNews(q.native, mayor.gn_hl, mayor.gn_gl)
      .then((rows) => buckets.push(...rows))
      .catch((e) => errors.push(`google_news/${mayor.id}: ${e.message}`)),
    collectGoogleNews(q.english, "en", "US")
      .then((rows) => buckets.push(...rows))
      .catch((e) => errors.push(`google_news_en/${mayor.id}: ${e.message}`)),
  ];
  if (q.official) {
    jobs.push(
      collectGoogleNews(q.official, mayor.gn_hl, mayor.gn_gl)
        .then((rows) =>
          buckets.push(...rows.map((r) => ({ ...r, source: "official", confidenceHint: "official" }))),
        )
        .catch((e) => errors.push(`official/${mayor.id}: ${e.message}`)),
    );
  }
  jobs.push(
    collectInoreader(env, q.native)
      .then((rows) => buckets.push(...rows))
      .catch((e) => errors.push(`inoreader/${mayor.id}: ${e.message}`)),
  );
  await Promise.all(jobs);
  return { rows: buckets, errors, queries: q };
}

export async function runScan(env, { type, query = "", mayorId = null }) {
  const scanId = crypto.randomUUID();
  const started = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO scans (id, type, query, mayor_id, started_at, found_count, duplicate_count, excluded_count, error_count)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)`,
  )
    .bind(scanId, type, query || null, mayorId, started)
    .run();

  const targets = mayorId ? [mayorById(mayorId)].filter(Boolean) : MAYORS;
  if (!targets.length) {
    await env.DB.prepare(`UPDATE scans SET finished_at = ?, error_count = 1, notes = ? WHERE id = ?`)
      .bind(new Date().toISOString(), "mayor_not_found", scanId)
      .run();
    return { scanId, found: 0, duplicates: 0, excluded: 0, errors: ["mayor_not_found"] };
  }

  let found = 0;
  let duplicates = 0;
  let excluded = 0;
  const allErrors = [];

  const gathered = [];
  for (let i = 0; i < targets.length; i += 3) {
    const chunk = targets.slice(i, i + 3);
    const part = await Promise.all(chunk.map(async (mayor) => {
      const result = await gatherForMayor(env, mayor, query);
      return { mayor, ...result };
    }));
    gathered.push(...part);
  }

  for (const { mayor, rows, errors } of gathered) {
    allErrors.push(...errors);
    const tokens = relevanceTokens(mayor);

    for (const row of rows) {
      if (!row.title || !row.url) continue;
      const fp = await fingerprint(mayor.id, row.title, row.url);
      const existing = await env.DB.prepare(`SELECT id, source FROM items WHERE fingerprint = ?`)
        .bind(fp)
        .first();
      if (existing) {
        duplicates += 1;
        if (row.source === "official" && existing.source !== "official") {
          await env.DB.prepare(`UPDATE items SET source = 'official', confidence = 'official' WHERE id = ?`)
            .bind(existing.id)
            .run();
        }
        continue;
      }

      const text = `${row.title} ${row.snippet || ""}`;
      const relevant = isRelevant(text, tokens);
      const status = relevant ? "inbox" : "excluded";
      const reason = relevant ? null : "غير متعلق بالعمدة المختار";
      const confidence = pickConfidence(row.source, 0);
      const id = crypto.randomUUID();
      try {
        await env.DB.prepare(
          `INSERT INTO items (
            id, mayor_id, scan_id, source, title, title_normalized, url, published_at,
            snippet, language, confidence, status, exclude_reason, fingerprint
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            id,
            mayor.id,
            scanId,
            row.source,
            row.title.slice(0, 500),
            normalizeTitle(row.title).slice(0, 400),
            row.url.slice(0, 1000),
            row.published_at || null,
            (row.snippet || "").slice(0, 800),
            row.language || null,
            confidence,
            status,
            reason,
            fp,
          )
          .run();
        found += 1;
        if (status === "excluded") excluded += 1;
      } catch (err) {
        if (String(err.message || err).includes("UNIQUE")) duplicates += 1;
        else allErrors.push(String(err.message || err));
      }
    }
  }

  await env.DB.prepare(
    `UPDATE scans SET finished_at = ?, found_count = ?, duplicate_count = ?, excluded_count = ?, error_count = ?, notes = ? WHERE id = ?`,
  )
    .bind(
      new Date().toISOString(),
      found,
      duplicates,
      excluded,
      allErrors.length,
      allErrors.slice(0, 12).join(" | ") || null,
      scanId,
    )
    .run();

  return { scanId, found, duplicates, excluded, errors: allErrors };
}
