import { MAYORS, buildSearchQueries, isAboutMayor, mayorById } from "./mayors.js";
import { APPROVED_SOURCES, isApprovedUrl, sourcesFor } from "./sources.js";
import { decodeXml, parseRssItems } from "./rss.js";
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

const ARTICLE_LINK_LIMIT = 40;
const NON_ARTICLE_PATH =
  /\.(?:jpe?g|png|gif|svg|webp|pdf|zip|docx?|xlsx?|mp[34]|css|js)$/i;
const NAV_PATH =
  /\/(?:tag|tags|category|categories|author|autor|search|login|register|contact|privacy|cookie|terms|feed|rss|sitemap|page)\//i;
/** علامات نشرية بلغات المكاتب: عربية وإنجليزية وإيطالية وإسبانية ويونانية وألبانية ويابانية. */
const NEWSROOM_PATH =
  /news|notiz|notic|actual|article|story|press|media|comunic|akhbar|khabar|lajme|hodo|happyo|nea|eidisi|\/20\d{2}\//i;

/**
 * يستخرج روابط المقالات من صفحة أخبار الموقع نفسه. الاستخراج محصور في النطاق
 * المعتمد ذاته، فلا تتسع قائمة المصادر ضمنًا عبر روابط خارجة.
 */
export function extractArticleLinks(html, baseUrl) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return [];
  }
  const host = base.hostname.replace(/^www\./i, "").toLowerCase();
  /** مقالات غرفة الأخبار تسكن مجلدها، فمن خرج عنه يحتاج علامة نشرية صريحة. */
  const newsroomDir = base.pathname.replace(/[^/]*$/, "");
  const found = new Map();
  for (const tag of String(html || "").match(/<a\b[^>]*href\s*=\s*["'][^"']+["'][^>]*>/gi) || []) {
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href || /^(?:#|mailto:|tel:|javascript:)/i.test(href)) continue;
    let url;
    try {
      url = new URL(decodeXml(href), base);
    } catch {
      continue;
    }
    if (!/^https?:$/i.test(url.protocol)) continue;
    const linkHost = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (linkHost !== host && !linkHost.endsWith(`.${host}`)) continue;
    url.hash = "";
    const path = url.pathname;
    if (path === "/" || NON_ARTICLE_PATH.test(path) || NAV_PATH.test(path)) continue;
    const segments = path.split("/").filter(Boolean);
    const inNewsroom = newsroomDir.length > 1 && path.startsWith(newsroomDir);
    if (!inNewsroom && !NEWSROOM_PATH.test(path)) continue;
    const looksLikeArticle =
      segments.length >= 2 ||
      /\d{4,}/.test(url.search + path) ||
      /-.*-/.test(segments.at(-1) || "");
    if (!looksLikeArticle) continue;
    const key = url.toString();
    if (found.has(key)) continue;
    const text = tag.match(/>([^<]{6,})$/)?.[1];
    found.set(key, decodeXml(text || "").trim());
    if (found.size >= ARTICLE_LINK_LIMIT) break;
  }
  return [...found.entries()].map(([url, title]) => ({ url, title }));
}

async function collectApprovedPage(source, mayor) {
  const html = await fetchText(source.url, 15000);
  return extractArticleLinks(html, source.url).map((link) => ({
    title: link.title || link.url,
    url: link.url,
    snippet: "",
    published_at: "",
    source: source.tier === 0 ? "official" : "approved_page",
    language: mayor.native_lang,
    publisher_url: link.url,
    registry_id: source.id,
  }));
}

async function collectApprovedFeed(source, mayor) {
  const rows = await collectRss(
    source.url,
    source.tier === 0 ? "official" : "approved_feed",
    mayor.native_lang,
  );
  return rows.map((row) => ({ ...row, publisher_url: row.url, registry_id: source.id }));
}

/**
 * الرصد من سجل المصادر المعتمدة فقط. كل مصدر يُحاول على حدة وتُسجَّل صحته،
 * فتعطُّل مصدر لا يوقف المكتب ويظهر للمستخدم بدل أن يُخفى.
 */
export async function collectApprovedSources(mayor) {
  const sources = sourcesFor(mayor.id);
  if (!sources.length) return { rows: [], health: [] };
  const settled = await Promise.all(
    sources.map(async (source) => {
      const startedAt = Date.now();
      try {
        const rows =
          source.kind === "page"
            ? await collectApprovedPage(source, mayor)
            : await collectApprovedFeed(source, mayor);
        return {
          source,
          rows,
          health: {
            id: source.id,
            ok: rows.length > 0,
            status: rows.length ? "ok" : "empty",
            items: rows.length,
            ms: Date.now() - startedAt,
          },
        };
      } catch (error) {
        return {
          source,
          rows: [],
          health: {
            id: source.id,
            ok: false,
            status: String(error?.message || error).slice(0, 120),
            items: 0,
            ms: Date.now() - startedAt,
          },
        };
      }
    }),
  );
  const rows = settled
    .flatMap((entry) => entry.rows)
    .filter((row) => row.url && isApprovedUrl(row.url, mayor.id));
  return { rows, health: settled.map((entry) => entry.health) };
}

export function sourceStatus(_env) {
  return {
    registry: "ready",
    approved_sources: APPROVED_SOURCES.length,
    offices: MAYORS.length,
    search_engines: "disabled",
  };
}

function rssLooksFresh(row) {
  if (!row.published_at) return true;
  return isWithinWeek(row.published_at) !== false;
}

async function gatherForMayor(_env, mayor, extraQuery) {
  const q = buildSearchQueries(mayor, extraQuery);
  const { rows, health } = await collectApprovedSources(mayor);
  const errors = health
    .filter((entry) => !entry.ok)
    .map((entry) => `${entry.id}: ${entry.status}`);
  return {
    rows: rows.filter((row) => row.title && row.url && rssLooksFresh(row)),
    errors,
    health,
    queries: q,
  };
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
      updated: 0,
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
  let updated = 0;
  let discovered = 0;
  let opened = 0;
  const allErrors = [];
  const sourceHealth = [];
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

  for (const { mayor, rows, errors, health } of gathered) {
    allErrors.push(...errors);
    sourceHealth.push(...(health || []).map((entry) => ({ ...entry, mayor_id: mayor.id })));
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
        if (changed) updated += 1;
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
    updated,
    discovered,
    opened,
    errors: allErrors,
    sourceHealth,
  };
}
