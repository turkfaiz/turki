/**
 * حجز ذري لفحص المصادر وجلب المرشحين.
 *
 * قبل الإصلاح — فحص المصدر:
 *   queued → polling (UPDATE بلا شرط وبلا claim_id)
 *   polling → polled حتى لو فشل الاتصال
 *   polling → failed عند الاستثناء ثم ack باعتباره نهاية
 *   رسالة مكررة بعد polled تعيد الفحص الخارجي
 *   لا retrying ولا lease ولا attempts ولا last_error
 *
 * بعد الإصلاح — فحص المصدر:
 *   queued | retrying(due) | polling(lease منتهٍ)
 *     → polling (UPDATE مشروط + RETURNING + claim_id)
 *   polling + نجاح يملك claim_id → polled
 *   polling + عطل مؤقت + attempts < الحد → retrying + next_attempt_at + last_error
 *   polling + استنفاد أو عطل نهائي → failed + last_error (نهائية، لا تعلق الإغلاق)
 *   polled/failed + رسالة مكررة → no-op بلا اتصال خارجي
 *   claim_id قديم لا يكتب polled/failed/retrying
 *
 * قبل الإصلاح — جلب المرشح:
 *   pending|retry → working مع fetched_at كوقت حجز
 *   working لا يُسترد بعد انتهاء المهلة
 *   استثناء بعد الحجز يترك working للأبد
 *   الكتابة النهائية غير مشروطة بـ claim
 *   pendingCandidateCount يشمل working بينما pendingFetchIds لا يشمله
 *     ⇒ count=1 و ids=[] بلا next_at
 *
 * بعد الإصلاح — جلب المرشح:
 *   pending|retry(due) | working(lease منتهٍ) → working + fetch_claim_id + fetch_claimed_at
 *   fetched_at وقت اكتمال الجلب فقط، لا وقت الحجز
 *   استثناء بعد الحجز → retry + fetch_after أو failed بعد الاستنفاد
 *   الكتابة النهائية مشروطة بـ fetch_claim_id الحالي
 *   كل عنصر في العدّ إما قابل للتنفيذ الآن أو مؤجَّل بـ next_at مستقبلي
 */

import { STAGES } from "./discovery.js";

export const SOURCE_POLL_LEASE_MINUTES = 10;
export const MAX_SOURCE_POLL_ATTEMPTS = 4;
export const CANDIDATE_FETCH_LEASE_MINUTES = 10;
export const MAX_CANDIDATE_FETCH_ATTEMPTS = 4;
export const LEASE_MIGRATION_ID = "0020_source_and_candidate_leases";

export const LEASE_MIGRATION_STATEMENTS = [
  "ALTER TABLE scan_sources ADD COLUMN claim_id TEXT",
  "ALTER TABLE scan_sources ADD COLUMN claimed_at TEXT",
  "ALTER TABLE scan_sources ADD COLUMN attempts INTEGER DEFAULT 0",
  "ALTER TABLE scan_sources ADD COLUMN next_attempt_at TEXT",
  "ALTER TABLE scan_sources ADD COLUMN last_error TEXT",
  "ALTER TABLE candidates ADD COLUMN fetch_claim_id TEXT",
  "ALTER TABLE candidates ADD COLUMN fetch_claimed_at TEXT",
  "ALTER TABLE candidates ADD COLUMN fetch_after TEXT",
  "ALTER TABLE candidates ADD COLUMN last_error TEXT",
  "CREATE INDEX IF NOT EXISTS idx_scan_sources_lease ON scan_sources(status, next_attempt_at)",
  "CREATE INDEX IF NOT EXISTS idx_candidates_fetch_lease ON candidates(fetch_status, fetch_after, fetch_claimed_at)",
];

const PERMANENT_SOURCE_FAILURES = new Set([
  "unknown_source",
  "mayor_not_found",
  "no_discovery_strategy",
]);

function backoffSeconds(attempts) {
  const n = Math.max(1, Number(attempts) || 1);
  return Math.min(300, 20 * 2 ** (n - 1));
}

export function sourcePollBackoffSeconds(attempts) {
  return backoffSeconds(attempts);
}

export function candidateFetchBackoffSeconds(attempts) {
  return backoffSeconds(attempts);
}

export function isPermanentSourceFailure(health) {
  const reason = String(health?.fail_reason || health?.status || "");
  return PERMANENT_SOURCE_FAILURES.has(reason);
}

export function isTerminalSourceStatus(status) {
  return status === "polled" || status === "failed";
}

async function tableColumns(env, table) {
  const info = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((info.results || []).map((column) => column.name));
}

async function addColumnIfMissing(env, table, column, type) {
  const names = await tableColumns(env, table);
  if (!names.size || names.has(column)) return false;
  await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`).run();
  return true;
}

/**
 * ترحيل أمامي قابل لإعادة التشغيل: لا DELETE/DROP، وALTER يُتخطى إن وُجد العمود.
 * ملف migrations/0020_*.sql هو النص الحرفي الذي يطبّقه wrangler مرة واحدة.
 */
export async function applyLeaseMigration(env) {
  if (!env?.DB) return;
  await addColumnIfMissing(env, "scan_sources", "claim_id", "TEXT");
  await addColumnIfMissing(env, "scan_sources", "claimed_at", "TEXT");
  await addColumnIfMissing(env, "scan_sources", "attempts", "INTEGER DEFAULT 0");
  await addColumnIfMissing(env, "scan_sources", "next_attempt_at", "TEXT");
  await addColumnIfMissing(env, "scan_sources", "last_error", "TEXT");
  await addColumnIfMissing(env, "candidates", "fetch_claim_id", "TEXT");
  await addColumnIfMissing(env, "candidates", "fetch_claimed_at", "TEXT");
  await addColumnIfMissing(env, "candidates", "fetch_after", "TEXT");
  await addColumnIfMissing(env, "candidates", "last_error", "TEXT");
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_scan_sources_lease ON scan_sources(status, next_attempt_at)`,
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_candidates_fetch_lease ON candidates(fetch_status, fetch_after, fetch_claimed_at)`,
  ).run();
}

export async function readScanSource(env, scanId, sourceId) {
  if (!scanId || !sourceId) return null;
  return env.DB.prepare(`SELECT * FROM scan_sources WHERE scan_id = ? AND source_id = ?`)
    .bind(scanId, sourceId)
    .first();
}

/**
 * حجز مصدر داخل مسح واحد بـ UPDATE مشروط. لا SELECT ثم UPDATE.
 * يمنع مستهلكين من فحص source_id نفسه داخل scan_id نفسه، ويمنع تداخل
 * فحص حي لنفس المصدر عبر المسوح أثناء سريان الـ lease.
 */
export async function claimSourcePoll(env, { scanId, sourceId, mayorId }) {
  if (!scanId || !sourceId) return null;
  const claimId = crypto.randomUUID();
  const row = await env.DB.prepare(
    `UPDATE scan_sources
     SET status = 'polling',
         claim_id = ?,
         claimed_at = datetime('now'),
         attempts = IFNULL(attempts, 0) + 1,
         detail = 'جاري فحص المصدر'
     WHERE scan_id = ?
       AND source_id = ?
       AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
       AND (
         status IN ('queued', 'retrying')
         OR (
           status = 'polling'
           AND (
             claim_id IS NULL
             OR claimed_at IS NULL
             OR claimed_at <= datetime('now', '-${SOURCE_POLL_LEASE_MINUTES} minutes')
           )
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM (
           SELECT 1 AS hit FROM scan_sources AS active
           WHERE active.source_id = scan_sources.source_id
             AND active.mayor_id = scan_sources.mayor_id
             AND active.status = 'polling'
             AND active.claim_id IS NOT NULL
             AND active.claimed_at > datetime('now', '-${SOURCE_POLL_LEASE_MINUTES} minutes')
             AND NOT (active.scan_id = scan_sources.scan_id AND active.source_id = scan_sources.source_id)
         )
       )
     RETURNING *`,
  )
    .bind(claimId, scanId, sourceId)
    .first();
  if (row) return row;
  return null;
}

async function writeSourcePoll(env, claimed, fields) {
  if (!claimed?.claim_id || !claimed.scan_id || !claimed.source_id) return false;
  const result = await env.DB.prepare(
    `UPDATE scan_sources
     SET status = ?,
         detail = ?,
         last_error = ?,
         next_attempt_at = ?,
         claim_id = CASE WHEN ? IN ('polled', 'failed') THEN claim_id ELSE NULL END,
         claimed_at = CASE WHEN ? IN ('polled', 'failed') THEN claimed_at ELSE NULL END
     WHERE scan_id = ? AND source_id = ? AND claim_id = ?`,
  )
    .bind(
      fields.status,
      String(fields.detail || "").slice(0, 160),
      fields.lastError ? String(fields.lastError).slice(0, 300) : null,
      fields.nextAttemptAt || null,
      fields.status,
      fields.status,
      claimed.scan_id,
      claimed.source_id,
      claimed.claim_id,
    )
    .run();
  return Number(result?.meta?.changes) > 0;
}

export async function completeSourcePoll(env, claimed, { status, detail, lastError = null } = {}) {
  return writeSourcePoll(env, claimed, {
    status,
    detail,
    lastError,
    nextAttemptAt: null,
  });
}

export async function deferSourcePoll(env, claimed, { lastError, detail } = {}) {
  if (!claimed?.claim_id || !claimed.scan_id || !claimed.source_id) return false;
  const delay = sourcePollBackoffSeconds(claimed.attempts);
  const result = await env.DB.prepare(
    `UPDATE scan_sources
     SET status = 'retrying',
         detail = ?,
         last_error = ?,
         next_attempt_at = datetime('now', ?),
         claim_id = NULL,
         claimed_at = NULL
     WHERE scan_id = ? AND source_id = ? AND claim_id = ?`,
  )
    .bind(
      String(detail || "تعذر مؤقتًا وستعاد المحاولة").slice(0, 160),
      lastError ? String(lastError).slice(0, 300) : null,
      `+${delay} seconds`,
      claimed.scan_id,
      claimed.source_id,
      claimed.claim_id,
    )
    .run();
  return Number(result?.meta?.changes) > 0;
}

export function sourcePollRetryDelaySeconds(row) {
  if (!row) return 20;
  if (row.next_attempt_at) {
    const at = Date.parse(String(row.next_attempt_at).replace(" ", "T") + "Z");
    if (Number.isFinite(at)) {
      return Math.max(5, Math.min(300, Math.ceil((at - Date.now()) / 1000)));
    }
  }
  return sourcePollBackoffSeconds(row.attempts || 1);
}

export async function findActiveMayorRun(env, mayorId) {
  if (!mayorId) return null;
  const task = await env.DB.prepare(
    `SELECT job_id FROM search_job_tasks
     WHERE mayor_id = ? AND status IN ('queued', 'running', 'waiting', 'retrying')
     LIMIT 1`,
  )
    .bind(mayorId)
    .first();
  const poll = await env.DB.prepare(
    `SELECT scan_id, job_id, source_id, status FROM scan_sources
     WHERE mayor_id = ?
       AND status IN ('queued', 'polling', 'retrying')
     LIMIT 1`,
  )
    .bind(mayorId)
    .first();
  if (!task && !poll) return null;
  return {
    jobId: task?.job_id || poll?.job_id || null,
    scanId: poll?.scan_id || null,
    sourceId: poll?.source_id || null,
    status: poll?.status || task?.status || null,
  };
}

export async function dueSourcePolls(env, limit = 40) {
  const { results } = await env.DB.prepare(
    `SELECT scan_id, source_id, mayor_id, job_id, status, next_attempt_at, claim_id
     FROM scan_sources
     WHERE (
       status = 'retrying'
       AND (next_attempt_at IS NULL OR next_attempt_at <= datetime('now'))
     ) OR (
       status = 'polling'
       AND (
         claim_id IS NULL
         OR claimed_at IS NULL
         OR claimed_at <= datetime('now', '-${SOURCE_POLL_LEASE_MINUTES} minutes')
       )
     )
     ORDER BY IFNULL(next_attempt_at, claimed_at)
     LIMIT ?`,
  )
    .bind(limit)
    .all();
  return results || [];
}

function candidateExecutableSql() {
  return `(
    (
      fetch_status IN ('pending', 'retry')
      AND (fetch_after IS NULL OR fetch_after <= datetime('now'))
    ) OR (
      fetch_status = 'working'
      AND (fetch_claimed_at IS NULL OR fetch_claimed_at <= datetime('now', '-${CANDIDATE_FETCH_LEASE_MINUTES} minutes'))
      AND (fetch_after IS NULL OR fetch_after <= datetime('now'))
    )
  )`;
}

function candidateResumeAtSql() {
  return `CASE
    WHEN fetch_status = 'working'
         AND fetch_claimed_at IS NOT NULL
         AND fetch_claimed_at > datetime('now', '-${CANDIDATE_FETCH_LEASE_MINUTES} minutes')
         AND fetch_after IS NOT NULL
         AND fetch_after > datetime('now')
      THEN CASE
        WHEN datetime(fetch_claimed_at, '+${CANDIDATE_FETCH_LEASE_MINUTES} minutes') > fetch_after
          THEN datetime(fetch_claimed_at, '+${CANDIDATE_FETCH_LEASE_MINUTES} minutes')
        ELSE fetch_after
      END
    WHEN fetch_status = 'working'
         AND fetch_claimed_at IS NOT NULL
         AND fetch_claimed_at > datetime('now', '-${CANDIDATE_FETCH_LEASE_MINUTES} minutes')
      THEN datetime(fetch_claimed_at, '+${CANDIDATE_FETCH_LEASE_MINUTES} minutes')
    WHEN fetch_after IS NOT NULL AND fetch_after > datetime('now')
      THEN fetch_after
    ELSE NULL
  END`;
}

export async function claimCandidateFetch(env, candidateId) {
  if (!candidateId) return null;
  const claimId = crypto.randomUUID();
  const row = await env.DB.prepare(
    `UPDATE candidates
     SET fetch_status = 'working',
         fetch_claim_id = ?,
         fetch_claimed_at = datetime('now'),
         attempts = IFNULL(attempts, 0) + 1
     WHERE id = ?
       AND (fetch_after IS NULL OR fetch_after <= datetime('now'))
       AND (
         fetch_status IN ('pending', 'retry')
         OR (
           fetch_status = 'working'
           AND (
             fetch_claim_id IS NULL
             OR fetch_claimed_at IS NULL
             OR fetch_claimed_at <= datetime('now', '-${CANDIDATE_FETCH_LEASE_MINUTES} minutes')
           )
         )
       )
     RETURNING *`,
  )
    .bind(claimId, candidateId)
    .first();
  return row || null;
}

export async function completeCandidateFetch(env, claimed, fields) {
  const claimId = claimed?.fetch_claim_id;
  if (!claimId || !claimed?.id) return false;
  const result = await env.DB.prepare(
    `UPDATE candidates
     SET fetch_status = ?,
         skip_reason = ?,
         stage = ?,
         http_status = COALESCE(?, http_status),
         etag = COALESCE(?, etag),
         last_modified = COALESCE(?, last_modified),
         canonical_url = COALESCE(?, canonical_url),
         last_error = ?,
         fetch_after = NULL,
         fetched_at = datetime('now')
     WHERE id = ? AND fetch_claim_id = ?`,
  )
    .bind(
      fields.fetch_status,
      fields.skip_reason || null,
      fields.stage || STAGES.ARTICLE_FETCH,
      fields.http_status ?? null,
      fields.etag || null,
      fields.last_modified || null,
      fields.canonical_url || null,
      fields.last_error || null,
      claimed.id,
      claimId,
    )
    .run();
  return Number(result?.meta?.changes) > 0;
}

export async function recoverCandidateAfterException(env, claimed, error) {
  const claimId = claimed?.fetch_claim_id;
  if (!claimId || !claimed?.id) return { kind: "skipped_claimed", wrote: false };
  const message = String(error?.code || error?.message || error || "exception").slice(0, 300);
  const attempts = Number(claimed.attempts) || 0;
  if (attempts >= MAX_CANDIDATE_FETCH_ATTEMPTS) {
    const wrote = await env.DB.prepare(
      `UPDATE candidates
       SET fetch_status = 'failed',
           skip_reason = 'exception',
           last_error = ?,
           fetch_after = NULL,
           fetched_at = datetime('now')
       WHERE id = ? AND fetch_claim_id = ?`,
    )
      .bind(message, claimed.id, claimId)
      .run();
    return { kind: "failed", wrote: Number(wrote?.meta?.changes) > 0, lastError: message };
  }
  const delay = candidateFetchBackoffSeconds(attempts);
  const wrote = await env.DB.prepare(
    `UPDATE candidates
     SET fetch_status = 'retry',
         skip_reason = 'exception',
         last_error = ?,
         fetch_after = datetime('now', ?),
         fetch_claim_id = NULL,
         fetch_claimed_at = NULL
     WHERE id = ? AND fetch_claim_id = ?`,
  )
    .bind(message, `+${delay} seconds`, claimed.id, claimId)
    .run();
  return { kind: "retry", wrote: Number(wrote?.meta?.changes) > 0, lastError: message, delaySeconds: delay };
}

export async function pendingCandidateBacklog(env, mayorId = null, scanId = null, { limit = 64 } = {}) {
  const executable = candidateExecutableSql();
  const resumeAt = candidateResumeAtSql();
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS pending,
       SUM(CASE WHEN ${executable} THEN 1 ELSE 0 END) AS eligible,
       MIN(CASE WHEN NOT (${executable}) THEN ${resumeAt} ELSE NULL END) AS next_at
     FROM candidates
     WHERE fetch_status IN ('pending', 'retry', 'working')
       AND (? IS NULL OR mayor_id = ?)
       AND (? IS NULL OR scan_id = ?)`,
  )
    .bind(mayorId, mayorId, scanId, scanId)
    .first();
  const { results } = await env.DB.prepare(
    `SELECT id FROM candidates
     WHERE ${executable}
       AND (? IS NULL OR mayor_id = ?)
       AND (? IS NULL OR scan_id = ?)
     ORDER BY discovered_at
     LIMIT ?`,
  )
    .bind(mayorId, mayorId, scanId, scanId, limit)
    .all();
  return {
    pending: Number(row?.pending) || 0,
    eligible: Number(row?.eligible) || 0,
    nextAt: row?.next_at || null,
    ids: (results || []).map((item) => item.id),
  };
}
