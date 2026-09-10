import { MAYORS } from "./mayors.js";
import { runScan, sourceStatus } from "./collect.js";
import { MAX_BRIEF_ATTEMPTS, pendingBriefCount, translatePending } from "./translate.js";
import { budgetSettings, budgetState, pruneAiBudget } from "./aiBudget.js";
import { APPROVED_SOURCES, MAX_SOURCES_PER_OFFICE } from "./sources.js";
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
    brief_after TEXT,
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
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    mayor_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    name TEXT NOT NULL,
    tier INTEGER NOT NULL,
    kind TEXT NOT NULL,
    url TEXT NOT NULL,
    rank INTEGER NOT NULL,
    verified INTEGER DEFAULT 0,
    curated_at TEXT,
    last_checked_at TEXT,
    last_ok_at TEXT,
    last_status TEXT,
    last_items INTEGER DEFAULT 0,
    consecutive_failures INTEGER DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sources_mayor ON sources(mayor_id, rank)`,
  `CREATE TABLE IF NOT EXISTS ai_budget (
    day TEXT PRIMARY KEY,
    calls INTEGER NOT NULL DEFAULT 0,
    last_call_at TEXT,
    blocked_until TEXT,
    block_reason TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
  )`,
];

const bootstrapped = new WeakSet();
const BOOTSTRAP_VERSION = "bootstrap-v12";

async function upsertRows(env, prefix, rows, width, chunkSize, conflictClause = "") {
  const tuple = `(${Array.from({ length: width }, () => "?").join(", ")})`;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await env.DB.prepare(
      `${prefix} VALUES ${chunk.map(() => tuple).join(", ")} ${conflictClause}`,
    )
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

export async function ensureDb(env) {
  if (bootstrapped.has(env.DB)) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`).run();
  const stamp = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'bootstrap_version'`).first();
  if (stamp?.v === BOOTSTRAP_VERSION) {
    bootstrapped.add(env.DB);
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
  await seedSources(env);
  await migrateItems(env);
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('bootstrap_version', ?)`)
    .bind(BOOTSTRAP_VERSION)
    .run();
  bootstrapped.add(env.DB);
}

/**
 * السجل في الشيفرة هو المرجع، والجدول مرآة له تحمل بيانات الصحة. أي مصدر خرج
 * من السجل يُحذف من الجدول حتى لا يبقى نطاق معتمد بالخطأ.
 */
/**
 * إنشاء الجدول لا يضيف أعمدة لجدول قائم، فأي عمود جديد يحتاج ترحيلًا صريحًا
 * وإلا فشل الزرع في الإنتاج بينما يمر على قاعدة فارغة.
 */
async function migrateSources(env) {
  const info = await env.DB.prepare(`PRAGMA table_info(sources)`).all();
  const names = new Set((info.results || []).map((column) => column.name));
  if (!names.size) return;
  if (!names.has("verified")) {
    await env.DB.prepare(`ALTER TABLE sources ADD COLUMN verified INTEGER DEFAULT 0`).run();
  }
  if (!names.has("curated_at")) {
    await env.DB.prepare(`ALTER TABLE sources ADD COLUMN curated_at TEXT`).run();
  }
}

async function seedSources(env) {
  await migrateSources(env);
  await upsertRows(
    env,
    `INSERT INTO sources (id, mayor_id, domain, name, tier, kind, url, rank, verified, curated_at)`,
    APPROVED_SOURCES.map((source) => [
      source.id,
      source.mayor_id,
      source.domain,
      source.name,
      source.tier,
      source.kind,
      source.url,
      source.rank,
      source.verified,
      source.curated_at,
    ]),
    10,
    8,
    `ON CONFLICT(id) DO UPDATE SET
       mayor_id = excluded.mayor_id, domain = excluded.domain, name = excluded.name,
       tier = excluded.tier, kind = excluded.kind, url = excluded.url, rank = excluded.rank,
       verified = excluded.verified, curated_at = excluded.curated_at`,
  );
  const keep = APPROVED_SOURCES.map((source) => source.id);
  await env.DB.prepare(
    `DELETE FROM sources WHERE id NOT IN (${keep.map(() => "?").join(", ")})`,
  )
    .bind(...keep)
    .run();
}

/** يسجّل ما حدث فعلًا لكل مصدر حتى تكون الحوكمة مبنية على واقع الإنتاج. */
/**
 * المكتب أسبوعي، فلا معنى لتخزين ما خرج من النافذة. التقليم يمنع تراكم أخبار
 * قديمة تظهر في القوائم وتشوّه الإحصاءات.
 */
export async function pruneOldItems(env, days = ITEM_RETENTION_DAYS) {
  const result = await env.DB.prepare(
    `DELETE FROM items
     WHERE COALESCE(published_at, created_at) < datetime('now', ?)`,
  )
    .bind(`-${days} days`)
    .run();
  return Number(result?.meta?.changes) || 0;
}

export async function recordSourceHealth(env, rows) {
  if (!rows?.length) return;
  const stmt = env.DB.prepare(
    `UPDATE sources
     SET last_checked_at = datetime('now'),
         last_ok_at = CASE WHEN ? THEN datetime('now') ELSE last_ok_at END,
         last_status = ?, last_items = ?,
         consecutive_failures = CASE WHEN ? THEN 0 ELSE IFNULL(consecutive_failures, 0) + 1 END
     WHERE id = ?`,
  );
  for (let i = 0; i < rows.length; i += 20) {
    await env.DB.batch(
      rows.slice(i, i + 20).map((row) =>
        stmt.bind(
          row.ok ? 1 : 0,
          String(row.status || "").slice(0, 160),
          Number(row.items) || 0,
          row.ok ? 1 : 0,
          row.id,
        ),
      ),
    );
  }
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
  if (!names.has("brief_after")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN brief_after TEXT`).run();
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
  /**
   * الأخبار التي أحرقت محاولاتها على أخطاء الحصة لم يكن فيها عيب. الحاكم الجديد
   * لم يعد يحتسب هذه الحالة محاولة، فتُعاد هذه الصفوف إلى الانتظار مرة واحدة.
   */
  /**
   * الأخبار التي رُفضت لأن الاقتباس لم يحمل الاسم الكامل كانت ضحية تناقض داخلي:
   * الرصد يقبل اللقب مع سياق المنصب، والتلخيص كان يشترط الاسم الكامل في جملة
   * واحدة. بعد توحيد القاعدة تستحق محاولة نظيفة.
   */
  const attributionEpoch = "attribution-parity-v1";
  const currentAttribution = await env.DB
    .prepare(`SELECT v FROM meta WHERE k = 'attribution_epoch'`)
    .first();
  if (currentAttribution?.v !== attributionEpoch) {
    await env.DB.prepare(
      `UPDATE items
       SET brief_attempts = 0, brief_error = NULL, brief_attempted_at = NULL,
           brief_claim_id = NULL, brief_claimed_at = NULL,
           trans_engine = 'brief-pending',
           title_ar = 'بانتظار قراءة الذكاء الاصطناعي — ' ||
             COALESCE((SELECT name_ar FROM mayors WHERE mayors.id = items.mayor_id), mayor_id),
           snippet_ar = ''
       WHERE brief_error LIKE 'ai_ungrounded_headline%'
          OR brief_error LIKE 'ai_has_no_grounded_facts%'`,
    ).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('attribution_epoch', ?)`)
      .bind(attributionEpoch)
      .run();
  }
  const repairEpoch = "budget-governor-v1";
  const currentRepair = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'repair_epoch'`).first();
  if (currentRepair?.v !== repairEpoch) {
    await env.DB.prepare(
      `UPDATE items
       SET trans_engine = 'brief-pending', brief_error = NULL, brief_attempts = 0,
           brief_attempted_at = NULL, brief_claim_id = NULL, brief_claimed_at = NULL,
           title_ar = 'بانتظار قراءة الذكاء الاصطناعي — ' ||
             COALESCE((SELECT name_ar FROM mayors WHERE mayors.id = items.mayor_id), mayor_id),
           snippet_ar = ''
       WHERE IFNULL(trans_engine, '') NOT LIKE 'brief-ai-gemini-v2:%'`,
    ).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('repair_epoch', ?)`)
      .bind(repairEpoch)
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

const WEEKLY_CRON = "0 3 * * SUN";
/** نافذة الرصد سبعة أيام، ويُحفظ يومان إضافيان لاستقرار الترحيل. */
const ITEM_WINDOW_DAYS = 7;
const ITEM_RETENTION_DAYS = 9;
const BRIEF_BATCH_SIZE = 3;
const DRAIN_MAX_BRIEFS = 12;
const DRAIN_MAX_MS = 45000;
const CONTINUATION_MIN_SECONDS = 10;
const CONTINUATION_MAX_SECONDS = 900;
/** التأجيل الطويل (كنفاد حصة اليوم) يُترك لمهمة التصريف الدورية لا للطابور. */
const CONTINUATION_DEFER_CEILING = 300;

/** مسار المكتب الوحيد: جمع → تحقق → دمج المصادر → تلخيص AI → قرار الموظف. */
async function finishDesk(env, scanOpts, onProgress = async () => {}) {
  const result = await runScan(env, scanOpts, onProgress);
  await recordSourceHealth(env, result.sourceHealth);
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
    aiDeferred: summary.deferred,
    aiPending: summary.pending,
    aiRetryAfterSeconds: summary.retryAfterSeconds,
  };
}

export function briefStage(summary) {
  if (summary.unconfigured) {
    return {
      stage: "ai_unconfigured",
      detail: `مفتاح الذكاء الاصطناعي غير مربوط بالعامل، فلا يمكن تلخيص ${summary.pending} خبر`,
    };
  }
  if (summary.deferred > 0 && summary.pending > 0) {
    return {
      stage: "ai_waiting_quota",
      detail: `لُخص ${summary.summarized}، وبقي ${summary.pending} خبر بانتظار حصة الذكاء الاصطناعي ويستأنف تلقائيًا`,
    };
  }
  if (summary.pending > 0) {
    return {
      stage: "ai_pending",
      detail: `لُخص ${summary.summarized}، وبقي ${summary.pending} خبر ويكمل تلقائيًا`,
    };
  }
  if (summary.failed) {
    return { stage: "ai_failed", detail: `تعذر تلخيص ${summary.failed} خبر بعد المحاولات` };
  }
  return { stage: "completed", detail: `اكتمل التلخيص: ${summary.summarized}` };
}

/** يلخص دفعة صغيرة فقط، ويترك الباقي للطابور أو لمهمة التصريف الدورية. */
async function summarizeBatch(env, mayorId, onProgress = async () => {}) {
  await onProgress("summarizing", "يقرأ الذكاء الاصطناعي نصوص الصفحات المدمجة ويدققها");
  const summary = await translatePending(env, BRIEF_BATCH_SIZE, mayorId);
  const { stage, detail } = briefStage(summary);
  await onProgress(stage, detail);
  return summary;
}

function secondsUntilIso(iso) {
  if (!iso) return 0;
  const at = Date.parse(`${String(iso).replace(" ", "T")}Z`);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

/**
 * الجدولة تتبع أقرب وقت صالح فعلًا. الحد الأدنى الثابت كان يوقظ رسالة كل عشر
 * ثوانٍ بينما لا شيء مؤهل للتنفيذ.
 */
export function continuationDelaySeconds(summary) {
  const requested = Math.max(
    Number(summary?.retryAfterSeconds) || 0,
    secondsUntilIso(summary?.nextAt),
  );
  return Math.min(Math.max(requested, CONTINUATION_MIN_SECONDS), CONTINUATION_MAX_SECONDS);
}

/**
 * لا يُعاد الجدولة إلا حين يكون التقدم ممكنًا قريبًا. أما التأجيل الطويل فلا
 * يستحق إيقاظ اثنتي عشرة رسالة لتصطدم بالحد نفسه.
 */
export function shouldContinueBriefs(summary) {
  if (!summary || summary.pending <= 0 || summary.unconfigured) return false;
  if (!summary.deferred) return true;
  const wait = Math.max(
    Number(summary.retryAfterSeconds) || 0,
    secondsUntilIso(summary.nextAt),
  );
  return wait <= CONTINUATION_DEFER_CEILING;
}

async function enqueueBriefContinuation(env, mayorId, jobId, retryAfterSeconds = 0) {
  if (!env.SCAN_QUEUE) return false;
  await env.SCAN_QUEUE.send(
    { type: "brief", mayorId, jobId },
    { contentType: "json", delaySeconds: continuationDelaySeconds({ retryAfterSeconds }) },
  );
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * مهمة التصريف الدورية: تُكمل الموجزات المعلقة بلا أي تدخل من المستخدم، وتتوقف
 * فور إغلاق الميزانية. هذه هي التي تجعل الرحلة تنتهي من تلقاء نفسها.
 */
export async function drainBriefs(env, { maxBriefs = DRAIN_MAX_BRIEFS, maxMs = DRAIN_MAX_MS } = {}) {
  const startedAt = Date.now();
  const { minIntervalMs } = budgetSettings(env);
  const totals = { summarized: 0, failed: 0, deferred: 0, pending: 0, rounds: 0 };
  while (totals.summarized + totals.failed < maxBriefs && Date.now() - startedAt < maxMs) {
    const summary = await translatePending(env, 1, null);
    totals.rounds += 1;
    totals.summarized += summary.summarized;
    totals.failed += summary.failed;
    totals.deferred += summary.deferred;
    totals.pending = summary.pending;
    if (summary.deferred > 0 || summary.pending === 0) break;
    if (summary.summarized === 0 && summary.failed === 0) break;
    if (minIntervalMs > 0) await sleep(minIntervalMs + 250);
  }
  return totals;
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
  "skippedTopic",
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
    if (shouldContinueBriefs(summary)) {
      await enqueueBriefContinuation(env, mayorId, jobId, summary.retryAfterSeconds);
    }
    if (jobId) {
      const { stage, detail } = briefStage(summary);
      await env.DB.prepare(
        `UPDATE search_job_tasks
         SET stage = ?, detail = ?
         WHERE job_id = ? AND mayor_id = ?`,
      )
        .bind(stage, detail, jobId, mayorId)
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
    const briefSummary = {
      summarized: result.summarized,
      failed: result.aiFailed,
      deferred: result.aiDeferred,
      pending: result.aiPending,
      retryAfterSeconds: result.aiRetryAfterSeconds,
    };
    if (shouldContinueBriefs(briefSummary)) {
      await enqueueBriefContinuation(env, mayorId, jobId, result.aiRetryAfterSeconds);
    }
    if (jobId) {
      const { stage: finalStage, detail: finalDetail } = briefStage(briefSummary);
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
       SUM(CASE WHEN trans_engine = 'brief-deferred' THEN 1 ELSE 0 END) AS waitingQuota,
       SUM(CASE WHEN trans_engine = 'brief-unconfigured' THEN 1 ELSE 0 END) AS unconfigured,
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
    briefDrainCron: "every 10 minutes",
    queue: Boolean(env.SCAN_QUEUE),
    ai: {
      configured: Boolean(env.GEMINI_API_KEY),
      model: env.GEMINI_MODEL || null,
      pending: Number(ai?.pending) || 0,
      waitingQuota: Number(ai?.waitingQuota) || 0,
      unconfigured: Number(ai?.unconfigured) || 0,
      failed: Number(ai?.failed) || 0,
      completed: Number(ai?.completed) || 0,
      retryable: await pendingBriefCount(env),
      maxAttempts: MAX_BRIEF_ATTEMPTS,
      errors: results || [],
      budget: await budgetState(env),
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
    ai: {
      configured: Boolean(env.GEMINI_API_KEY),
      pending: await pendingBriefCount(env),
      budget: await budgetState(env),
    },
    registry: await registrySummary(env),
  };
}

/** كل ما يشرح ما يعمل الآن ولماذا، في مكان واحد يفتحه المستخدم عند الحاجة. */
async function diagnostics(env) {
  const brief = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN trans_engine LIKE 'brief-ai-gemini-v2:%' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN trans_engine = 'brief-pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN trans_engine = 'brief-deferred' THEN 1 ELSE 0 END) AS waitingQuota,
       SUM(CASE WHEN trans_engine = 'brief-ai-error' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN IFNULL(brief_attempts, 0) >= ${MAX_BRIEF_ATTEMPTS} THEN 1 ELSE 0 END) AS exhausted
     FROM items`,
  ).first();
  const { results: errors } = await env.DB.prepare(
    `SELECT brief_error AS code, COUNT(*) AS count, MAX(IFNULL(brief_attempts, 0)) AS attempts
     FROM items WHERE brief_error IS NOT NULL
     GROUP BY brief_error ORDER BY count DESC LIMIT 8`,
  ).all();
  const { results: sources } = await env.DB.prepare(
    `SELECT sources.mayor_id, sources.domain, sources.name, sources.tier, sources.kind,
            sources.rank, sources.last_status, sources.last_items, sources.last_ok_at,
            sources.consecutive_failures, sources.verified, sources.curated_at,
            mayors.name_ar
     FROM sources JOIN mayors ON mayors.id = sources.mayor_id
     ORDER BY sources.mayor_id, sources.rank`,
  ).all();
  const window = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            MIN(COALESCE(published_at, created_at)) AS oldest,
            MAX(COALESCE(published_at, created_at)) AS newest
     FROM items
     WHERE COALESCE(published_at, created_at) >= datetime('now', '-${ITEM_WINDOW_DAYS} days')`,
  ).first();
  const lastScan = await env.DB.prepare(
    `SELECT type, started_at, finished_at, found_count, duplicate_count,
            excluded_count, error_count, notes
     FROM scans ORDER BY started_at DESC LIMIT 1`,
  ).first();
  const registry = await registrySummary(env);
  const budget = await budgetState(env);
  const pageSources = APPROVED_SOURCES.filter((source) => source.kind === "page").length;
  const readerOk = Number(window?.total) > 0 || !lastScan;
  return {
    windowDays: ITEM_WINDOW_DAYS,
    retentionDays: ITEM_RETENTION_DAYS,
    tools: [
      {
        id: "registry",
        name: "سجل المصادر",
        icon: "list",
        ok: registry.failing === 0,
        detail: `${registry.total} نطاقًا معتمدًا · ${registry.perOffice} لكل مكتب · مُتحقق منها بالفحص ${registry.verified}`,
      },
      {
        id: "reader",
        name: "قارئ الصفحات",
        icon: "page",
        ok: readerOk,
        detail: `يفتح كل رابط ويستخرج نص الخبر · ${pageSources} مصدرًا يُقرأ من صفحته لعدم نشره تغذية`,
      },
      {
        id: "ai",
        name: `الذكاء الاصطناعي — ${env.GEMINI_MODEL || "غير محدد"}`,
        icon: "spark",
        ok: Boolean(env.GEMINI_API_KEY) && !budget.blocked,
        detail: Boolean(env.GEMINI_API_KEY)
          ? budget.blocked
            ? `متوقف مؤقتًا · بقي ${budget.remaining} من ${budget.dailyLimit} نداءً`
            : `يقرأ الصفحة ويكتب الموجز بنداء واحد · بقي ${budget.remaining} من ${budget.dailyLimit} نداءً`
          : "المفتاح غير مربوط",
      },
      {
        id: "merge",
        name: "دمج الأحداث",
        icon: "merge",
        ok: Boolean(env.GEMINI_API_KEY),
        detail: `يوحّد تغطية الحدث نفسه عبر اللغات والمنصات · حصته ${budget.mergeLimit} نداءً يوميًا`,
      },
      {
        id: "queue",
        name: "طابور التشغيل",
        icon: "queue",
        ok: Boolean(env.SCAN_QUEUE),
        detail: Boolean(env.SCAN_QUEUE)
          ? "يشغّل البحث في الخلفية فلا تتجمد الصفحة"
          : "غير مربوط — سيعمل البحث داخل الطلب",
      },
      {
        id: "scheduler",
        name: "المجدول التلقائي",
        icon: "clock",
        ok: true,
        detail: "رصد أسبوعي الأحد 06:00 بتوقيت الرياض · تصريف الموجزات كل عشر دقائق",
      },
      {
        id: "database",
        name: "قاعدة البيانات",
        icon: "db",
        ok: true,
        detail: `تحفظ نافذة ${ITEM_WINDOW_DAYS} أيام وتحذف ما بعدها بعد ${ITEM_RETENTION_DAYS} أيام`,
      },
      {
        id: "engines",
        name: "محركات البحث",
        icon: "ban",
        ok: null,
        detail: "معطّلة بالحوكمة — روابط جوجل ملفوفة لا تُقرأ، وبينج يعيد نطاقات غير موثوقة",
      },
    ],
    window: {
      total: Number(window?.total) || 0,
      oldest: window?.oldest || null,
      newest: window?.newest || null,
    },
    brief: {
      completed: Number(brief?.completed) || 0,
      pending: Number(brief?.pending) || 0,
      waitingQuota: Number(brief?.waitingQuota) || 0,
      failed: Number(brief?.failed) || 0,
      exhausted: Number(brief?.exhausted) || 0,
      maxAttempts: MAX_BRIEF_ATTEMPTS,
      errors: errors || [],
    },
    ai: {
      configured: Boolean(env.GEMINI_API_KEY),
      model: env.GEMINI_MODEL || null,
      budget,
    },
    registry,
    sources: sources || [],
    lastScan: lastScan || null,
    queue: Boolean(env.SCAN_QUEUE),
  };
}

async function registrySummary(env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN last_ok_at IS NOT NULL AND IFNULL(consecutive_failures, 0) = 0
                     THEN 1 ELSE 0 END) AS healthy,
            SUM(CASE WHEN IFNULL(consecutive_failures, 0) >= 3 THEN 1 ELSE 0 END) AS failing,
            SUM(CASE WHEN last_checked_at IS NULL THEN 1 ELSE 0 END) AS unchecked,
            SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verified
     FROM sources`,
  ).first();
  return {
    total: Number(row?.total) || 0,
    healthy: Number(row?.healthy) || 0,
    failing: Number(row?.failing) || 0,
    unchecked: Number(row?.unchecked) || 0,
    verified: Number(row?.verified) || 0,
    perOffice: MAX_SOURCES_PER_OFFICE,
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

  if (path === "/api/diagnostics" && method === "GET") {
    return json(await diagnostics(env));
  }

  const retryMatch = path.match(/^\/api\/items\/([0-9a-f-]+)\/retry-brief$/i);
  if (retryMatch && method === "POST") {
    await env.DB.prepare(
      `UPDATE items
       SET brief_attempts = 0, brief_error = NULL, brief_attempted_at = NULL,
           brief_claim_id = NULL, brief_claimed_at = NULL, trans_engine = 'brief-pending'
       WHERE id = ?`,
    )
      .bind(retryMatch[1])
      .run();
    const summary = await translatePending(env, 1, null);
    if (shouldContinueBriefs(summary)) await enqueueBriefContinuation(env, null, null);
    return json({ ok: true, ai: summary });
  }

  if (path === "/api/sources" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT sources.*, mayors.name_ar, mayors.city_ar
       FROM sources JOIN mayors ON mayors.id = sources.mayor_id
       ORDER BY sources.mayor_id, sources.rank`,
    ).all();
    return json({ sources: results || [], perOffice: MAX_SOURCES_PER_OFFICE });
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
    const clauses = [
      "status = ?",
      `COALESCE(items.published_at, items.created_at) >= datetime('now', '-${ITEM_WINDOW_DAYS} days')`,
    ];
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
    if (shouldContinueBriefs(summary)) await enqueueBriefContinuation(env, mayorId, null);
    return json({ ok: true, ...result, ai: summary });
  }

  if (path === "/api/briefs/drain" && method === "POST") {
    const drained = await drainBriefs(env);
    return json({ ok: true, ...drained, budget: await budgetState(env) });
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

  async scheduled(event, env, ctx) {
    if (event?.cron === WEEKLY_CRON) {
      ctx.waitUntil(enqueueAllOffices(env));
      return;
    }
    ctx.waitUntil(
      (async () => {
        await ensureDb(env);
        await pruneAiBudget(env);
        await pruneOldItems(env);
        await drainBriefs(env);
      })(),
    );
  },

  async queue(batch, env) {
    await ensureDb(env);
    for (const message of batch.messages) {
      await processQueuedSearch(env, message);
    }
  },
};
