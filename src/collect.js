import { MAYORS, buildSearchQueries, mayorById } from "./mayors.js";
import { bingNewsRssUrl, decodeXml, googleNewsRssUrl, parseRssItems } from "./rss.js";
import { fingerprint, normalizeTitle } from "./dedup.js";
import { classifyItem } from "./publishers.js";
import { isWithinWeek, toIso } from "./time.js";
import { mapLimit, verifyCandidate } from "./article.js";
import { pendingAiBrief } from "./aiBrief.js";
import {
  refreshSourceDocuments,
  renderSourceDocuments,
  sourceDocument,
  sourceMetadata,
} from "./sourceDocuments.js";

const FETCH_HEADERS = {
  "User-Agent": "MayorWatch/0.2 (municipal briefing desk)",
  Accept: "application/rss+xml, application/xml, text/xml, */*",
};

export function stampBrief(mayor, _row, status) {
  if (status !== "inbox") {
    return { title_ar: null, snippet_ar: null, trans_engine: null };
  }
  const brief = pendingAiBrief(mayor);
  return {
    title_ar: brief.title_ar,
    snippet_ar: brief.snippet_ar,
    trans_engine: brief.engine,
  };
}

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
  return parseRssItems(xml).slice(0, 50).map((item) => ({ ...item, source: sourceTag, language }));
}

async function collectGoogleNews(query, hl, gl) {
  return collectRss(googleNewsRssUrl(query, hl, gl), "google_news", hl);
}

async function collectBingNews(query, language) {
  return collectRss(bingNewsRssUrl(query), "bing_news", language);
}

export function parseSitemap(xml) {
  const text = String(xml || "");
  const index = /<sitemapindex\b/i.test(text);
  const blockName = index ? "sitemap" : "url";
  const blocks = text.match(new RegExp(`<${blockName}\\b[\\s\\S]*?<\\/${blockName}>`, "gi")) || [];
  const rows = blocks
    .map((block) => {
      const loc = decodeXml((block.match(/<loc[^>]*>([\s\S]*?)<\/loc>/i) || [])[1] || "");
      const lastmod = decodeXml(
        (block.match(/<lastmod[^>]*>([\s\S]*?)<\/lastmod>/i) || [])[1] || "",
      );
      return { loc, lastmod };
    })
    .filter((row) => /^https?:\/\//i.test(row.loc));
  return { index, rows };
}

function sitemapPriority(row) {
  const url = row.loc.toLowerCase();
  const topical = /news|press|media|actual|notic|comunic|article|story/.test(url) ? 0 : 1;
  const recent = Date.parse(row.lastmod || "") || 0;
  return topical * 1e16 - recent;
}

async function collectOfficialSitemap(mayor) {
  if (!mayor.official_host) return [];
  const base = `https://${mayor.official_host}`;
  const sitemapUrls = new Set([`${base}/sitemap.xml`]);
  try {
    const robots = await fetchText(`${base}/robots.txt`, 8000);
    for (const match of robots.matchAll(/^sitemap:\s*(https?:\/\/\S+)/gim)) {
      sitemapUrls.add(match[1].trim());
    }
  } catch {
    /* default sitemap can still work */
  }

  const pages = [];
  let fetchedSitemaps = 0;
  const failures = [];
  for (const sitemapUrl of [...sitemapUrls].slice(0, 3)) {
    try {
      const parsed = parseSitemap(await fetchText(sitemapUrl, 10000));
      fetchedSitemaps += 1;
      if (!parsed.index) {
        pages.push(...parsed.rows);
        continue;
      }
      const children = [...parsed.rows].sort((a, b) => sitemapPriority(a) - sitemapPriority(b));
      for (const child of children.slice(0, 4)) {
        try {
          const nested = parseSitemap(await fetchText(child.loc, 10000));
          fetchedSitemaps += 1;
          if (!nested.index) pages.push(...nested.rows);
        } catch (error) {
          failures.push(String(error.message || error));
        }
      }
    } catch (error) {
      failures.push(String(error.message || error));
    }
  }
  if (!fetchedSitemaps) {
    throw new Error(`sitemap unavailable${failures[0] ? `: ${failures[0]}` : ""}`);
  }

  const seen = new Set();
  return pages
    .filter((row) => row.lastmod && isWithinWeek(row.lastmod) === true)
    .sort((a, b) => Date.parse(b.lastmod) - Date.parse(a.lastmod))
    .filter((row) => {
      if (seen.has(row.loc)) return false;
      seen.add(row.loc);
      return true;
    })
    .slice(0, 30)
    .map((row) => ({
      title: (() => {
        try {
          return (
            decodeURIComponent(new URL(row.loc).pathname)
              .split("/")
              .filter(Boolean)
              .pop()
              ?.replace(/[-_]+/g, " ") || mayor.name_en
          );
        } catch {
          return mayor.name_en;
        }
      })(),
      url: row.loc,
      published_at: row.lastmod,
      date_is_discovery: true,
      snippet: "",
      source: "official",
      language: mayor.native_lang,
      publisher_name: mayor.title_en,
      publisher_url: base,
    }));
}

function inoreaderEnabled(env) {
  return Boolean(env.INOREADER_APP_ID && env.INOREADER_APP_KEY && env.INOREADER_ACCESS_TOKEN);
}

async function collectInoreader(env, query) {
  if (!inoreaderEnabled(env)) return [];
  const url = `https://www.inoreader.com/reader/api/0/search/stream/0/search?q=${encodeURIComponent(query)}&output=json&num=50`;
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
  return items.slice(0, 50).map((it) => ({
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

async function collectGdelt(mayor, extraQuery = "") {
  const names =
    mayor.name_en === mayor.name_native
      ? `"${mayor.name_en}"`
      : `("${mayor.name_en}" OR "${mayor.name_native}")`;
  const extra = String(extraQuery || "").trim().replace(/"/g, " ");
  const q = encodeURIComponent(extra ? `${names} "${extra}"` : names);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=50&timespan=7d&format=json&sort=datedesc`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const res = await fetch(url, {
      headers: { "User-Agent": FETCH_HEADERS["User-Agent"], Accept: "application/json" },
    });
    if (res.status === 429 && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 5500));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.articles || []).map((art) => ({
      title: art.title || "",
      url: art.url || "",
      published_at: art.seendate || null,
      date_is_discovery: true,
      snippet: art.title || "",
      source: "gdelt",
      language: "und",
      publisher_name: "",
      publisher_url: art.url || "",
    }));
  }
  return [];
}

export function sourceStatus(env) {
  return {
    inoreader: inoreaderEnabled(env) ? "ready" : "unconfigured",
    google_news: "ready",
    bing_news: "ready",
    gdelt: "ready",
    official: "ready",
  };
}

function rssLooksFresh(row) {
  if (!row.published_at) return true;
  return isWithinWeek(row.published_at) !== false;
}

async function gatherForMayor(env, mayor, extraQuery, scanType = "manual") {
  const q = buildSearchQueries(mayor, extraQuery);
  const errors = [];
  const buckets = [];
  const manual = scanType === "manual";
  const jobs = [
    ["google_news", collectGoogleNews(q.native, mayor.gn_hl, mayor.gn_gl)],
    ["google_news_en", collectGoogleNews(q.english, "en", "US")],
    ["bing_news", collectBingNews(q.native, mayor.gn_hl)],
  ];
  if (!manual && !String(extraQuery || "").trim()) {
    jobs.unshift(["official_direct", collectOfficialSitemap(mayor)]);
  }
  if (q.official) {
    jobs.push(
      [
        "official",
        collectGoogleNews(q.official, mayor.gn_hl, mayor.gn_gl).then((rows) =>
          rows.map((row) => ({ ...row, source: "official", confidenceHint: "official" })),
        ),
      ],
    );
  }
  jobs.push(["inoreader", collectInoreader(env, q.native)]);
  if (!manual) jobs.push(["gdelt", collectGdelt(mayor, extraQuery)]);
  const settled = await Promise.all(
    jobs.map(async ([label, promise]) => {
      try {
        return { label, rows: await promise };
      } catch (error) {
        return { label, rows: [], error };
      }
    }),
  );
  for (const result of settled) {
    if (result.error) {
      errors.push(`${result.label}/${mayor.id}: ${result.error.message}`);
    } else {
      buckets.push(...result.rows);
    }
  }
  return { rows: buckets.filter((row) => row.title && row.url && rssLooksFresh(row)), errors, queries: q };
}

export async function runScan(env, { type, query = "", mayorId = null }, onProgress = null) {
  const progress = async (stage, detail) => {
    if (onProgress) await onProgress(stage, detail);
  };
  const scanId = crypto.randomUUID();
  const started = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO scans (id, type, query, mayor_id, started_at, found_count, duplicate_count, excluded_count, error_count)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)`,
  )
    .bind(scanId, type, query || null, mayorId, started)
    .run();
  await progress("discovering", "يجمع الإشارات من المصادر المتاحة");

  const targets = mayorId ? [mayorById(mayorId)].filter(Boolean) : MAYORS;
  if (!targets.length) {
    await env.DB.prepare(`UPDATE scans SET finished_at = ?, error_count = 1, notes = ? WHERE id = ?`)
      .bind(new Date().toISOString(), "mayor_not_found", scanId)
      .run();
    return {
      scanId,
      found: 0,
      duplicates: 0,
      excluded: 0,
      skippedStale: 0,
      skippedUnverified: 0,
      skippedUnrelated: 0,
      skippedUntrusted: 0,
      held: 0,
      discovered: 0,
      opened: 0,
      errors: ["mayor_not_found"],
    };
  }

  let found = 0;
  let duplicates = 0;
  let excluded = 0;
  let skippedStale = 0;
  let skippedUnverified = 0;
  let skippedUnrelated = 0;
  let skippedUntrusted = 0;
  let held = 0;
  let discovered = 0;
  let opened = 0;
  const allErrors = [];
  const seen = new Set();

  const gathered = [];
  for (let i = 0; i < targets.length; i += 3) {
    const chunk = targets.slice(i, i + 3);
    const part = await Promise.all(
      chunk.map(async (mayor) => {
        const result = await gatherForMayor(env, mayor, query, type);
        return { mayor, ...result };
      }),
    );
    gathered.push(...part);
  }
  await progress(
    "verifying",
    `اكتشف ${gathered.reduce((sum, result) => sum + result.rows.length, 0)} رابطًا ويبدأ فتح الصفحات`,
  );

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
    discovered += unique.length;

    const verified = await mapLimit(unique, type === "manual" ? 5 : 3, async (row) => {
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
      if (result?.pageRead) opened += 1;
      if (result?.skip === "untrusted") {
        skippedUntrusted += 1;
        continue;
      }
      if (!result?.ok) {
        if (result?.reason === "stale") skippedStale += 1;
        else if (result?.reason === "unrelated") skippedUnrelated += 1;
        else skippedUnverified += 1;
        continue;
      }
      const row = result.row;
      const verdict = classifyItem(row, mayor);
      const fp = await fingerprint(mayor.id, row.title, row.url);
      if (seen.has(fp)) {
        duplicates += 1;
        continue;
      }
      seen.add(fp);
      const existing = await env.DB.prepare(
        `SELECT id, source, status, title, snippet, url, published_at, publisher_domain,
                article_text, merged_sources, source_documents
         FROM items WHERE fingerprint = ?`,
      )
        .bind(fp)
        .first();
      if (existing) {
        held += 1;
        const source =
          row.source === "official" || existing.source === "official" ? "official" : existing.source;
        const refreshed = refreshSourceDocuments(existing, row, verdict.publisher_domain);
        const changed = refreshed.changed ? 1 : 0;
        await env.DB.prepare(
          `UPDATE items
           SET source = ?, title = ?, title_normalized = ?, url = ?, published_at = ?,
               snippet = ?, language = ?, confidence = ?, publisher_domain = ?,
               publisher_tier = ?, article_text = ?, source_documents = ?,
               merged_sources = ?, source_count = ?,
               trans_engine = CASE
                 WHEN status IN ('inbox', 'approved') AND ? = 1
                   THEN 'brief-pending' ELSE trans_engine END,
               brief_evidence = CASE
                 WHEN status IN ('inbox', 'approved') AND ? = 1
                   THEN NULL ELSE brief_evidence END,
               brief_error = CASE
                 WHEN status IN ('inbox', 'approved') AND ? = 1
                   THEN NULL ELSE brief_error END,
               brief_attempted_at = CASE
                 WHEN status IN ('inbox', 'approved') AND ? = 1
                   THEN NULL ELSE brief_attempted_at END
           WHERE id = ?`,
        )
          .bind(
            source,
            row.title.slice(0, 500),
            normalizeTitle(row.title).slice(0, 400),
            row.url.slice(0, 1000),
            toIso(row.published_at),
            (row.snippet || "").slice(0, 1600),
            row.language || null,
            source === "official" ? "official" : verdict.confidence,
            verdict.publisher_domain,
            verdict.publisher_tier,
            refreshed.articleText,
            JSON.stringify(refreshed.documents),
            JSON.stringify(refreshed.metadata),
            refreshed.documents.length,
            changed,
            changed,
            changed,
            changed,
            existing.id,
          )
          .run();
        continue;
      }

      const brief = stampBrief(mayor, row, verdict.status);
      const initialDocuments = [
        sourceDocument(
          { ...row, published_at: toIso(row.published_at) },
          verdict.publisher_domain,
        ),
      ];
      const id = crypto.randomUUID();
      try {
        await env.DB.prepare(
          `INSERT INTO items (
            id, mayor_id, scan_id, source, title, title_normalized, url, published_at,
            snippet, language, confidence, status, exclude_reason, fingerprint,
            publisher_domain, publisher_tier, article_text, source_documents,
            merged_sources, source_count, title_ar, snippet_ar, trans_engine
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
            (row.snippet || "").slice(0, 1600),
            row.language || null,
            verdict.confidence,
            verdict.status,
            verdict.exclude_reason,
            fp,
            verdict.publisher_domain,
            verdict.publisher_tier,
            renderSourceDocuments(initialDocuments),
            JSON.stringify(initialDocuments),
            JSON.stringify(sourceMetadata(initialDocuments)),
            1,
            brief.title_ar,
            brief.snippet_ar,
            brief.trans_engine,
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

  await progress("saving", `قرأ ${opened} صفحة موثوقة ويحفظ النتائج`);
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
        `stale=${skippedStale};unverified=${skippedUnverified};unrelated=${skippedUnrelated};untrusted=${skippedUntrusted};held=${held}`,
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
    skippedUntrusted,
    held,
    discovered,
    opened,
    errors: allErrors,
  };
}
