import { MAYORS } from "./mayors.js";
import { runScan, sourceStatus } from "./collect.js";
import { MAX_BRIEF_ATTEMPTS, pendingBriefCount, translatePending } from "./translate.js";
import { PUBLISHERS } from "./publishers.js";
import { reviewInbox } from "./reviewAgent.js";
import { REASON } from "./reasons.js";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS mayors (
    id TEXT PRIMARY KEY,
    country_ar TEXT NOT NULL,
    city_ar TEXT NOT NULL,
    city_en TEXT NOT NULL,
    title_ar TEXT NOT NULL,
    title_en TEXT NOT NULL,
    name_en TEXT NOT NULL,
    name_native TEXT NOT NULL,
    name_ar TEXT NOT NULL,
    native_lang TEXT NOT NULL,
    native_lang_ar TEXT NOT NULL,
    country_code TEXT NOT NULL,
    gn_hl TEXT NOT NULL,
    gn_gl TEXT NOT NULL,
    official_host TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    query TEXT,
    mayor_id TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    found_count INTEGER DEFAULT 0,
    duplicate_count INTEGER DEFAULT 0,
    excluded_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    mayor_id TEXT NOT NULL,
    scan_id TEXT,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    title_normalized TEXT NOT NULL,
    url TEXT NOT NULL,
    published_at TEXT,
    snippet TEXT,
    title_ar TEXT,
    snippet_ar TEXT,
    language TEXT,
    confidence TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'inbox',
    exclude_reason TEXT,
    fingerprint TEXT NOT NULL,
    trans_engine TEXT,
    publisher_domain TEXT,
    publisher_tier INTEGER,
    article_text TEXT,
    source_documents TEXT,
    merged_sources TEXT,
    source_count INTEGER DEFAULT 1,
    brief_evidence TEXT,
    brief_error TEXT,
    brief_attempted_at TEXT,
    brief_attempts INTEGER DEFAULT 0,
    brief_claim_id TEXT,
    brief_claimed_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_items_mayor ON items(mayor_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_items_fingerprint ON items(fingerprint)`,
  `CREATE INDEX IF NOT EXISTS idx_scans_started ON scans(started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS search_jobs (
    id TEXT PRIMARY KEY,
    query TEXT,
    mayor_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    created_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS search_job_tasks (
    job_id TEXT NOT NULL,
    mayor_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER DEFAULT 0,
    stage TEXT DEFAULT 'queued',
    detail TEXT,
    started_at TEXT,
    finished_at TEXT,
    result_json TEXT,
    error TEXT,
    PRIMARY KEY (job_id, mayor_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_search_job_tasks_status
    ON search_job_tasks(job_id, status)`,
  `CREATE TABLE IF NOT EXISTS publishers (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    name TEXT NOT NULL,
    tier INTEGER NOT NULL,
    country_code TEXT,
    mayor_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_publishers_domain ON publishers(domain)`,
  `CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
  )`,
];

let ready = false;
const BOOTSTRAP_VERSION = "bootstrap-v9";

async function upsertRows(env, prefix, rows, width, chunkSize) {
  const tuple = `(${Array.from({ length: width }, () => "?").join(", ")})`;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await env.DB.prepare(`${prefix} VALUES ${chunk.map(() => tuple).join(", ")}`)
      .bind(...chunk.flat())
      .run();
  }
}

async function migrateSearchJobs(env) {
  const info = await env.DB.prepare(`PRAGMA table_info(search_job_tasks)`).all();
  const names = new Set((info.results || []).map((column) => column.name));
  if (!names.has("stage")) {
    await env.DB.prepare(`ALTER TABLE search_job_tasks ADD COLUMN stage TEXT DEFAULT 'queued'`).run();
  }
  if (!names.has("detail")) {
    await env.DB.prepare(`ALTER TABLE search_job_tasks ADD COLUMN detail TEXT`).run();
  }
}

async function ensureDb(env) {
  if (ready) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`).run();
  const bootstrapped = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'bootstrap_version'`).first();
  if (bootstrapped?.v === BOOTSTRAP_VERSION) {
    ready = true;
    return;
  }
  for (const sql of SCHEMA_STATEMENTS) {
    await env.DB.prepare(sql).run();
  }
  await migrateSearchJobs(env);
  await upsertRows(
    env,
    `INSERT OR REPLACE INTO mayors (
      id, country_ar, city_ar, city_en, title_ar, title_en, name_en, name_native, name_ar,
      native_lang, native_lang_ar, country_code, gn_hl, gn_gl, official_host
    )`,
    MAYORS.map((m) => [
      m.id,
      m.country_ar,
      m.city_ar,
      m.city_en,
      m.title_ar,
      m.title_en,
      m.name_en,
      m.name_native,
      m.name_ar,
      m.native_lang,
      m.native_lang_ar,
      m.country_code,
      m.gn_hl,
      m.gn_gl,
      m.official_host,
    ]),
    15,
    6,
  );
  await upsertRows(
    env,
    `INSERT OR REPLACE INTO publishers (id, domain, name, tier, country_code, mayor_id)`,
    PUBLISHERS.map((p) => [
      p.id,
      p.domain,
      p.name,
      p.tier,
      p.country_code,
      p.mayor_id,
    ]),
    6,
    15,
  );
  await migrateItems(env);
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('bootstrap_version', ?)`)
    .bind(BOOTSTRAP_VERSION)
    .run();
  ready = true;
}

async function migrateItems(env) {
  const info = await env.DB.prepare(`PRAGMA table_info(items)`).all();
  const names = new Set((info.results || []).map((col) => col.name));
  if (!names.has("title_ar")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN title_ar TEXT`).run();
  }
  if (!names.has("snippet_ar")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN snippet_ar TEXT`).run();
  }
  if (!names.has("trans_engine")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN trans_engine TEXT`).run();
  }
  if (!names.has("publisher_domain")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN publisher_domain TEXT`).run();
  }
  if (!names.has("publisher_tier")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN publisher_tier INTEGER`).run();
  }
  if (!names.has("article_text")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN article_text TEXT`).run();
  }
  if (!names.has("source_documents")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN source_documents TEXT`).run();
  }
  if (!names.has("merged_sources")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN merged_sources TEXT`).run();
  }
  if (!names.has("source_count")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN source_count INTEGER DEFAULT 1`).run();
  }
  if (!names.has("brief_evidence")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN brief_evidence TEXT`).run();
  }
  if (!names.has("brief_error")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN brief_error TEXT`).run();
  }
  if (!names.has("brief_attempted_at")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN brief_attempted_at TEXT`).run();
  }
  if (!names.has("brief_attempts")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN brief_attempts INTEGER DEFAULT 0`).run();
  }
  if (!names.has("brief_claim_id")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN brief_claim_id TEXT`).run();
  }
  if (!names.has("brief_claimed_at")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN brief_claimed_at TEXT`).run();
  }
  await env.DB.prepare(
    `UPDATE items SET exclude_reason = ?
     WHERE status = 'excluded'
       AND IFNULL(exclude_reason, '') NOT IN (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      REASON.MANUAL,
      REASON.MANUAL,
      REASON.UNTRUSTED,
      REASON.UNRELATED,
      REASON.DUPLICATE,
      REASON.REVIEW,
      REASON.STALE,
    )
    .run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
  ).run();
  const epoch = "week-verify-v1";
  const current = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'data_epoch'`).first();
  if (current?.v !== epoch) {
    await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('data_epoch', ?)`).bind(epoch).run();
  }
  const briefEpoch = "grounded-ai-v3";
  const currentBrief = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'brief_epoch'`).first();
  if (currentBrief?.v !== briefEpoch) {
    await env.DB.prepare(
      `UPDATE items
       SET title_ar = 'بانتظار قراءة الذكاء الاصطناعي — ' ||
             COALESCE((SELECT name_ar FROM mayors WHERE mayors.id = items.mayor_id), mayor_id),
           snippet_ar = '', trans_engine = 'brief-pending',
           brief_evidence = NULL, brief_error = NULL
       WHERE status IN ('inbox', 'approved')
         AND IFNULL(trans_engine, '') NOT LIKE 'brief-ai-gemini-v2:%'`,
    ).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('brief_epoch', ?)`)
      .bind(briefEpoch)
      .run();
  }
  const resetEpoch = "clean-start-2026-09-10";
  const currentReset = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'reset_epoch'`).first();
  if (currentReset?.v !== resetEpoch) {
    await env.DB.prepare(`DELETE FROM items`).run();
    await env.DB.prepare(`DELETE FROM scans`).run();
    await env.DB.prepare(`DELETE FROM search_job_tasks`).run();
    await env.DB.prepare(`DELETE FROM search_jobs`).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('reset_epoch', ?)`)
      .bind(resetEpoch)
      .run();
  }
}

const ITEM_FIELDS = `items.id, items.mayor_id, items.scan_id, items.source, items.title,
  items.title_ar AS news_title_ar, items.snippet, items.snippet_ar AS news_snippet_ar,
  items.title_normalized, items.url, items.published_at, items.language, items.confidence,
  items.status, items.exclude_reason, items.fingerprint, items.created_at, items.trans_engine,
  items.publisher_domain, items.publisher_tier, items.merged_sources, items.source_count,
  items.brief_evidence, items.brief_error, items.brief_attempted_at, items.brief_attempts,
  mayors.name_ar, mayors.name_en, mayors.name_native, mayors.city_ar, mayors.country_ar,
  mayors.title_ar AS office_ar, mayors.title_en, mayors.official_host, mayors.native_lang_ar`;

const BRIEF_BATCH_SIZE = 3;

/** مسار المكتب الوحيد: جمع → تحقق → دمج المصادر → تلخيص AI → قرار الموظف. */
async function finishDesk(env, scanOpts, onProgress = async () => {}) {
  const result = await runScan(env, scanOpts, onProgress);
  await onProgress("merging", "يدمج التغطيات المتكررة للحدث نفسه");
  const review = await reviewInbox(env, {
    mayorId: scanOpts.mayorId || null,
    limit: 500,
    useAiMerge: result.found > 0 || result.updated > 0,
  });
  const summary = await summarizeBatch(env, scanOpts.mayorId || null, onProgress);
  return {
    ...result,
    review,
    summarized: summary.summarized,
    aiFailed: summary.failed,
    aiPending: summary.pending,
    aiRetryAfterSeconds: summary.retryAfterSeconds,
  };
}

/** يلخص دفعة واحدة فقط، ويترك الباقي لمهمة تلخيص لاحقة في الطابور. */
async function summarizeBatch(env, mayorId, onProgress = async () => {}) {
  await onProgress("summarizing", "يقرأ الذكاء الاصطناعي نصوص الصفحات المدمجة ويدققها");
  const summary = await translatePending(env, BRIEF_BATCH_SIZE, mayorId);
  if (summary.pending > 0) {
    await onProgress(
      "ai_pending",
      `لُخص ${summary.summarized}، وبقي ${summary.pending} خبر ويكمل تلقائيًا`,
    );
  } else if (summary.failed) {
    await onProgress("ai_failed", `تعذر تلخيص ${summary.failed} خبر بعد المحاولات`);
  } else {
    await onProgress("completed", `اكتمل التلخيص: ${summary.summarized}`);
  }
  return summary;
}

async function enqueueBriefContinuation(env, mayorId, jobId, retryAfterSeconds = 0) {
  if (!env.SCAN_QUEUE) return false;
  const delaySeconds = Math.min(Math.max(Number(retryAfterSeconds) || 20, 20), 900);
  await env.SCAN_QUEUE.send(
    { type: "brief", mayorId, jobId },
    { contentType: "json", delaySeconds },
  );
  return true;
}

async function finishAllOffices(env, type = "weekly") {
  const results = [];
  const errors = [];
  for (let i = 0; i < MAYORS.length; i += 2) {
    const chunk = MAYORS.slice(i, i + 2);
    const settled = await Promise.allSettled(
      chunk.map((mayor) =>
        finishDesk(env, { type, query: "", mayorId: mayor.id }),
      ),
    );
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        results.push({ mayorId: chunk[index].id, ...result.value });
      } else {
        errors.push(`${chunk[index].id}: ${String(result.reason?.message || result.reason)}`);
      }
    });
  }
  return { offices: results.length, failed: errors.length, errors, results };
}

async function enqueueAllOffices(env, type = "weekly") {
  if (!env.SCAN_QUEUE) return finishAllOffices(env, type);
  await env.SCAN_QUEUE.sendBatch(
    MAYORS.map((mayor) => ({
      body: { type, mayorId: mayor.id },
      contentType: "json",
    })),
  );
  return { queued: MAYORS.length, type };
}

const SEARCH_TOTAL_KEYS = [
  "found",
  "held",
  "updated",
  "skippedStale",
  "skippedUnverified",
  "skippedUnrelated",
  "skippedUntrusted",
  "discovered",
  "opened",
  "summarized",
  "aiPending",
  "aiFailed",
];

function parseTaskResult(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function searchJobSnapshot(job, tasks) {
  const totals = Object.fromEntries(SEARCH_TOTAL_KEYS.map((key) => [key, 0]));
  totals.duplicates = 0;
  totals.sourceErrors = 0;
  let completed = 0;
  let failed = 0;
  let running = 0;
  for (const task of tasks) {
    if (task.status === "completed") {
      completed += 1;
      const result = parseTaskResult(task.result_json);
      SEARCH_TOTAL_KEYS.forEach((key) => {
        totals[key] += Number(result[key]) || 0;
      });
      totals.duplicates += Number(result.review?.duplicates) || 0;
      totals.sourceErrors += Array.isArray(result.errors) ? result.errors.length : 0;
    } else if (task.status === "failed") {
      failed += 1;
    } else if (task.status === "running" || task.status === "retrying") {
      running += 1;
    }
  }
  const total = tasks.length;
  const terminal = total > 0 && completed + failed === total;
  const status = terminal
    ? failed === total
      ? "failed"
      : failed
        ? "partial"
        : "completed"
    : running
      ? "running"
      : "queued";
  return {
    id: job.id,
    status,
    query: job.query || "",
    mayor_id: job.mayor_id || null,
    total,
    completed,
    failed,
    running,
    totals,
    tasks: tasks.map((task) => ({
      mayor_id: task.mayor_id,
      mayor_name: MAYORS.find((mayor) => mayor.id === task.mayor_id)?.name_ar || task.mayor_id,
      status: task.status,
      stage: task.stage || task.status,
      detail: task.detail || "",
      attempts: Number(task.attempts) || 0,
      error: task.error || null,
    })),
  };
}

async function readSearchJob(env, jobId) {
  const job = await env.DB.prepare(`SELECT * FROM search_jobs WHERE id = ?`).bind(jobId).first();
  if (!job) return null;
  const { results } = await env.DB.prepare(
    `SELECT mayor_id, status, stage, detail, attempts, result_json, error
     FROM search_job_tasks WHERE job_id = ? ORDER BY mayor_id`,
  )
    .bind(jobId)
    .all();
  return searchJobSnapshot(job, results || []);
}

async function refreshSearchJobStatus(env, jobId) {
  const snapshot = await readSearchJob(env, jobId);
  if (!snapshot) return;
  await env.DB.prepare(
    `UPDATE search_jobs
     SET status = ?, finished_at = CASE WHEN ? IN ('completed', 'partial', 'failed')
       THEN datetime('now') ELSE NULL END
     WHERE id = ?`,
  )
    .bind(snapshot.status, snapshot.status, jobId)
    .run();
}

async function enqueueManualSearch(env, { mayorId = null, query = "" } = {}) {
  if (!env.SCAN_QUEUE) throw new Error("scan_queue_unavailable");
  const targets = mayorId ? MAYORS.filter((mayor) => mayor.id === mayorId) : MAYORS;
  if (!targets.length) throw new Error("mayor_not_found");
  const jobId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO search_jobs (id, query, mayor_id, status) VALUES (?, ?, ?, 'queued')`,
  )
    .bind(jobId, query || null, mayorId)
    .run();
  const taskStmt = env.DB.prepare(
    `INSERT INTO search_job_tasks (job_id, mayor_id, status, stage, detail)
     VALUES (?, ?, 'queued', 'queued', 'بانتظار بدء الرصد')`,
  );
  await env.DB.batch(targets.map((mayor) => taskStmt.bind(jobId, mayor.id)));
  try {
    await env.SCAN_QUEUE.sendBatch(
      targets.map((mayor) => ({
        body: { type: "manual", mayorId: mayor.id, query, jobId },
        contentType: "json",
      })),
    );
  } catch (error) {
    await env.DB.prepare(
      `UPDATE search_job_tasks SET status = 'failed', error = ? WHERE job_id = ?`,
    )
      .bind(String(error.message || error).slice(0, 300), jobId)
      .run();
    await refreshSearchJobStatus(env, jobId);
    throw error;
  }
  return { jobId, queued: targets.length };
}

async function processBriefContinuation(env, message) {
  const body = message.body || {};
  const mayorId = body.mayorId || null;
  const jobId = body.jobId || null;
  try {
    const summary = await summarizeBatch(env, mayorId);
    if (summary.pending > 0 && (summary.summarized > 0 || summary.failed > 0)) {
      await enqueueBriefContinuation(env, mayorId, jobId, summary.retryAfterSeconds);
    }
    if (jobId) {
      await env.DB.prepare(
        `UPDATE search_job_tasks
         SET stage = ?, detail = ?
         WHERE job_id = ? AND mayor_id = ?`,
      )
        .bind(
          summary.pending > 0 ? "ai_pending" : summary.failed ? "ai_failed" : "completed",
          summary.pending > 0
            ? `بقي ${summary.pending} خبر ويكمل تلقائيًا`
            : summary.failed
              ? `تعذر تلخيص ${summary.failed} خبر`
              : "اكتمل التلخيص",
          jobId,
          mayorId,
        )
        .run();
    }
    message.ack();
  } catch {
    message.retry({ delaySeconds: 30 });
  }
}

async function processQueuedSearch(env, message) {
  const body = message.body || {};
  if (body.type === "brief") {
    await processBriefContinuation(env, message);
    return;
  }
  const mayorId = body.mayorId;
  if (!mayorId || !MAYORS.some((mayor) => mayor.id === mayorId)) {
    message.ack();
    return;
  }
  const jobId = body.jobId || null;
  if (jobId) {
    const task = await env.DB.prepare(
      `SELECT status FROM search_job_tasks WHERE job_id = ? AND mayor_id = ?`,
    )
      .bind(jobId, mayorId)
      .first();
    if (!task || task.status === "completed" || task.status === "failed") {
      message.ack();
      return;
    }
    await env.DB.prepare(
      `UPDATE search_job_tasks
       SET status = 'running', attempts = IFNULL(attempts, 0) + 1,
           stage = 'discovering', detail = 'يبدأ البحث المباشر بالاسم والمنصب',
           started_at = COALESCE(started_at, datetime('now')), error = NULL
       WHERE job_id = ? AND mayor_id = ?`,
    )
      .bind(jobId, mayorId)
      .run();
    await env.DB.prepare(`UPDATE search_jobs SET status = 'running' WHERE id = ?`)
      .bind(jobId)
      .run();
  }

  const onProgress = jobId
    ? async (stage, detail) => {
        await env.DB.prepare(
          `UPDATE search_job_tasks SET stage = ?, detail = ?
           WHERE job_id = ? AND mayor_id = ?`,
        )
          .bind(stage, String(detail || "").slice(0, 300), jobId, mayorId)
          .run();
      }
    : async () => {};

  try {
    const result = await finishDesk(env, {
      type: body.type || "weekly",
      query: body.query || "",
      mayorId,
    }, onProgress);
    if (result.aiPending > 0) {
      await enqueueBriefContinuation(env, mayorId, jobId, result.aiRetryAfterSeconds);
    }
    if (jobId) {
      const finalStage = result.aiPending
        ? "ai_pending"
        : result.aiFailed
          ? "ai_failed"
          : "completed";
      const finalDetail = result.aiPending
        ? `بقي ${result.aiPending} خبر ويكمل التلخيص تلقائيًا`
        : result.aiFailed
          ? `تعذر تلخيص ${result.aiFailed} خبر`
          : "اكتمل الرصد والتلخيص";
      await env.DB.prepare(
        `UPDATE search_job_tasks
         SET status = 'completed', finished_at = datetime('now'),
             stage = ?, detail = ?,
             result_json = ?, error = NULL
         WHERE job_id = ? AND mayor_id = ?`,
      )
        .bind(finalStage, finalDetail, JSON.stringify(result), jobId, mayorId)
        .run();
      await refreshSearchJobStatus(env, jobId);
    }
    message.ack();
  } catch (error) {
    if (!jobId) {
      message.retry();
      return;
    }
    const exhausted = Number(message.attempts || 1) >= 3;
    await env.DB.prepare(
      `UPDATE search_job_tasks
       SET status = ?, finished_at = CASE WHEN ? THEN datetime('now') ELSE NULL END,
           stage = ?, detail = ?, error = ?
       WHERE job_id = ? AND mayor_id = ?`,
    )
      .bind(
        exhausted ? "failed" : "retrying",
        exhausted ? 1 : 0,
        exhausted ? "failed" : "retrying",
        exhausted ? "تعذر إكمال الرصد" : "تعذر مؤقتًا وستعاد المحاولة",
        String(error.message || error).slice(0, 300),
        jobId,
        mayorId,
      )
      .run();
    await refreshSearchJobStatus(env, jobId);
    if (exhausted) message.ack();
    else message.retry({ delaySeconds: 15 });
  }
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function authorized(request, env) {
  if (!env.DASHBOARD_PASSWORD) return !env.GEMINI_API_KEY;
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const user = env.DASHBOARD_USER || "mayorwatch";
    return decoded === `${user}:${env.DASHBOARD_PASSWORD}`;
  } catch {
    return false;
  }
}

function authRequired() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="MayorWatch"',
      "Cache-Control": "no-store",
    },
  });
}

async function publicHealth(env) {
  const ai = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN trans_engine = 'brief-pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN trans_engine = 'brief-ai-error' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN trans_engine LIKE 'brief-ai-gemini-v2:%' THEN 1 ELSE 0 END) AS completed
     FROM items`,
  ).first();
  const { results } = await env.DB.prepare(
    `SELECT brief_error AS code, COUNT(*) AS count
     FROM items
     WHERE brief_error IS NOT NULL
     GROUP BY brief_error
     ORDER BY count DESC
     LIMIT 5`,
  ).all();
  return {
    ok: true,
    cron: "Sunday 06:00 Asia/Riyadh",
    queue: Boolean(env.SCAN_QUEUE),
    ai: {
      configured: Boolean(env.GEMINI_API_KEY),
      model: env.GEMINI_MODEL || null,
      pending: Number(ai?.pending) || 0,
      failed: Number(ai?.failed) || 0,
      completed: Number(ai?.completed) || 0,
      retryable: await pendingBriefCount(env),
      maxAttempts: MAX_BRIEF_ATTEMPTS,
      errors: results || [],
    },
  };
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function stats(env) {
  const row = await env.DB.prepare(
    `SELECT
      SUM(CASE WHEN status = 'inbox' THEN 1 ELSE 0 END) AS inbox,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'excluded' THEN 1 ELSE 0 END) AS excluded,
      COUNT(*) AS total
     FROM items`,
  ).first();
  const byMayor = await env.DB.prepare(
    `SELECT mayor_id, COUNT(*) AS total,
            SUM(CASE WHEN status = 'inbox' THEN 1 ELSE 0 END) AS inbox,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
            SUM(CASE WHEN status = 'excluded' THEN 1 ELSE 0 END) AS excluded
     FROM items GROUP BY mayor_id`,
  ).all();
  const lastWeekly = await env.DB.prepare(
    `SELECT * FROM scans WHERE type = 'weekly' ORDER BY started_at DESC LIMIT 1`,
  ).first();
  const lastManual = await env.DB.prepare(
    `SELECT * FROM scans WHERE type = 'manual' ORDER BY started_at DESC LIMIT 1`,
  ).first();
  const weekDup = await env.DB.prepare(
    `SELECT COUNT(*) AS duplicates
     FROM items
     WHERE exclude_reason = ?
       AND COALESCE(published_at, created_at) >= datetime('now', '-7 days')`,
  )
    .bind(REASON.DUPLICATE)
    .first();
  const weekFound = await env.DB.prepare(
    `SELECT COUNT(*) AS found
     FROM items
     WHERE COALESCE(published_at, created_at) >= datetime('now', '-7 days')`,
  ).first();
  return {
    inbox: row?.inbox || 0,
    approved: row?.approved || 0,
    excluded: row?.excluded || 0,
    total: row?.total || 0,
    byMayor: byMayor.results || [],
    lastWeekly,
    lastManual,
    week: { duplicates: weekDup?.duplicates || 0, found: weekFound?.found || 0 },
    sources: {
      ...sourceStatus(env),
      ai_brief: env.GEMINI_API_KEY ? "ready" : "unconfigured",
    },
  };
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/mayors" && method === "GET") {
    const { results } = await env.DB.prepare(`SELECT * FROM mayors ORDER BY country_ar, city_ar`).all();
    return json({ mayors: results });
  }

  if (path === "/api/stats" && method === "GET") {
    return json(await stats(env));
  }

  if (path === "/api/scans" && method === "GET") {
    const { results } = await env.DB.prepare(`SELECT * FROM scans ORDER BY started_at DESC LIMIT 20`).all();
    return json({ scans: results });
  }

  const jobMatch = path.match(/^\/api\/search-jobs\/([0-9a-f-]+)$/i);
  if (jobMatch && method === "GET") {
    const job = await readSearchJob(env, jobMatch[1]);
    if (!job) return json({ error: "not_found" }, 404);
    return json({ job });
  }

  if (path === "/api/items" && method === "GET") {
    const status = url.searchParams.get("status") || "inbox";
    const mayorId = url.searchParams.get("mayor_id");
    const q = url.searchParams.get("q");
    const clauses = ["status = ?"];
    const binds = [status];
    if (mayorId) {
      clauses.push("mayor_id = ?");
      binds.push(mayorId);
    }
    if (q) {
      clauses.push("(title LIKE ? OR snippet LIKE ?)");
      binds.push(`%${q}%`, `%${q}%`);
    }
    const sql = `SELECT ${ITEM_FIELDS}
                 FROM items JOIN mayors ON mayors.id = items.mayor_id
                 WHERE ${clauses.join(" AND ")}
                 ORDER BY COALESCE(items.published_at, items.created_at) DESC
                 LIMIT 200`;
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json({ items: results });
  }

  const itemMatch = path.match(/^\/api\/items\/([0-9a-f-]+)$/i);
  if (itemMatch && method === "GET") {
    const row = await env.DB.prepare(
      `SELECT ${ITEM_FIELDS}
       FROM items JOIN mayors ON mayors.id = items.mayor_id WHERE items.id = ?`,
    )
      .bind(itemMatch[1])
      .first();
    if (!row) return json({ error: "not_found" }, 404);
    return json({ item: row });
  }

  const statusMatch = path.match(/^\/api\/items\/([0-9a-f-]+)\/status$/i);
  if (statusMatch && method === "POST") {
    const body = await readBody(request);
    const status = body.status;
    if (!["inbox", "approved", "excluded"].includes(status)) {
      return json({ error: "bad_status" }, 400);
    }
    const reason = status === "excluded" ? REASON.MANUAL : null;
    await env.DB.prepare(`UPDATE items SET status = ?, exclude_reason = ? WHERE id = ?`)
      .bind(status, reason, statusMatch[1])
      .run();
    return json({ ok: true });
  }

  if (path === "/api/review" && method === "POST") {
    const body = await readBody(request);
    const mayorId = body.mayor_id || null;
    const result = await reviewInbox(env, { mayorId, limit: 500 });
    const summary = await summarizeBatch(env, mayorId);
    if (summary.pending > 0) await enqueueBriefContinuation(env, mayorId, null);
    return json({ ok: true, ...result, ai: summary });
  }

  if (path === "/api/search" && method === "POST") {
    const body = await readBody(request);
    const result = await enqueueManualSearch(env, {
      mayorId: body.mayor_id || null,
      query: body.q || "",
    });
    return json({ ok: true, ...result }, 202);
  }

  if (path === "/api/scan/weekly" && method === "POST") {
    const result = await enqueueAllOffices(env);
    return json({ ok: true, ...result });
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") {
      try {
        await ensureDb(env);
        return json(await publicHealth(env));
      } catch (error) {
        return json({ ok: false, error: String(error.message || error) }, 500);
      }
    }
    if (!authorized(request, env)) return authRequired();
    await ensureDb(env);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (err) {
        return json({ error: "server_error", message: String(err.message || err) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(enqueueAllOffices(env));
  },

  async queue(batch, env) {
    await ensureDb(env);
    for (const message of batch.messages) {
      await processQueuedSearch(env, message);
    }
  },
};
