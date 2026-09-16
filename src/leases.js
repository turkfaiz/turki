/**
 * حجز ذري لفحص المصادر وجلب المرشحين، وقفل تشغيلي ذري للمكتب.
 *
 * الكتابات ذات الأثر (candidates / items / source counters / health /
 * article_fetch) مشروطة بـ claim_id أو fetch_claim_id الحالي داخل عبارة SQL
 * واحدة، وليست SELECT ثم كتابة غير مشروطة. الحالة النهائية تُفرّغ الحجز.
 *
 * ترحيل الأعمدة: ملف migrations/0020 يُطبَّق ويُسجَّل عبر wrangler d1_migrations
 * قبل نشر العامل الذي يعتمد عليها. العامل لا يضيف الأعمدة في وقت التشغيل.
 */

import { STAGES } from "./discovery.js";

export const SOURCE_POLL_LEASE_MINUTES = 10;
export const MAX_SOURCE_POLL_ATTEMPTS = 4;
export const CANDIDATE_FETCH_LEASE_MINUTES = 10;
export const MAX_CANDIDATE_FETCH_ATTEMPTS = 4;
export const DESK_RUN_LEASE_MINUTES = 60;
export const ALL_OFFICES_LOCK = "__all__";
export const LEASE_MIGRATION_ID = "0020_source_and_candidate_leases";

export const DESK_RUN_LOCKS_TABLE = `CREATE TABLE IF NOT EXISTS desk_run_locks (
    lock_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    job_id TEXT,
    scan_id TEXT,
    kind TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    lease_until TEXT NOT NULL
  )`;

export const DESK_RUN_LOCKS_INDEX =
  "CREATE INDEX IF NOT EXISTS idx_desk_run_locks_lease ON desk_run_locks(lease_until)";

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
  DESK_RUN_LOCKS_TABLE,
  DESK_RUN_LOCKS_INDEX,
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

export function isTerminalCandidateStatus(status) {
  return status === "fetched" || status === "skipped" || status === "failed";
}

export function deskLockKey(mayorId) {
  return mayorId ? `mayor:${mayorId}` : ALL_OFFICES_LOCK;
}

export function sqlStatementsFrom(sql) {
  return String(sql || "")
    .split(";")
    .map((chunk) =>
      chunk
        .split("\n")
        .map((line) => {
          const trimmed = line.trim();
          return trimmed.startsWith("--") ? "" : line;
        })
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
}

/**
 * يحاكي wrangler d1 migrations apply: العبارة تُنفَّذ مرة واحدة لأن السجل
 * في d1_migrations يمنع إعادة التشغيل. ملف ALTER نفسه غير قابل لإعادة التنفيذ.
 */
export async function applyOfficialD1Migration(env, { id, sql }) {
  if (!env?.DB || !id || !sql) return { applied: false, skipped: false };
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS d1_migrations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL UNIQUE,
       applied_at TEXT
     )`,
  ).run();
  const existing = await env.DB.prepare(`SELECT name FROM d1_migrations WHERE name = ?`)
    .bind(id)
    .first();
  if (existing) return { applied: false, skipped: true };
  const statements = sqlStatementsFrom(sql);
  if (!statements.length) return { applied: false, skipped: false };
  await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
  await env.DB.prepare(`INSERT INTO d1_migrations (name, applied_at) VALUES (?, datetime('now'))`)
    .bind(id)
    .run();
  return { applied: true, skipped: false, statements: statements.length };
}

export async function readScanSource(env, scanId, sourceId) {
  if (!scanId || !sourceId) return null;
  return env.DB.prepare(`SELECT * FROM scan_sources WHERE scan_id = ? AND source_id = ?`)
    .bind(scanId, sourceId)
    .first();
}

/**
 * حجز مصدر داخل مسح واحد بـ UPDATE مشروط. لا SELECT ثم UPDATE.
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

export function completeSourcePollStatement(env, claimed, fields) {
  return env.DB.prepare(
    `UPDATE scan_sources
     SET status = ?,
         detail = ?,
         last_error = ?,
         next_attempt_at = ?,
         claim_id = NULL,
         claimed_at = NULL
     WHERE scan_id = ? AND source_id = ? AND claim_id = ?`,
  ).bind(
    fields.status,
    String(fields.detail || "").slice(0, 160),
    fields.lastError ? String(fields.lastError).slice(0, 300) : null,
    fields.nextAttemptAt || null,
    claimed.scan_id,
    claimed.source_id,
    claimed.claim_id,
  );
}

async function writeSourcePoll(env, claimed, fields) {
  if (!claimed?.claim_id || !claimed.scan_id || !claimed.source_id) return false;
  const result = await completeSourcePollStatement(env, claimed, fields).run();
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
  const lock = await env.DB.prepare(
    `SELECT job_id, scan_id, kind, lock_key FROM desk_run_locks
     WHERE lease_until > datetime('now')
       AND (lock_key = ? OR lock_key = ?)
     ORDER BY CASE WHEN lock_key = ? THEN 0 ELSE 1 END
     LIMIT 1`,
  )
    .bind(deskLockKey(mayorId), ALL_OFFICES_LOCK, deskLockKey(mayorId))
    .first();
  if (lock) {
    return {
      jobId: lock.job_id || null,
      scanId: lock.scan_id || null,
      sourceId: null,
      status: lock.kind || "running",
      lockKey: lock.lock_key,
    };
  }
  return null;
}

export async function readLiveDeskLock(env, mayorId = null) {
  const lockKey = deskLockKey(mayorId);
  const isAll = lockKey === ALL_OFFICES_LOCK ? 1 : 0;
  return env.DB.prepare(
    `SELECT * FROM desk_run_locks
     WHERE lease_until > datetime('now')
       AND (
         lock_key = ?
         OR lock_key = '${ALL_OFFICES_LOCK}'
         OR (? = 1)
       )
     ORDER BY CASE WHEN lock_key = ? THEN 0 ELSE 1 END, claimed_at
     LIMIT 1`,
  )
    .bind(lockKey, isAll, lockKey)
    .first();
}

/**
 * حارس تشغيل ذري على مستوى صف القفل. لا SELECT ثم INSERT.
 * تعارض weekly وmanual لنفس المكتب: reuse للتشغيل الحي.
 */
export async function claimDeskRun(env, { mayorId = null, kind, jobId = null, scanId = null } = {}) {
  const lockKey = deskLockKey(mayorId);
  const ownerId = crypto.randomUUID();
  const isAll = lockKey === ALL_OFFICES_LOCK ? 1 : 0;
  const row = await env.DB.prepare(
    `INSERT INTO desk_run_locks (lock_key, owner_id, job_id, scan_id, kind, claimed_at, lease_until)
     SELECT ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+${DESK_RUN_LEASE_MINUTES} minutes')
     WHERE NOT EXISTS (
       SELECT 1 FROM desk_run_locks AS live
       WHERE live.lease_until > datetime('now')
         AND (
           live.lock_key = ?
           OR live.lock_key = '${ALL_OFFICES_LOCK}'
           OR (? = 1 AND live.lock_key <> '${ALL_OFFICES_LOCK}')
         )
     )
     ON CONFLICT(lock_key) DO UPDATE SET
       owner_id = excluded.owner_id,
       job_id = excluded.job_id,
       scan_id = excluded.scan_id,
       kind = excluded.kind,
       claimed_at = excluded.claimed_at,
       lease_until = excluded.lease_until
     WHERE desk_run_locks.lease_until <= datetime('now')
     RETURNING *`,
  )
    .bind(lockKey, ownerId, jobId, scanId, kind || "manual", lockKey, isAll)
    .first();
  if (row) return { acquired: true, reused: false, lock: row };
  const existing = await readLiveDeskLock(env, mayorId);
  if (existing) return { acquired: false, reused: true, lock: existing };
  const retry = await env.DB.prepare(
    `INSERT INTO desk_run_locks (lock_key, owner_id, job_id, scan_id, kind, claimed_at, lease_until)
     SELECT ?, ?, ?, ?, ?, datetime('now'), datetime('now', '+${DESK_RUN_LEASE_MINUTES} minutes')
     WHERE NOT EXISTS (
       SELECT 1 FROM desk_run_locks AS live
       WHERE live.lease_until > datetime('now')
         AND (
           live.lock_key = ?
           OR live.lock_key = '${ALL_OFFICES_LOCK}'
           OR (? = 1 AND live.lock_key <> '${ALL_OFFICES_LOCK}')
         )
     )
     ON CONFLICT(lock_key) DO UPDATE SET
       owner_id = excluded.owner_id,
       job_id = excluded.job_id,
       scan_id = excluded.scan_id,
       kind = excluded.kind,
       claimed_at = excluded.claimed_at,
       lease_until = excluded.lease_until
     WHERE desk_run_locks.lease_until <= datetime('now')
     RETURNING *`,
  )
    .bind(lockKey, ownerId, jobId, scanId, kind || "manual", lockKey, isAll)
    .first();
  if (retry) return { acquired: true, reused: false, lock: retry };
  const again = await readLiveDeskLock(env, mayorId);
  return { acquired: false, reused: Boolean(again), lock: again || null };
}

export async function releaseDeskRun(env, { mayorId = null, jobId = null, scanId = null } = {}) {
  if (!env?.DB) return false;
  const lockKey = deskLockKey(mayorId);
  const mayorRelease = await env.DB.prepare(
    `DELETE FROM desk_run_locks
     WHERE lock_key = ?
       AND (? IS NULL OR job_id = ? OR scan_id = ?)`,
  )
    .bind(lockKey, jobId || scanId, jobId, scanId)
    .run();
  const allRelease = scanId
    ? await env.DB.prepare(
        `DELETE FROM desk_run_locks
         WHERE lock_key = '${ALL_OFFICES_LOCK}'
           AND scan_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM scan_sources
             WHERE scan_id = ? AND status NOT IN ('polled', 'failed')
           )
           AND NOT EXISTS (
             SELECT 1 FROM candidates
             WHERE scan_id = ? AND fetch_status IN ('pending', 'retry', 'working')
           )`,
      )
        .bind(scanId, scanId, scanId)
        .run()
    : { meta: { changes: 0 } };
  return Number(mayorRelease?.meta?.changes || 0) + Number(allRelease?.meta?.changes || 0) > 0;
}

const TERMINAL_JOB_STATUSES = new Set(["completed", "partial", "failed"]);
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed"]);

export async function isDeskRunTerminal(env, { jobId, mayorId = null } = {}) {
  if (!jobId) return false;
  const job = await env.DB.prepare(`SELECT status FROM search_jobs WHERE id = ?`)
    .bind(jobId)
    .first();
  if (TERMINAL_JOB_STATUSES.has(job?.status)) return true;
  if (!mayorId) return false;
  const task = await env.DB.prepare(
    `SELECT status FROM search_job_tasks WHERE job_id = ? AND mayor_id = ?`,
  )
    .bind(jobId, mayorId)
    .first();
  return TERMINAL_TASK_STATUSES.has(task?.status);
}

export async function renewDeskRunLease(env, { jobId = null, mayorId = null, scanId = null } = {}) {
  if (!env?.DB) return false;
  if (jobId) {
    const result = await env.DB.prepare(
      `UPDATE desk_run_locks
       SET lease_until = datetime('now', '+${DESK_RUN_LEASE_MINUTES} minutes')
       WHERE job_id = ?`,
    )
      .bind(jobId)
      .run();
    return Number(result?.meta?.changes) > 0;
  }
  const lockKey = deskLockKey(mayorId);
  const result = await env.DB.prepare(
    `UPDATE desk_run_locks
     SET lease_until = datetime('now', '+${DESK_RUN_LEASE_MINUTES} minutes')
     WHERE lock_key = ?
       AND (? IS NULL OR scan_id = ?)`,
  )
    .bind(lockKey, scanId, scanId)
    .run();
  return Number(result?.meta?.changes) > 0;
}

export async function releaseDeskRunForJob(env, jobId) {
  if (!env?.DB || !jobId) return false;
  const result = await env.DB.prepare(`DELETE FROM desk_run_locks WHERE job_id = ?`)
    .bind(jobId)
    .run();
  return Number(result?.meta?.changes) > 0;
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

export function completeCandidateFetchStatement(env, claimed, fields) {
  return env.DB.prepare(
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
         fetched_at = datetime('now'),
         fetch_claim_id = NULL,
         fetch_claimed_at = NULL
     WHERE id = ? AND fetch_claim_id = ?`,
  ).bind(
    fields.fetch_status,
    fields.skip_reason || null,
    fields.stage || STAGES.ARTICLE_FETCH,
    fields.http_status ?? null,
    fields.etag || null,
    fields.last_modified || null,
    fields.canonical_url || null,
    fields.last_error || null,
    claimed.id,
    claimed.fetch_claim_id,
  );
}

export async function completeCandidateFetch(env, claimed, fields) {
  const claimId = claimed?.fetch_claim_id;
  if (!claimId || !claimed?.id) return false;
  const result = await completeCandidateFetchStatement(env, claimed, fields).run();
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
           fetched_at = datetime('now'),
           fetch_claim_id = NULL,
           fetch_claimed_at = NULL
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

export async function groupCandidatesForEnqueue(env, ids) {
  if (!ids?.length) return [];
  const placeholders = ids.map(() => "?").join(", ");
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.mayor_id, c.scan_id,
            (
              SELECT ss.job_id FROM scan_sources AS ss
              WHERE ss.scan_id = c.scan_id AND ss.source_id = c.source_id
              LIMIT 1
            ) AS job_id
     FROM candidates AS c
     WHERE c.id IN (${placeholders})`,
  )
    .bind(...ids)
    .all();
  const groups = new Map();
  for (const row of results || []) {
    const key = `${row.mayor_id || ""}|${row.scan_id || ""}|${row.job_id || ""}`;
    if (!groups.has(key)) {
      groups.set(key, {
        mayorId: row.mayor_id || null,
        scanId: row.scan_id || null,
        jobId: row.job_id || null,
        ids: [],
      });
    }
    groups.get(key).ids.push(row.id);
  }
  return [...groups.values()];
}
