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
  completeCandidateFetchStatement,
  completeSourcePollStatement,
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

function filterDiscoveredRows(mayor, rows) {
  const out = [];
  for (const row of rows || []) {
    const url = String(row.url || "").slice(0, 1000);
    if (!url || !isApprovedUrl(url, mayor.id)) continue;
    const dated = parseDate(row.published_at);
    if (dated && isWithinWeek(dated) === false) continue;
    out.push({
      id: crypto.randomUUID(),
      mayor_id: mayor.id,
      source_id: null,
      scan_id: null,
      url,
      title: String(row.title || url).slice(0, 500),
      snippet: String(row.snippet || "").slice(0, 1600),
      published_at: row.published_at || null,
      discovery_type: row.discovery_type || "newsroom",
    });
  }
  return out;
}

function insertDiscoveredStatement(env, { mayor, source, scanId, payload, claimed = null }) {
  return env.DB.prepare(
    `INSERT INTO candidates (
       id, mayor_id, source_id, scan_id, url, title, snippet, published_at,
       discovered_at, discovery_type, stage, fetch_status, skip_reason, attempts
     )
     SELECT
       json_extract(j.value, '$.id'),
       json_extract(j.value, '$.mayor_id'),
       ?,
       ?,
       json_extract(j.value, '$.url'),
       json_extract(j.value, '$.title'),
       json_extract(j.value, '$.snippet'),
       json_extract(j.value, '$.published_at'),
       datetime('now'),
       json_extract(j.value, '$.discovery_type'),
       CASE WHEN EXISTS (
         SELECT 1 FROM items
         WHERE mayor_id = json_extract(j.value, '$.mayor_id')
           AND url = json_extract(j.value, '$.url')
       ) THEN ? ELSE ? END,
       CASE WHEN EXISTS (
         SELECT 1 FROM items
         WHERE mayor_id = json_extract(j.value, '$.mayor_id')
           AND url = json_extract(j.value, '$.url')
       ) THEN 'skipped' ELSE 'pending' END,
       CASE WHEN EXISTS (
         SELECT 1 FROM items
         WHERE mayor_id = json_extract(j.value, '$.mayor_id')
           AND url = json_extract(j.value, '$.url')
       ) THEN 'already_item' ELSE NULL END,
       0
     FROM json_each(?) AS j
     WHERE (? IS NULL OR EXISTS (
       SELECT 1 FROM scan_sources
       WHERE scan_id = ? AND source_id = ? AND claim_id = ?
     ))
       AND NOT EXISTS (
         SELECT 1 FROM candidates
         WHERE source_id = ? AND url = json_extract(j.value, '$.url')
       )`,
  ).bind(
    source.id,
    scanId || null,
    STAGES.ARTICLE_FETCH,
    STAGES.CANDIDATE_DISCOVERED,
    payload,
    claimed?.claim_id || null,
    claimed?.scan_id || scanId || null,
    claimed?.source_id || source.id,
    claimed?.claim_id || null,
    source.id,
  );
}

export async function persistDiscovered(env, { mayor, source, scanId, rows, claimed = null }) {
  const filtered = filterDiscoveredRows(mayor, rows).map((row) => ({
    ...row,
    source_id: source.id,
    scan_id: scanId || null,
  }));
  if (!filtered.length) return { discovered: 0, inserted: 0, newIds: [] };
  await insertDiscoveredStatement(env, {
    mayor,
    source,
    scanId,
    payload: JSON.stringify(filtered),
    claimed,
  }).run();
  const placeholders = filtered.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT id FROM candidates
     WHERE id IN (${placeholders}) AND fetch_status = 'pending'`,
  )
    .bind(...filtered.map((row) => row.id))
    .all();
  const newIds = (results || []).map((row) => row.id);
  return { discovered: filtered.length, inserted: newIds.length, newIds };
}

function claimConditionedSourceHealthStatement(env, row, claimed, plannedIds = []) {
  const ok = Boolean(row?.ok);
  const discovered = Number(row?.discovered ?? row?.items) || 0;
  const idList = plannedIds.length ? plannedIds.map(() => "?").join(", ") : null;
  const newCountExpr = idList
    ? `(SELECT COUNT(*) FROM candidates WHERE id IN (${idList}) AND fetch_status = 'pending')`
    : "0";
  return env.DB.prepare(
    `UPDATE sources
     SET last_checked_at = datetime('now'),
         last_ok_at = CASE WHEN ? THEN datetime('now') ELSE last_ok_at END,
         last_success_at = CASE WHEN ? THEN datetime('now') ELSE last_success_at END,
         last_discovery_at = CASE WHEN ? > 0 THEN datetime('now') ELSE last_discovery_at END,
         last_fresh_at = CASE WHEN ${newCountExpr} > 0 THEN datetime('now') ELSE last_fresh_at END,
         last_status = ?, last_items = ?,
         connect_status = ?, http_status = ?, parse_status = ?,
         discovered_count = ?, new_count = ${newCountExpr},
         fail_reason = ?, last_strategy = ?, last_discovered_url = ?,
         etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
         consecutive_failures = CASE WHEN ? THEN 0 ELSE IFNULL(consecutive_failures, 0) + 1 END
     WHERE id = ?
       AND EXISTS (
         SELECT 1 FROM scan_sources
         WHERE scan_id = ? AND source_id = ? AND claim_id = ?
       )`,
  ).bind(
    ok ? 1 : 0,
    ok ? 1 : 0,
    discovered,
    ...(plannedIds.length ? plannedIds : []),
    String(row?.status || "").slice(0, 160),
    Number(row?.items) || 0,
    String(row?.connect_status || row?.status || "").slice(0, 80),
    row?.http_status ?? null,
    String(row?.parse_status || "").slice(0, 80),
    discovered,
    ...(plannedIds.length ? plannedIds : []),
    String(row?.fail_reason || "").slice(0, 160),
    String(row?.last_strategy || "").slice(0, 40),
    String(row?.last_discovered_url || "").slice(0, 500),
    row?.etag || null,
    row?.last_modified || null,
    ok ? 1 : 0,
    row?.id,
    claimed.scan_id,
    claimed.source_id,
    claimed.claim_id,
  );
}

function deferSourcePollStatement(env, claimed, { lastError, detail, delaySeconds }) {
  return env.DB.prepare(
    `UPDATE scan_sources
     SET status = 'retrying',
         detail = ?,
         last_error = ?,
         next_attempt_at = datetime('now', ?),
         claim_id = NULL,
         claimed_at = NULL
     WHERE scan_id = ? AND source_id = ? AND claim_id = ?`,
  ).bind(
    String(detail || "تعذر مؤقتًا وستعاد المحاولة").slice(0, 160),
    lastError ? String(lastError).slice(0, 300) : null,
    `+${delaySeconds} seconds`,
    claimed.scan_id,
    claimed.source_id,
    claimed.claim_id,
  );
}

/**
 * جلسة واحدة: إدراج المرشحين وتحديث الصحة وإغلاق المصدر، كلها مشروطة بالملكية.
 * لا كتابة غير مشروطة بعد SELECT.
 */
export async function persistSourcePollOutcome(env, claimed, { mayor, source, scanId, rows = [], health, completion }) {
  if (!claimed?.claim_id || !env?.DB) return { wrote: false, discovered: 0, inserted: 0, newIds: [] };
  const filtered =
    completion?.status === "polled" && mayor && source
      ? filterDiscoveredRows(mayor, rows).map((row) => ({
          ...row,
          source_id: source.id,
          scan_id: scanId || claimed.scan_id || null,
        }))
      : [];
  const statements = [];
  if (filtered.length) {
    statements.push(
      insertDiscoveredStatement(env, {
        mayor,
        source,
        scanId: scanId || claimed.scan_id,
        payload: JSON.stringify(filtered),
        claimed,
      }),
    );
  }
  const healthRow = {
    ...health,
    id: claimed.source_id || source?.id,
    items: filtered.length,
    discovered: filtered.length,
  };
  const plannedIds = filtered.map((row) => row.id);
  statements.push(claimConditionedSourceHealthStatement(env, healthRow, claimed, plannedIds));
  if (completion?.status === "retrying") {
    statements.push(
      deferSourcePollStatement(env, claimed, {
        lastError: completion.lastError,
        detail: completion.detail,
        delaySeconds: completion.delaySeconds || 20,
      }),
    );
  } else {
    statements.push(
      completeSourcePollStatement(env, claimed, {
        status: completion.status,
        detail: completion.detail,
        lastError: completion.lastError || null,
        nextAttemptAt: null,
      }),
    );
  }
  const results = await env.DB.batch(statements);
  const wrote = Number(results[results.length - 1]?.meta?.changes) > 0;
  if (!wrote || !filtered.length) {
    return { wrote, discovered: filtered.length, inserted: 0, newIds: [] };
  }
  const placeholders = filtered.map(() => "?").join(", ");
  const { results: created } = await env.DB.prepare(
    `SELECT id FROM candidates
     WHERE id IN (${placeholders}) AND fetch_status = 'pending'`,
  )
    .bind(...filtered.map((row) => row.id))
    .all();
  const newIds = (created || []).map((row) => row.id);
  return { wrote, discovered: filtered.length, inserted: newIds.length, newIds };
}

async function planIngest(env, mayor, scanId, row, seen) {
  const verdict = classifyItem(row, mayor);
  const fp = await fingerprint(mayor.id, row.title, row.url);
  if (seen.has(fp)) return { kind: "duplicate", fingerprint: fp };
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
    return {
      kind: "held",
      changed,
      existingId: existing.id,
      fingerprint: fp,
      update: {
        source,
        title: row.title.slice(0, 500),
        titleNormalized: normalizeTitle(row.title).slice(0, 400),
        url: row.url.slice(0, 1000),
        publishedAt: toIso(row.published_at),
        snippet: (row.snippet || "").slice(0, 1600),
        language: row.language || null,
        confidence: source === "official" ? "official" : verdict.confidence,
        publisherDomain: verdict.publisher_domain,
        publisherTier: verdict.publisher_tier,
        articleText: refreshed.articleText,
        documents: JSON.stringify(refreshed.documents),
        metadata: JSON.stringify(refreshed.metadata),
        sourceCount: refreshed.documents.length,
        changed,
      },
    };
  }

  const brief = stampBrief(mayor, row, verdict.status);
  const initialDocuments = [
    sourceDocument({ ...row, published_at: toIso(row.published_at) }, verdict.publisher_domain),
  ];
  return {
    kind: "found",
    excluded: verdict.status === "excluded",
    fingerprint: fp,
    insert: {
      id: crypto.randomUUID(),
      mayorId: mayor.id,
      scanId,
      source: row.source,
      title: row.title.slice(0, 500),
      titleNormalized: normalizeTitle(row.title).slice(0, 400),
      url: row.url.slice(0, 1000),
      publishedAt: toIso(row.published_at),
      snippet: (row.snippet || "").slice(0, 1600),
      language: row.language || null,
      confidence: verdict.confidence,
      status: verdict.status,
      excludeReason: verdict.exclude_reason,
      fingerprint: fp,
      publisherDomain: verdict.publisher_domain,
      publisherTier: verdict.publisher_tier,
      articleText: renderSourceDocuments(initialDocuments),
      documents: JSON.stringify(initialDocuments),
      metadata: JSON.stringify(sourceMetadata(initialDocuments)),
      titleAr: brief.title_ar,
      snippetAr: brief.snippet_ar,
      transEngine: brief.trans_engine,
    },
  };
}

function bumpSourceReadsStatement(env, sourceId, relevant, claimed) {
  return env.DB.prepare(
    `UPDATE sources
     SET read_count = IFNULL(read_count, 0) + 1,
         relevant_count = IFNULL(relevant_count, 0) + ?
     WHERE id = ?
       AND EXISTS (
         SELECT 1 FROM candidates
         WHERE id = ? AND fetch_claim_id = ?
       )`,
  ).bind(relevant ? 1 : 0, sourceId, claimed.id, claimed.fetch_claim_id);
}

function itemInsertStatement(env, insert, claimed) {
  return env.DB.prepare(
    `INSERT INTO items (
        id, mayor_id, scan_id, source, title, title_normalized, url, published_at,
        snippet, language, confidence, status, exclude_reason, fingerprint,
        publisher_domain, publisher_tier, article_text, source_documents,
        merged_sources, source_count, title_ar, snippet_ar, trans_engine
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM candidates WHERE id = ? AND fetch_claim_id = ?
      )
        AND NOT EXISTS (SELECT 1 FROM items WHERE fingerprint = ?)`,
  ).bind(
    insert.id,
    insert.mayorId,
    insert.scanId,
    insert.source,
    insert.title,
    insert.titleNormalized,
    insert.url,
    insert.publishedAt,
    insert.snippet,
    insert.language,
    insert.confidence,
    insert.status,
    insert.excludeReason,
    insert.fingerprint,
    insert.publisherDomain,
    insert.publisherTier,
    insert.articleText,
    insert.documents,
    insert.metadata,
    1,
    insert.titleAr,
    insert.snippetAr,
    insert.transEngine,
    claimed.id,
    claimed.fetch_claim_id,
    insert.fingerprint,
  );
}

function itemUpdateStatement(env, existingId, update, claimed) {
  return env.DB.prepare(
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
     WHERE id = ?
       AND EXISTS (
         SELECT 1 FROM candidates WHERE id = ? AND fetch_claim_id = ?
       )`,
  ).bind(
    update.source,
    update.title,
    update.titleNormalized,
    update.url,
    update.publishedAt,
    update.snippet,
    update.language,
    update.confidence,
    update.publisherDomain,
    update.publisherTier,
    update.articleText,
    update.documents,
    update.metadata,
    update.sourceCount,
    update.changed,
    update.changed,
    update.changed,
    update.changed,
    existingId,
    claimed.id,
    claimed.fetch_claim_id,
  );
}

async function persistCandidateFetchOutcome(env, claimed, { complete, item = null, bump = null }) {
  const statements = [];
  if (item?.insert) statements.push(itemInsertStatement(env, item.insert, claimed));
  if (item?.update) statements.push(itemUpdateStatement(env, item.existingId, item.update, claimed));
  if (bump?.sourceId) {
    statements.push(bumpSourceReadsStatement(env, bump.sourceId, bump.relevant, claimed));
  }
  statements.push(completeCandidateFetchStatement(env, claimed, complete));
  const results = await env.DB.batch(statements);
  const wrote = Number(results[results.length - 1]?.meta?.changes) > 0;
  const itemChanges = item ? Number(results[0]?.meta?.changes) || 0 : 0;
  return { wrote, itemChanges };
}

async function finishCandidate(env, claimed, fields, extra = {}) {
  const { wrote } = extra.bump || extra.item
    ? await persistCandidateFetchOutcome(env, claimed, {
        complete: fields,
        item: extra.item || null,
        bump: extra.bump || null,
      })
    : { wrote: await completeCandidateFetch(env, claimed, fields) };
  if (!wrote) return { opened: extra.opened || false, kind: "stale_claim", wrote: false };
  return { opened: extra.opened || false, kind: extra.kind, wrote: true, excluded: extra.excluded, changed: extra.changed };
}

export async function fetchCandidate(env, candidate, extra = {}) {
  const claimed = await claimCandidateFetch(env, candidate.id);
  if (!claimed) return { opened: false, kind: "skipped_claimed" };

  try {
    if (typeof extra.afterClaim === "function") await extra.afterClaim(claimed);
    const mayor = await resolveMayor(env, claimed.mayor_id || candidate.mayor_id);
    if (!mayor) {
      return finishCandidate(env, claimed, {
        fetch_status: "failed",
        skip_reason: "mayor_not_found",
        stage: STAGES.ARTICLE_FETCH,
        last_error: "mayor_not_found",
      }, { kind: "failed" });
    }

    const article = await readArticle(claimed.url || candidate.url, {
      mayorId: mayor.id,
      fetch: extra.fetch,
      etag: claimed.etag || candidate.etag,
      lastModified: claimed.last_modified || candidate.last_modified,
    });
    if (article?.notModified) {
      return finishCandidate(env, claimed, {
        fetch_status: "skipped",
        skip_reason: "not_modified",
        stage: STAGES.ARTICLE_FETCH,
        http_status: 304,
      }, { kind: "not_modified" });
    }
    if (!article || article.error) {
      const reason = article?.error || "unverified";
      return finishCandidate(env, claimed, {
        fetch_status: reason === "canonical_outside_registry" ? "skipped" : "failed",
        skip_reason: reason,
        stage: STAGES.ARTICLE_FETCH,
        http_status: article?.httpStatus || null,
        last_error: reason,
      }, { kind: reason === "canonical_outside_registry" ? "untrusted" : "unverified" });
    }

    const preview = classifyItem({ ...candidate, ...claimed, url: article.url }, mayor);
    if (preview.exclude_reason && preview.publisher_tier == null && candidate.source !== "official") {
      return finishCandidate(env, claimed, {
        fetch_status: "skipped",
        skip_reason: "untrusted",
        stage: STAGES.RELEVANCE_CHECK,
        http_status: article.httpStatus || 200,
      }, { opened: true, kind: "untrusted" });
    }

    const judged = judgeArticle(article, mayor, {
      ...candidate,
      ...claimed,
      source: sourceById(claimed.source_id || candidate.source_id)?.tier === 0 ? "official" : "approved_page",
      language: mayor.native_lang,
      publisher_url: article.url,
    });
    if (!judged.ok) {
      return finishCandidate(env, claimed, {
        fetch_status: "skipped",
        skip_reason: judged.reason,
        stage: STAGES.RELEVANCE_CHECK,
        http_status: article.httpStatus || 200,
        etag: article.etag,
        last_modified: article.lastModified,
      }, {
        opened: true,
        kind: judged.reason,
        bump: { sourceId: claimed.source_id || candidate.source_id, relevant: false },
      });
    }

    const seen = extra.seen || new Set();
    const planned = await planIngest(env, mayor, claimed.scan_id || candidate.scan_id, judged.row, seen);
    if (planned.kind === "duplicate") {
      return finishCandidate(env, claimed, {
        fetch_status: "fetched",
        skip_reason: "duplicate",
        stage: STAGES.DEDUPLICATION,
        http_status: article.httpStatus || 200,
        etag: article.etag,
        last_modified: article.lastModified,
        canonical_url: judged.row.url,
      }, { opened: true, kind: "duplicate" });
    }

    const outcome = await persistCandidateFetchOutcome(env, claimed, {
      complete: {
        fetch_status: "fetched",
        skip_reason: planned.kind === "duplicate" ? "duplicate" : null,
        stage: planned.kind === "found" ? STAGES.AI_BRIEF : STAGES.DEDUPLICATION,
        http_status: article.httpStatus || 200,
        etag: article.etag,
        last_modified: article.lastModified,
        canonical_url: judged.row.url,
      },
      item: planned,
      bump: {
        sourceId: claimed.source_id || candidate.source_id,
        relevant: planned.kind === "found" && !planned.excluded,
      },
    });
    if (!outcome.wrote) return { opened: true, kind: "stale_claim", wrote: false };
    const kind = planned.kind === "found" && outcome.itemChanges === 0 ? "held" : planned.kind;
    return {
      opened: true,
      kind,
      excluded: planned.excluded,
      changed: planned.changed,
      wrote: true,
    };
  } catch (error) {
    const recovered = await recoverCandidateAfterException(env, claimed, error);
    if (!recovered.wrote) return { opened: false, kind: "stale_claim", wrote: false };
    return { opened: false, kind: recovered.kind, delaySeconds: recovered.delaySeconds, wrote: true };
  }
}

export async function ingestRow(env, mayor, scanId, row, seen) {
  const planned = await planIngest(env, mayor, scanId, row, seen);
  if (planned.kind === "duplicate") return { kind: "duplicate" };
  if (planned.insert) {
    try {
      const result = await env.DB.prepare(
        `INSERT INTO items (
          id, mayor_id, scan_id, source, title, title_normalized, url, published_at,
          snippet, language, confidence, status, exclude_reason, fingerprint,
          publisher_domain, publisher_tier, article_text, source_documents,
          merged_sources, source_count, title_ar, snippet_ar, trans_engine
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          planned.insert.id,
          planned.insert.mayorId,
          planned.insert.scanId,
          planned.insert.source,
          planned.insert.title,
          planned.insert.titleNormalized,
          planned.insert.url,
          planned.insert.publishedAt,
          planned.insert.snippet,
          planned.insert.language,
          planned.insert.confidence,
          planned.insert.status,
          planned.insert.excludeReason,
          planned.insert.fingerprint,
          planned.insert.publisherDomain,
          planned.insert.publisherTier,
          planned.insert.articleText,
          planned.insert.documents,
          planned.insert.metadata,
          1,
          planned.insert.titleAr,
          planned.insert.snippetAr,
          planned.insert.transEngine,
        )
        .run();
      if (Number(result?.meta?.changes) > 0) {
        return { kind: "found", excluded: planned.excluded };
      }
      return { kind: "held", changed: 0 };
    } catch (err) {
      if (String(err.message || err).includes("UNIQUE")) return { kind: "held", changed: 0 };
      throw err;
    }
  }
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
      planned.update.source,
      planned.update.title,
      planned.update.titleNormalized,
      planned.update.url,
      planned.update.publishedAt,
      planned.update.snippet,
      planned.update.language,
      planned.update.confidence,
      planned.update.publisherDomain,
      planned.update.publisherTier,
      planned.update.articleText,
      planned.update.documents,
      planned.update.metadata,
      planned.update.sourceCount,
      planned.update.changed,
      planned.update.changed,
      planned.update.changed,
      planned.update.changed,
      planned.existingId,
    )
    .run();
  return { kind: "held", changed: planned.changed };
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

export async function fetchCandidateBatch(env, { ids = [], mayorId = null, scanId = null, limit = ARTICLE_FETCH_BATCH, fetch, afterClaim } = {}) {
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
         AND (? IS NULL OR scan_id = ?)
       ORDER BY discovered_at
       LIMIT ?`,
    )
      .bind(mayorId, mayorId, scanId, scanId, limit)
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
    retryAfterSeconds: 0,
  };
  const seen = new Set();
  for (const candidate of rows.slice(0, limit)) {
    const result = await fetchCandidate(env, candidate, { fetch, seen, afterClaim });
    summary.processed += 1;
    if (result.opened) summary.opened += 1;
    if (result.delaySeconds) {
      summary.retryAfterSeconds = Math.max(summary.retryAfterSeconds, Number(result.delaySeconds) || 0);
    }
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

export async function pollOneSource(env, { sourceId, mayorId, scanId = null, query = "", fetch, persist = true, claimed = null } = {}) {
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
  const persisted = persist && env.DB
    ? await persistDiscovered(env, { mayor, source, scanId, rows, claimed })
    : { discovered: rows.length, inserted: 0, newIds: [] };
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
