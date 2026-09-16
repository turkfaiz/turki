import { MAYORS, listMayors, matchesTopic, resolveMayor } from "./mayors.js";
import {
  APPROVED_SOURCES,
  ARTICLE_FETCH_BATCH,
  INLINE_ARTICLE_FETCH_LIMIT,
  isApprovedUrl,
  sourceById,
  sourcesFor,
} from "./sources.js";
import { fingerprint, normalizeTitle } from "./dedup.js";
import { classifyItem } from "./publishers.js";
import { isWithinWeek, parseDate, toIso } from "./time.js";
import { judgeArticle, readArticle } from "./article.js";
import { pendingAiBrief } from "./aiBrief.js";
import {
  refreshSourceDocuments,
  renderSourceDocuments,
  sourceDocument,
  sourceMetadata,
} from "./sourceDocuments.js";
import { discoverSource } from "./discovery.js";
import { STAGES } from "./discovery.js";
import {
  CANDIDATE_FETCH_LEASE_MINUTES,
  claimCandidateFetch,
  completeCandidateFetch,
  pendingCandidateBacklog,
  recoverCandidateAfterException,
} from "./leases.js";

export { STAGES };
export { pendingCandidateBacklog };

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

export async function enabledSources(env, mayorId) {
  const registered = sourcesFor(mayorId);
  if (!env?.DB) return registered;
  const { results } = await env.DB.prepare(
    `SELECT id, enabled FROM sources WHERE mayor_id = ?`,
  )
    .bind(mayorId)
    .all();
  const map = new Map((results || []).map((row) => [row.id, Number(row.enabled) !== 0]));
  return registered.filter((source) => map.get(source.id) !== false);
}

function topicText(row) {
  return [row.title, row.snippet, row.article_text].filter(Boolean).join(" ");
}

export async function persistDiscovered(env, { mayor, source, scanId, rows }) {
  let discovered = 0;
  let inserted = 0;
  const newIds = [];
  for (const row of rows) {
    const url = String(row.url || "").slice(0, 1000);
    if (!url || !isApprovedUrl(url, mayor.id)) continue;
    const dated = parseDate(row.published_at);
    if (dated && isWithinWeek(dated) === false) continue;
    discovered += 1;
    const existing = await env.DB.prepare(
      `SELECT id, fetch_status FROM candidates WHERE source_id = ? AND url = ?`,
    )
      .bind(source.id, url)
      .first();
    if (existing) continue;
    const alreadyItem = await env.DB.prepare(
      `SELECT id FROM items WHERE mayor_id = ? AND url = ?`,
    )
      .bind(mayor.id, url)
      .first();
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO candidates (
         id, mayor_id, source_id, scan_id, url, title, snippet, published_at,
         discovered_at, discovery_type, stage, fetch_status, skip_reason, attempts
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?, ?, ?, ?, 0)`,
    )
      .bind(
        id,
        mayor.id,
        source.id,
        scanId || null,
        url,
        String(row.title || url).slice(0, 500),
        String(row.snippet || "").slice(0, 1600),
        row.published_at || null,
        row.discovery_type || "newsroom",
        alreadyItem ? STAGES.ARTICLE_FETCH : STAGES.CANDIDATE_DISCOVERED,
        alreadyItem ? "skipped" : "pending",
        alreadyItem ? "already_item" : null,
      )
      .run();
    if (!alreadyItem) {
      inserted += 1;
      newIds.push(id);
    }
  }
  return { discovered, inserted, newIds };
}

async function ingestRow(env, mayor, scanId, row, seen) {
  const verdict = classifyItem(row, mayor);
  const fp = await fingerprint(mayor.id, row.title, row.url);
  if (seen.has(fp)) return { kind: "duplicate" };
  seen.add(fp);
  const existing = await env.DB.prepare(
    `SELECT id, source, status, title, snippet, url, published_at, publisher_domain,
            article_text, merged_sources, source_documents
     FROM items WHERE fingerprint = ?`,
  )
    .bind(fp)
    .first();
  if (existing) {
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
    return { kind: "held", changed };
  }

  const brief = stampBrief(mayor, row, verdict.status);
  const initialDocuments = [
    sourceDocument({ ...row, published_at: toIso(row.published_at) }, verdict.publisher_domain),
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
    return { kind: "found", excluded: verdict.status === "excluded" };
  } catch (err) {
    if (String(err.message || err).includes("UNIQUE")) return { kind: "held", changed: 0 };
    throw err;
  }
}

export async function fetchCandidate(env, candidate, extra = {}) {
  const claimed = await claimCandidateFetch(env, candidate.id);
  if (!claimed) return { opened: false, kind: "skipped_claimed" };

  try {
    if (typeof extra.afterClaim === "function") await extra.afterClaim(claimed);
    const mayor = await resolveMayor(env, claimed.mayor_id || candidate.mayor_id);
    if (!mayor) {
      await completeCandidateFetch(env, claimed, {
        fetch_status: "failed",
        skip_reason: "mayor_not_found",
        stage: STAGES.ARTICLE_FETCH,
        last_error: "mayor_not_found",
      });
      return { opened: false, kind: "failed" };
    }

    const article = await readArticle(claimed.url || candidate.url, {
      mayorId: mayor.id,
      fetch: extra.fetch,
      etag: claimed.etag || candidate.etag,
      lastModified: claimed.last_modified || candidate.last_modified,
    });
    if (article?.notModified) {
      await completeCandidateFetch(env, claimed, {
        fetch_status: "skipped",
        skip_reason: "not_modified",
        stage: STAGES.ARTICLE_FETCH,
        http_status: 304,
      });
      return { opened: false, kind: "not_modified" };
    }
    if (!article || article.error) {
      const reason = article?.error || "unverified";
      await completeCandidateFetch(env, claimed, {
        fetch_status: reason === "canonical_outside_registry" ? "skipped" : "failed",
        skip_reason: reason,
        stage: STAGES.ARTICLE_FETCH,
        http_status: article?.httpStatus || null,
        last_error: reason,
      });
      return { opened: false, kind: reason === "canonical_outside_registry" ? "untrusted" : "unverified" };
    }

    const preview = classifyItem({ ...candidate, ...claimed, url: article.url }, mayor);
    if (preview.exclude_reason && preview.publisher_tier == null && candidate.source !== "official") {
      await completeCandidateFetch(env, claimed, {
        fetch_status: "skipped",
        skip_reason: "untrusted",
        stage: STAGES.RELEVANCE_CHECK,
        http_status: article.httpStatus || 200,
      });
      return { opened: true, kind: "untrusted" };
    }

    const judged = judgeArticle(article, mayor, {
      ...candidate,
      ...claimed,
      source: sourceById(claimed.source_id || candidate.source_id)?.tier === 0 ? "official" : "approved_page",
      language: mayor.native_lang,
      publisher_url: article.url,
    });
    if (!judged.ok) {
      await completeCandidateFetch(env, claimed, {
        fetch_status: "skipped",
        skip_reason: judged.reason,
        stage: STAGES.RELEVANCE_CHECK,
        http_status: article.httpStatus || 200,
        etag: article.etag,
        last_modified: article.lastModified,
      });
      await bumpSourceReads(env, claimed.source_id || candidate.source_id, { relevant: false });
      return { opened: true, kind: judged.reason };
    }

    const seen = extra.seen || new Set();
    const ingested = await ingestRow(env, mayor, claimed.scan_id || candidate.scan_id, judged.row, seen);
    await completeCandidateFetch(env, claimed, {
      fetch_status: "fetched",
      skip_reason: ingested.kind === "duplicate" ? "duplicate" : null,
      stage: ingested.kind === "found" ? STAGES.AI_BRIEF : STAGES.DEDUPLICATION,
      http_status: article.httpStatus || 200,
      etag: article.etag,
      last_modified: article.lastModified,
      canonical_url: judged.row.url,
    });
    await bumpSourceReads(env, claimed.source_id || candidate.source_id, {
      relevant: ingested.kind === "found" && !ingested.excluded,
    });
    return { opened: true, kind: ingested.kind, excluded: ingested.excluded, changed: ingested.changed };
  } catch (error) {
    const recovered = await recoverCandidateAfterException(env, claimed, error);
    return { opened: false, kind: recovered.kind };
  }
}

async function bumpSourceReads(env, sourceId, { relevant }) {
  if (!env?.DB || !sourceId) return;
  await env.DB.prepare(
    `UPDATE sources
     SET read_count = IFNULL(read_count, 0) + 1,
         relevant_count = IFNULL(relevant_count, 0) + ?
     WHERE id = ?`,
  )
    .bind(relevant ? 1 : 0, sourceId)
    .run();
}

const CANDIDATE_CLAIMABLE_SQL = `(
  (
    fetch_status IN ('pending', 'retry')
    AND (fetch_after IS NULL OR fetch_after <= datetime('now'))
  ) OR (
    fetch_status = 'working'
    AND (fetch_claimed_at IS NULL OR fetch_claimed_at <= datetime('now', '-${CANDIDATE_FETCH_LEASE_MINUTES} minutes'))
    AND (fetch_after IS NULL OR fetch_after <= datetime('now'))
  )
)`;

export async function fetchCandidateBatch(env, { ids = [], mayorId = null, limit = ARTICLE_FETCH_BATCH, fetch } = {}) {
  let rows = [];
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(", ");
    const result = await env.DB.prepare(
      `SELECT * FROM candidates
       WHERE id IN (${placeholders})
         AND ${CANDIDATE_CLAIMABLE_SQL}`,
    )
      .bind(...ids)
      .all();
    rows = result.results || [];
  } else {
    const result = await env.DB.prepare(
      `SELECT * FROM candidates
       WHERE ${CANDIDATE_CLAIMABLE_SQL}
         AND (? IS NULL OR mayor_id = ?)
       ORDER BY discovered_at
       LIMIT ?`,
    )
      .bind(mayorId, mayorId, limit)
      .all();
    rows = result.results || [];
  }

  const summary = {
    opened: 0,
    found: 0,
    held: 0,
    excluded: 0,
    skippedStale: 0,
    skippedUnrelated: 0,
    skippedUnverified: 0,
    skippedUntrusted: 0,
    duplicates: 0,
    processed: 0,
  };
  const seen = new Set();
  for (const candidate of rows.slice(0, limit)) {
    const result = await fetchCandidate(env, candidate, { fetch, seen });
    summary.processed += 1;
    if (result.opened) summary.opened += 1;
    if (result.kind === "found") {
      summary.found += 1;
      if (result.excluded) summary.excluded += 1;
    } else if (result.kind === "held") summary.held += 1;
    else if (result.kind === "duplicate") summary.duplicates += 1;
    else if (result.kind === "stale") summary.skippedStale += 1;
    else if (result.kind === "unrelated") summary.skippedUnrelated += 1;
    else if (result.kind === "untrusted") summary.skippedUntrusted += 1;
    else if (result.kind === "unverified" || result.kind === "failed") summary.skippedUnverified += 1;
  }
  return summary;
}

export async function pendingCandidateCount(env, mayorId = null, scanId = null) {
  const backlog = await pendingCandidateBacklog(env, mayorId, scanId);
  return backlog.pending;
}

export async function pollOneSource(env, { sourceId, mayorId, scanId = null, query = "", fetch } = {}) {
  const mayor = await resolveMayor(env, mayorId);
  const source = sourceById(sourceId);
  if (!mayor || !source) {
    return {
      health: { id: sourceId, ok: false, status: "bad_url", fail_reason: "unknown_source" },
      inserted: 0,
      newIds: [],
      rows: [],
    };
  }
  let cond = {};
  let condUrl = source.url;
  if (env?.DB) {
    const stored = await env.DB.prepare(
      `SELECT etag, last_modified, url FROM sources WHERE id = ?`,
    )
      .bind(source.id)
      .first();
    if (stored?.etag || stored?.last_modified) {
      cond = { etag: stored.etag || undefined, lastModified: stored.last_modified || undefined };
      condUrl = stored.url || source.url;
    }
  }
  const discovered = await discoverSource(source, mayor, {
    fetch,
    browser: env.BROWSER_RENDER,
    cond,
    condUrl,
  });
  let rows = discovered.rows;
  const topic = String(query || "").trim();
  if (topic) {
    rows = rows.filter((row) => matchesTopic(topicText(row), topic));
  }
  const persisted = env.DB
    ? await persistDiscovered(env, { mayor, source, scanId, rows })
    : { discovered: rows.length, inserted: rows.length, newIds: [] };
  const health = {
    ...discovered.health,
    items: persisted.discovered,
    discovered: persisted.discovered,
    new_count: persisted.inserted,
    skippedTopic: discovered.rows.length - rows.length,
  };
  if (health.ok && persisted.inserted === 0) {
    health.status = health.status === "ok" ? "ok_no_new" : health.status;
  }
  return { ...discovered, health, rows, inserted: persisted.inserted, newIds: persisted.newIds };
}

export function sourceStatus(_env) {
  return {
    registry: "ready",
    approved_sources: APPROVED_SOURCES.length,
    offices: MAYORS.length,
    search_engines: "disabled",
  };
}

async function createScan(env, type, query, mayorId) {
  const scanId = crypto.randomUUID();
  const started = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO scans (id, type, query, mayor_id, started_at, found_count, duplicate_count, excluded_count, error_count)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)`,
  )
    .bind(scanId, type, query || null, mayorId, started)
    .run();
  return scanId;
}

export async function runScan(env, { type, query = "", mayorId = null }, onProgress = null) {
  const progress = async (stage, detail) => {
    if (onProgress) await onProgress(stage, detail);
  };
  const scanId = await createScan(env, type, query, mayorId);
  await progress(STAGES.SOURCE_POLL, "يفحص كل مصدر معتمد على حدة");

  const catalog = await listMayors(env);
  const targets = mayorId ? catalog.filter((row) => row.id === mayorId) : catalog;
  if (!targets.length) {
    await env.DB.prepare(`UPDATE scans SET finished_at = ?, error_count = 1, notes = ? WHERE id = ?`)
      .bind(new Date().toISOString(), "mayor_not_found", scanId)
      .run();
    return emptyScanResult(scanId, ["mayor_not_found"]);
  }

  const sourceHealth = [];
  const allErrors = [];
  const newIds = [];
  let discovered = 0;
  let skippedTopic = 0;

  for (const mayor of targets) {
    const sources = await enabledSources(env, mayor.id);
    for (const source of sources) {
      try {
        const polled = await pollOneSource(env, {
          sourceId: source.id,
          mayorId: mayor.id,
          scanId,
          query,
        });
        sourceHealth.push({ ...polled.health, mayor_id: mayor.id });
        discovered += Number(polled.health.discovered) || 0;
        skippedTopic += Number(polled.health.skippedTopic) || 0;
        newIds.push(...(polled.newIds || []));
        if (!polled.health.ok) {
          allErrors.push(`${source.id}: ${polled.health.status}`);
        }
      } catch (error) {
        allErrors.push(`${source.id}: ${String(error.message || error)}`);
        sourceHealth.push({
          id: source.id,
          mayor_id: mayor.id,
          ok: false,
          status: String(error.message || error).slice(0, 120),
          items: 0,
        });
      }
    }
  }

  await progress(STAGES.ARTICLE_FETCH, `يحفظ الروابط المكتشفة ويفتح الدفعة الأولى`);
  const fetched = await fetchCandidateBatch(env, {
    ids: newIds.slice(0, INLINE_ARTICLE_FETCH_LIMIT),
    limit: INLINE_ARTICLE_FETCH_LIMIT,
  });

  await env.DB.prepare(
    `UPDATE scans SET finished_at = ?, found_count = ?, duplicate_count = ?, excluded_count = ?, error_count = ?, notes = ? WHERE id = ?`,
  )
    .bind(
      new Date().toISOString(),
      fetched.found,
      fetched.duplicates,
      fetched.excluded,
      allErrors.length,
      allErrors.slice(0, 12).join(" | ") ||
        `stale=${fetched.skippedStale};unverified=${fetched.skippedUnverified};unrelated=${fetched.skippedUnrelated};untrusted=${fetched.skippedUntrusted};held=${fetched.held}`,
      scanId,
    )
    .run();

  return {
    scanId,
    found: fetched.found,
    duplicates: fetched.duplicates,
    excluded: fetched.excluded,
    skippedStale: fetched.skippedStale,
    skippedUnverified: fetched.skippedUnverified,
    skippedUnrelated: fetched.skippedUnrelated,
    skippedUntrusted: fetched.skippedUntrusted,
    held: fetched.held,
    updated: 0,
    discovered,
    opened: fetched.opened,
    skippedTopic,
    pendingCandidates: await pendingCandidateCount(env, mayorId, scanId),
    errors: allErrors,
    sourceHealth,
  };
}

function emptyScanResult(scanId, errors) {
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
    errors,
    sourceHealth: [],
  };
}

export async function pendingFetchIds(env, { mayorId, scanId, limit = ARTICLE_FETCH_BATCH } = {}) {
  const backlog = await pendingCandidateBacklog(env, mayorId || null, scanId || null, { limit });
  return backlog.ids;
}
