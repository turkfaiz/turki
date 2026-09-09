import { MAYORS, buildSearchQueries, mayorById } from "./mayors.js";
import { bingNewsRssUrl, googleNewsRssUrl, parseRssItems } from "./rss.js";
import { fingerprint, normalizeTitle } from "./dedup.js";
import { classifyItem } from "./publishers.js";
import { isWithinWeek, toIso } from "./time.js";
import { mapLimit, verifyCandidate } from "./article.js";

const FETCH_HEADERS = {
  "User-Agent": "MayorWatch/0.2 (municipal briefing desk)",
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
  return parseRssItems(xml).slice(0, 8).map((item) => ({ ...item, source: sourceTag, language }));
}

async function collectGoogleNews(query, hl, gl) {
  try {
    const rows = await collectRss(googleNewsRssUrl(query, hl, gl), "google_news", hl);
    if (rows.length) return rows;
  } catch {
    /* bing fallback */
  }
  try {
    return await collectRss(bingNewsRssUrl(query), "google_news", hl);
  } catch {
    return [];
  }
}

function inoreaderEnabled(env) {
  return Boolean(env.INOREADER_APP_ID && env.INOREADER_APP_KEY && env.INOREADER_ACCESS_TOKEN);
}

async function collectInoreader(env, query) {
  if (!inoreaderEnabled(env)) return [];
  const url = `https://www.inoreader.com/reader/api/0/search/stream/0/search?q=${encodeURIComponent(query)}&output=json&num=8`;
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
  return items.slice(0, 8).map((it) => ({
    title: it.title || it.Title || "",
    url: it.canonical?.[0]?.href || it.alternate?.[0]?.href || it.url || "",
    published_at: it.published ? new Date(it.published * 1000).toISOString() : null,
    snippet: (it.summary?.content || it.origin?.title || "").replace(/<[^>]+>/g, " ").trim(),
    source: "inoreader",
    language: "und",
    publisher_name: it.origin?.title || "",
    publisher_url: it.origin?.htmlUrl || it.canonical?.[0]?.href || "",
  }));
}

async function collectGdelt(mayor) {
  const q = encodeURIComponent(`"${mayor.name_en}"`);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=8&timespan=7d&format=json&sort=datedesc`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": FETCH_HEADERS["User-Agent"], Accept: "application/json" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.articles || []).map((art) => ({
      title: art.title || "",
      url: art.url || "",
      published_at: art.seendate || null,
      snippet: art.title || "",
      source: "gdelt",
      language: "und",
      publisher_name: "",
      publisher_url: art.url || "",
    }));
  } catch {
    return [];
  }
}

export function sourceStatus(env) {
  return {
    inoreader: inoreaderEnabled(env) ? "ready" : "unconfigured",
    google_news: "ready",
    official: "ready",
  };
}

function rssLooksFresh(row) {
  if (!row.published_at) return true;
  return isWithinWeek(row.published_at) !== false;
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
    collectGdelt(mayor)
      .then((rows) => buckets.push(...rows))
      .catch((e) => errors.push(`gdelt/${mayor.id}: ${e.message}`)),
  );
  await Promise.all(jobs);
  return { rows: buckets.filter((row) => row.title && row.url && rssLooksFresh(row)), errors, queries: q };
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
    return { scanId, found: 0, duplicates: 0, excluded: 0, skippedStale: 0, skippedUnverified: 0, held: 0, errors: ["mayor_not_found"] };
  }

  let found = 0;
  let duplicates = 0;
  let excluded = 0;
  let skippedStale = 0;
  let skippedUnverified = 0;
  let skippedUnrelated = 0;
  let held = 0;
  const allErrors = [];
  const seen = new Set();

  const gathered = [];
  for (let i = 0; i < targets.length; i += 3) {
    const chunk = targets.slice(i, i + 3);
    const part = await Promise.all(
      chunk.map(async (mayor) => {
        const result = await gatherForMayor(env, mayor, query);
        return { mayor, ...result };
      }),
    );
    gathered.push(...part);
  }

  for (const { mayor, rows, errors } of gathered) {
    allErrors.push(...errors);
    const unique = [];
    const urls = new Set();
    for (const row of rows) {
      const key = `${row.url}|${row.title}`;
      if (urls.has(key)) continue;
      urls.add(key);
      unique.push(row);
    }

    const verified = await mapLimit(unique.slice(0, 12), 3, async (row) => {
      try {
        const preview = classifyItem(row, mayor);
        if (preview.exclude_reason && preview.publisher_tier == null && row.source !== "official") {
          return { skip: "untrusted", row };
        }
        return await verifyCandidate(row, mayor);
      } catch (err) {
        allErrors.push(`${mayor.id}: ${String(err.message || err)}`);
        return { ok: false, reason: "unverified" };
      }
    });

    for (const result of verified) {
      if (result?.skip === "untrusted") {
        excluded += 1;
        continue;
      }
      if (!result?.ok) {
        if (result?.reason === "stale") skippedStale += 1;
        else if (result?.reason === "unrelated") skippedUnrelated += 1;
        else skippedUnverified += 1;
        continue;
      }
      const row = result.row;
      const fp = await fingerprint(mayor.id, row.title, row.url);
      if (seen.has(fp)) {
        duplicates += 1;
        continue;
      }
      seen.add(fp);
      const existing = await env.DB.prepare(`SELECT id, source FROM items WHERE fingerprint = ?`)
        .bind(fp)
        .first();
      if (existing) {
        held += 1;
        if (row.source === "official" && existing.source !== "official") {
          await env.DB.prepare(`UPDATE items SET source = 'official', confidence = 'official' WHERE id = ?`)
            .bind(existing.id)
            .run();
        }
        continue;
      }

      const verdict = classifyItem(row, mayor);
      const id = crypto.randomUUID();
      try {
        await env.DB.prepare(
          `INSERT INTO items (
            id, mayor_id, scan_id, source, title, title_normalized, url, published_at,
            snippet, language, confidence, status, exclude_reason, fingerprint,
            publisher_domain, publisher_tier
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
          .bind(
            id,
            mayor.id,
            scanId,
            row.source,
            row.title.slice(0, 500),
            normalizeTitle(row.title).slice(0, 400),
            row.url.slice(0, 1000),
            toIso(row.published_at),
            (row.snippet || "").slice(0, 800),
            row.language || null,
            verdict.confidence,
            verdict.status,
            verdict.exclude_reason,
            fp,
            verdict.publisher_domain,
            verdict.publisher_tier,
          )
          .run();
        found += 1;
        if (verdict.status === "excluded") excluded += 1;
      } catch (err) {
        if (String(err.message || err).includes("UNIQUE")) held += 1;
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
      allErrors.slice(0, 12).join(" | ") ||
        `stale=${skippedStale};unverified=${skippedUnverified};unrelated=${skippedUnrelated};held=${held}`,
      scanId,
    )
    .run();

  return {
    scanId,
    found,
    duplicates,
    excluded,
    skippedStale,
    skippedUnverified,
    skippedUnrelated,
    held,
    errors: allErrors,
  };
}
