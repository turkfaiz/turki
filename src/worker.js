import {
  MAYORS,
  insertCustomMayor,
  listMayors,
  mayorInputMessage,
  parseMayorInput,
  resolveMayor,
} from "./mayors.js";
import { runScan, sourceStatus } from "./collect.js";
import {
  enabledSources,
  fetchCandidateBatch,
  pendingCandidateBacklog,
  pendingCandidateCount,
  pendingFetchIds,
  persistSourcePollOutcome,
  pollOneSource,
} from "./pipeline.js";
import {
  ARTICLE_FETCH_BATCH,
  INLINE_ARTICLE_FETCH_LIMIT,
  platformLabelAr,
  sourceById,
  strategyLabelAr,
} from "./sources.js";
import {
  MAX_BRIEF_ATTEMPTS,
  assignPendingLanes,
  briefBacklog,
  pendingBriefCount,
  slotsWithCapacity,
  translatePending,
  verifyPending,
} from "./translate.js";
import {
  aggregateSlotBudget,
  boundSlotWaitMs,
  providerLaneSnapshot,
  slotRuntimeStatuses,
} from "./aiDispatch.js";
import { pruneAiBudget } from "./aiBudget.js";
import { APPROVED_SOURCES, MAX_SOURCES_PER_OFFICE } from "./sources.js";
import {
  currentVersion,
  decisionsFor,
  isReadyForApproval,
  migrateVersions,
  protectedItemsSql,
  recordDecision,
  verificationBacklog,
} from "./versions.js";
import {
  applyDeskLaneMigration,
  attentionReasonCaseSql,
  deskLaneCaseSql,
  deskLanePredicateSql,
  deskLaneStatSql,
  DISPLAY_WINDOW_DAYS,
  inDisplayWindowSql,
  planDeskLaneMigration,
  publicLaneStats,
  resolveDeskQuery,
} from "./deskLanes.js";
import { assessMayorJourney, resolveScanId } from "./journey.js";
import { PUBLISHERS } from "./publishers.js";
import { reviewInbox } from "./reviewAgent.js";
import { REASON } from "./reasons.js";
import { anyAiKey, aiBriefEnabled } from "./aiProviders.js";
import {
  claimDeskRun,
  claimSourcePoll,
  DESK_RUN_LOCKS_INDEX,
  DESK_RUN_LOCKS_TABLE,
  dueSourcePolls,
  groupCandidatesForEnqueue,
  isPermanentSourceFailure,
  isTerminalSourceStatus,
  MAX_SOURCE_POLL_ATTEMPTS,
  readScanSource,
  releaseDeskRun,
  sourcePollBackoffSeconds,
  sourcePollRetryDelaySeconds,
} from "./leases.js";

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
    brief_provider TEXT,
    desk_lane TEXT,
    desk_attention_reason TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_items_mayor ON items(mayor_id)`,
  `CREATE INDEX IF NOT EXISTS idx_items_brief_lane ON items(brief_provider, trans_engine)`,
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
    consecutive_failures INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    connect_status TEXT,
    http_status INTEGER,
    parse_status TEXT,
    discovered_count INTEGER DEFAULT 0,
    new_count INTEGER DEFAULT 0,
    read_count INTEGER DEFAULT 0,
    relevant_count INTEGER DEFAULT 0,
    last_success_at TEXT,
    last_discovery_at TEXT,
    last_fresh_at TEXT,
    fail_reason TEXT,
    last_strategy TEXT,
    last_discovered_url TEXT,
    etag TEXT,
    last_modified TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sources_mayor ON sources(mayor_id, rank)`,
  `CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    mayor_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    scan_id TEXT,
    url TEXT NOT NULL,
    canonical_url TEXT,
    title TEXT,
    snippet TEXT,
    published_at TEXT,
    discovered_at TEXT NOT NULL,
    discovery_type TEXT,
    stage TEXT NOT NULL DEFAULT 'candidate_discovered',
    fetch_status TEXT NOT NULL DEFAULT 'pending',
    http_status INTEGER,
    skip_reason TEXT,
    etag TEXT,
    last_modified TEXT,
    fetched_at TEXT,
    attempts INTEGER DEFAULT 0,
    fetch_claim_id TEXT,
    fetch_claimed_at TEXT,
    fetch_after TEXT,
    last_error TEXT
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_source_url ON candidates(source_id, url)`,
  `CREATE INDEX IF NOT EXISTS idx_candidates_fetch ON candidates(fetch_status, mayor_id)`,
  `CREATE TABLE IF NOT EXISTS settings_audit (
    id TEXT PRIMARY KEY,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    source_id TEXT,
    mayor_id TEXT,
    before_json TEXT,
    after_json TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS scan_sources (
    scan_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    mayor_id TEXT NOT NULL,
    job_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    detail TEXT,
    claim_id TEXT,
    claimed_at TEXT,
    attempts INTEGER DEFAULT 0,
    next_attempt_at TEXT,
    last_error TEXT,
    PRIMARY KEY (scan_id, source_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_scan_sources_lease ON scan_sources(status, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_candidates_fetch_lease ON candidates(fetch_status, fetch_after, fetch_claimed_at)`,
  DESK_RUN_LOCKS_TABLE,
  DESK_RUN_LOCKS_INDEX,
  `CREATE TABLE IF NOT EXISTS ai_budget (
    day TEXT PRIMARY KEY,
    calls INTEGER NOT NULL DEFAULT 0,
    last_call_at TEXT,
    blocked_until TEXT,
    block_reason TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS ai_provider_budget (
    day TEXT NOT NULL,
    provider TEXT NOT NULL,
    calls INTEGER NOT NULL DEFAULT 0,
    last_call_at TEXT,
    blocked_until TEXT,
    block_reason TEXT,
    PRIMARY KEY (day, provider)
  )`,
  `CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
  )`,
];

const bootstrapped = new WeakSet();
const BOOTSTRAP_VERSION = "bootstrap-v20";

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

async function migrateAiProviderBudget(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ai_provider_budget (
      day TEXT NOT NULL,
      provider TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      last_call_at TEXT,
      blocked_until TEXT,
      block_reason TEXT,
      PRIMARY KEY (day, provider)
    )`,
  ).run();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO ai_provider_budget
       (day, provider, calls, last_call_at, blocked_until, block_reason)
     SELECT day, 'gemini', calls, last_call_at, blocked_until, block_reason
     FROM ai_budget`,
  ).run();
}

const REQUIRED_TABLES = [
  "mayors",
  "items",
  "scans",
  "search_jobs",
  "search_job_tasks",
  "publishers",
  "sources",
  "candidates",
  "settings_audit",
  "scan_sources",
  "ai_budget",
  "ai_provider_budget",
  "brief_versions",
  "approvals",
];

/**
 * الاعتماد على ختم النسخة وحده يفترض أن كل تغيير في المخطط رفع الختم. حين
 * يُنسى ذلك تعمل القاعدة الفارغة وتنكسر القاعدة القائمة. فحص وجود الجداول
 * يجعل التهيئة تشفي نفسها بدل أن تثق بافتراض.
 */
async function schemaComplete(env) {
  const placeholders = REQUIRED_TABLES.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sqlite_master
     WHERE type = 'table' AND name IN (${placeholders})`,
  )
    .bind(...REQUIRED_TABLES)
    .first();
  return Number(row?.n) === REQUIRED_TABLES.length;
}

export async function ensureDb(env) {
  if (bootstrapped.has(env.DB)) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`).run();
  const stamp = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'bootstrap_version'`).first();
  if (stamp?.v === BOOTSTRAP_VERSION && (await schemaComplete(env))) {
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
  await migrateAiProviderBudget(env);
  await migrateVersions(env);
  await applyDeskLaneMigration(env, { dryRun: false });
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('bootstrap_version', ?)`)
    .bind(BOOTSTRAP_VERSION)
    .run();
  bootstrapped.add(env.DB);
}

/**
 * الشيفرة بذرة أولية للسجل. الجدول يحتفظ بصفوف أُضيفت خارج البذرة، ولا يُحذف
 * مصدر في bootstrap حتى لا يضيع تاريخ مكتب مضاف من الإعدادات.
 */
/**
 * إنشاء الجدول لا يضيف أعمدة لجدول قائم، فأي عمود جديد يحتاج ترحيلًا صريحًا
 * وإلا فشل الزرع في الإنتاج بينما يمر على قاعدة فارغة.
 */
async function migrateSources(env) {
  const info = await env.DB.prepare(`PRAGMA table_info(sources)`).all();
  const names = new Set((info.results || []).map((column) => column.name));
  if (!names.size) return;
  const add = async (column, sql) => {
    if (!names.has(column)) await env.DB.prepare(sql).run();
  };
  await add("verified", `ALTER TABLE sources ADD COLUMN verified INTEGER DEFAULT 0`);
  await add("curated_at", `ALTER TABLE sources ADD COLUMN curated_at TEXT`);
  await add("last_checked_at", `ALTER TABLE sources ADD COLUMN last_checked_at TEXT`);
  await add("last_ok_at", `ALTER TABLE sources ADD COLUMN last_ok_at TEXT`);
  await add("last_status", `ALTER TABLE sources ADD COLUMN last_status TEXT`);
  await add("last_items", `ALTER TABLE sources ADD COLUMN last_items INTEGER DEFAULT 0`);
  await add("consecutive_failures", `ALTER TABLE sources ADD COLUMN consecutive_failures INTEGER DEFAULT 0`);
  await add("enabled", `ALTER TABLE sources ADD COLUMN enabled INTEGER DEFAULT 1`);
  await add("connect_status", `ALTER TABLE sources ADD COLUMN connect_status TEXT`);
  await add("http_status", `ALTER TABLE sources ADD COLUMN http_status INTEGER`);
  await add("parse_status", `ALTER TABLE sources ADD COLUMN parse_status TEXT`);
  await add("discovered_count", `ALTER TABLE sources ADD COLUMN discovered_count INTEGER DEFAULT 0`);
  await add("new_count", `ALTER TABLE sources ADD COLUMN new_count INTEGER DEFAULT 0`);
  await add("read_count", `ALTER TABLE sources ADD COLUMN read_count INTEGER DEFAULT 0`);
  await add("relevant_count", `ALTER TABLE sources ADD COLUMN relevant_count INTEGER DEFAULT 0`);
  await add("last_success_at", `ALTER TABLE sources ADD COLUMN last_success_at TEXT`);
  await add("last_discovery_at", `ALTER TABLE sources ADD COLUMN last_discovery_at TEXT`);
  await add("last_fresh_at", `ALTER TABLE sources ADD COLUMN last_fresh_at TEXT`);
  await add("fail_reason", `ALTER TABLE sources ADD COLUMN fail_reason TEXT`);
  await add("last_strategy", `ALTER TABLE sources ADD COLUMN last_strategy TEXT`);
  await add("last_discovered_url", `ALTER TABLE sources ADD COLUMN last_discovered_url TEXT`);
  await add("etag", `ALTER TABLE sources ADD COLUMN etag TEXT`);
  await add("last_modified", `ALTER TABLE sources ADD COLUMN last_modified TEXT`);
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
  /**
   * السجل في الشيفرة بذرة فقط. صف أُضيف من الإعدادات أو بقي من نسخة أقدم
   * لا يُحذف هنا؛ إخراجه من الرصد يتم بتعطيله لاحقًا لا بالمسح.
   */
}

/** يسجّل ما حدث فعلًا لكل مصدر حتى تكون الحوكمة مبنية على واقع الإنتاج. */
/**
 * المكتب أسبوعي، فلا معنى لتخزين ما خرج من النافذة. التقليم يمنع تراكم أخبار
 * قديمة تظهر في القوائم وتشوّه الإحصاءات.
 */
export async function pruneOldItems(env, days = ITEM_RETENTION_DAYS) {
  /**
   * نافذة الرصد للعرض، أما القرارات فأرشيف. أي خبر يحمل قرارًا محفوظًا يبقى
   * هو وأدلته ونسخه، وإلا صار الأرشيف رهينة نافذة سبعة أيام.
   */
  const result = await env.DB.prepare(
    `DELETE FROM items
     WHERE COALESCE(published_at, created_at) < datetime('now', ?)
       AND NOT ${protectedItemsSql()}
       AND status <> 'approved'`,
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
         last_success_at = CASE WHEN ? THEN datetime('now') ELSE last_success_at END,
         last_discovery_at = CASE WHEN ? > 0 THEN datetime('now') ELSE last_discovery_at END,
         last_fresh_at = CASE WHEN ? > 0 THEN datetime('now') ELSE last_fresh_at END,
         last_status = ?, last_items = ?,
         connect_status = ?, http_status = ?, parse_status = ?,
         discovered_count = ?, new_count = ?,
         fail_reason = ?, last_strategy = ?, last_discovered_url = ?,
         etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
         consecutive_failures = CASE WHEN ? THEN 0 ELSE IFNULL(consecutive_failures, 0) + 1 END
     WHERE id = ?`,
  );
  for (let i = 0; i < rows.length; i += 20) {
    await env.DB.batch(
      rows.slice(i, i + 20).map((row) => {
        const ok = Boolean(row.ok);
        const discovered = Number(row.discovered ?? row.items) || 0;
        const fresh = Number(row.new_count) || 0;
        return stmt.bind(
          ok ? 1 : 0,
          ok ? 1 : 0,
          discovered,
          fresh,
          String(row.status || "").slice(0, 160),
          Number(row.items) || 0,
          String(row.connect_status || row.status || "").slice(0, 80),
          row.http_status ?? null,
          String(row.parse_status || "").slice(0, 80),
          discovered,
          fresh,
          String(row.fail_reason || "").slice(0, 160),
          String(row.last_strategy || "").slice(0, 40),
          String(row.last_discovered_url || "").slice(0, 500),
          row.etag || null,
          row.last_modified || null,
          ok ? 1 : 0,
          row.id,
        );
      }),
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
  if (!names.has("brief_provider")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN brief_provider TEXT`).run();
  }
  if (!names.has("desk_lane")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN desk_lane TEXT`).run();
  }
  if (!names.has("desk_attention_reason")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN desk_attention_reason TEXT`).run();
  }
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_items_brief_lane ON items(brief_provider, trans_engine)`,
  ).run();
  await env.DB.prepare(`DROP INDEX IF EXISTS idx_items_desk_lane`).run();
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
  /**
   * حد طلبات العامل وألقاب غير المسندة أُغلقت كتعذر نهائي بينما المشكلة في
   * التشغيل أو في نموذج واحد. تُعاد للتوزيع على الفتحات الحية.
   */
  const dispatchEpoch = "lane-dispatch-v1";
  const currentDispatch = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'dispatch_epoch'`).first();
  if (currentDispatch?.v !== dispatchEpoch) {
    await env.DB.prepare(
      `UPDATE items
       SET brief_attempts = 0, brief_error = NULL, brief_attempted_at = NULL,
           brief_claim_id = NULL, brief_claimed_at = NULL, brief_provider = NULL,
           brief_after = NULL, trans_engine = 'brief-pending',
           title_ar = 'بانتظار قراءة الذكاء الاصطناعي — ' ||
             COALESCE((SELECT name_ar FROM mayors WHERE mayors.id = items.mayor_id), mayor_id),
           snippet_ar = ''
       WHERE trans_engine IN ('brief-ai-error', 'brief-deferred', 'brief-working')
          OR brief_error LIKE '%subrequest%'
          OR brief_error LIKE '%Too many%'
          OR brief_error LIKE '%Worker invocation%'
          OR brief_error LIKE 'ai_ungrounded%'
          OR brief_error LIKE 'ai_has_no_grounded%'`,
    ).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('dispatch_epoch', ?)`)
      .bind(dispatchEpoch)
      .run();
  }
  /**
   * 402/400 من ديبسيك أو كوين ليسا عيب الصفحة. حُسبتا محاولة وأُغلق الخبر.
   * بعد اعتبارها عطل فتحة تُعاد الصفوف لتقرأها النماذج العاملة.
   */
  const slotFaultEpoch = "provider-slot-fault-v1";
  const currentSlotFault = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'slot_fault_epoch'`).first();
  if (currentSlotFault?.v !== slotFaultEpoch) {
    await env.DB.prepare(
      `UPDATE items
       SET brief_attempts = 0, brief_error = NULL, brief_attempted_at = NULL,
           brief_claim_id = NULL, brief_claimed_at = NULL, brief_provider = NULL,
           brief_after = NULL, trans_engine = 'brief-pending',
           title_ar = 'بانتظار قراءة الذكاء الاصطناعي — ' ||
             COALESCE((SELECT name_ar FROM mayors WHERE mayors.id = items.mayor_id), mayor_id),
           snippet_ar = ''
       WHERE trans_engine = 'brief-ai-error'
         AND (brief_error LIKE 'ai_http_40%'
           OR brief_error LIKE 'ai_ungrounded%'
           OR brief_error LIKE 'ai_has_no_grounded%')`,
    ).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('slot_fault_epoch', ?)`)
      .bind(slotFaultEpoch)
      .run();
  }
}

const ITEM_FIELDS = `items.id, items.mayor_id, items.scan_id, items.source, items.title,
  items.title_ar AS news_title_ar, items.snippet, items.snippet_ar AS news_snippet_ar,
  items.title_normalized, items.url, items.published_at, items.language, items.confidence,
  items.status, items.exclude_reason, items.fingerprint, items.created_at, items.trans_engine,
  items.publisher_domain, items.publisher_tier, items.merged_sources, items.source_count,
  items.brief_evidence, items.brief_error, items.brief_attempted_at, items.brief_attempts,
  items.brief_provider, items.current_version_id, items.approved_version_id, items.needs_review,
  (SELECT verify_state FROM brief_versions
    WHERE brief_versions.id = items.current_version_id) AS verify_state,
  (SELECT verify_detail FROM brief_versions
    WHERE brief_versions.id = items.current_version_id) AS verify_detail,
  ${deskLaneCaseSql("items")} AS desk_lane,
  ${attentionReasonCaseSql("items")} AS attention_reason,
  mayors.name_ar, mayors.name_en, mayors.name_native, mayors.city_ar, mayors.country_ar,
  mayors.title_ar AS office_ar, mayors.title_en, mayors.official_host, mayors.native_lang_ar`;

const WEEKLY_CRON = "0 3 * * SUN";
/** نافذة الرصد سبعة أيام، ويُحفظ يومان إضافيان لاستقرار الترحيل. */
const ITEM_WINDOW_DAYS = DISPLAY_WINDOW_DAYS;
const ITEM_RETENTION_DAYS = 9;
const BRIEF_BATCH_SIZE = 3;
const DRAIN_MAX_BRIEFS = 8;
const DRAIN_MAX_MS = 40000;
const CONTINUATION_MIN_SECONDS = 10;
const CONTINUATION_MAX_SECONDS = 900;
/** التأجيل الطويل (كنفاد حصة اليوم) يُترك لمهمة التصريف الدورية لا للطابور. */
const CONTINUATION_DEFER_CEILING = 300;

/**
 * جمع الصفحات منفصل عن القراءة. خلطهما في نفس تشغيل العامل يستنفد حد
 * الطلبات الخمسين فيتوقف النداء ويُسجَّل اعتذارًا على الخبر.
 */
async function finishDesk(env, scanOpts, onProgress = async () => {}) {
  const result = await runScan(env, scanOpts, onProgress);
  await recordSourceHealth(env, result.sourceHealth);
  await onProgress("merging", "يدمج التغطيات المتكررة للحدث نفسه");
  const review = await reviewInbox(env, {
    mayorId: scanOpts.mayorId || null,
    limit: 500,
    useAiMerge: false,
  });
  await onProgress("assigning", "يوزّع الأخبار على نماذج القراءة");
  const lanes = await assignPendingLanes(env, scanOpts.mayorId || null);
  const backlog = await briefBacklog(env, scanOpts.mayorId || null);
  return {
    ...result,
    review,
    assigned: lanes.assigned,
    summarized: 0,
    aiFailed: 0,
    aiDeferred: 0,
    aiPending: backlog.pending,
    aiRetryAfterSeconds: 0,
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

async function enqueueBriefPump(env, { jobId = null, delaySeconds = 0 } = {}) {
  if (!env.SCAN_QUEUE) return false;
  await env.SCAN_QUEUE.send(
    { type: "brief", mayorId: null, jobId },
    { contentType: "json", delaySeconds: Math.max(0, Number(delaySeconds) || 0) },
  );
  return true;
}

async function enqueueBriefContinuation(env, mayorId, jobId, retryAfterSeconds = 0) {
  return enqueueBriefPump(env, {
    jobId,
    delaySeconds: continuationDelaySeconds({ retryAfterSeconds }),
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * مهمة التصريف الدورية: تُكمل الموجزات المعلقة بلا أي تدخل من المستخدم، وتتوقف
 * فور إغلاق الميزانية. هذه هي التي تجعل الرحلة تنتهي من تلقاء نفسها.
 */
export async function drainBriefs(env, { maxBriefs = DRAIN_MAX_BRIEFS, maxMs = DRAIN_MAX_MS } = {}) {
  const startedAt = Date.now();
  const totals = {
    summarized: 0,
    failed: 0,
    deferred: 0,
    verified: 0,
    rejected: 0,
    pending: 0,
    rounds: 0,
  };
  await assignPendingLanes(env);
  while (totals.summarized + totals.failed < maxBriefs && Date.now() - startedAt < maxMs) {
    const ready = await slotsWithCapacity(env, "brief");
    const batch = Math.max(1, Math.min(BRIEF_BATCH_SIZE, ready.length || 1));
    const summary = await translatePending(env, batch, null);
    const checked = await verifyPending(env, batch);
    totals.verified += checked.verified;
    totals.rejected += checked.rejected;
    totals.rounds += 1;
    totals.summarized += summary.summarized;
    totals.failed += summary.failed;
    totals.deferred += summary.deferred;
    totals.pending = summary.pending;
    if (summary.pending === 0 && checked.pending === 0) break;
    const still = await slotsWithCapacity(env, "brief");
    if (still.length) continue;
    const waitMs = boundSlotWaitMs(env);
    if (Date.now() - startedAt + waitMs >= maxMs) {
      if (summary.pending > 0 || checked.pending > 0) {
        await enqueueBriefPump(env, { delaySeconds: Math.max(1, Math.ceil(waitMs / 1000)) });
      }
      break;
    }
    await sleep(waitMs + 250);
  }
  await refreshOpenSearchJobs(env);
  return totals;
}

async function enqueueSourcePolls(env, { mayorIds, type, query = "", jobId = null, scanId = null }) {
  const id = scanId || crypto.randomUUID();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO scans (id, type, query, mayor_id, started_at, found_count, duplicate_count, excluded_count, error_count)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)`,
  )
    .bind(id, type, query || null, mayorIds.length === 1 ? mayorIds[0] : null, new Date().toISOString())
    .run();

  const messages = [];
  for (const mayorId of mayorIds) {
    const sources = await enabledSources(env, mayorId);
    if (!sources.length) {
      if (jobId) {
        await env.DB.prepare(
          `UPDATE search_job_tasks
           SET status = 'completed', finished_at = datetime('now'),
               stage = 'completed', detail = 'لا منصات رصد مفعّلة لهذا المكتب',
               result_json = ?, error = NULL
           WHERE job_id = ? AND mayor_id = ?`,
        )
          .bind(JSON.stringify({ found: 0, pendingCandidates: 0 }), jobId, mayorId)
          .run();
        await refreshSearchJobStatus(env, jobId);
      }
      continue;
    }
    const insert = env.DB.prepare(
      `INSERT INTO scan_sources (scan_id, source_id, mayor_id, job_id, status, detail, attempts)
       VALUES (?, ?, ?, ?, 'queued', 'بانتظار فحص المصدر', 0)
       ON CONFLICT(scan_id, source_id) DO NOTHING`,
    );
    await env.DB.batch(
      sources.map((source) => insert.bind(id, source.id, mayorId, jobId)),
    );
    for (const source of sources) {
      messages.push({
        body: { type: "source_poll", mayorId, sourceId: source.id, scanId: id, jobId, query },
        contentType: "json",
      });
    }
  }
  for (let i = 0; i < messages.length; i += 100) {
    await env.SCAN_QUEUE.sendBatch(messages.slice(i, i + 100));
  }
  return { scanId: id, queued: messages.length };
}

async function enqueueArticleFetches(env, { ids = [], mayorId, scanId, jobId, delaySeconds = 0 } = {}) {
  if (!env.SCAN_QUEUE) return 0;
  const delay = Math.max(0, Number(delaySeconds) || 0);
  const chunks = ids.length ? [] : [[]];
  for (let i = 0; i < ids.length; i += ARTICLE_FETCH_BATCH) {
    chunks.push(ids.slice(i, i + ARTICLE_FETCH_BATCH));
  }
  const batches = chunks.map((candidateIds) => ({
    body: {
      type: "article_fetch",
      mayorId,
      scanId,
      jobId,
      candidateIds,
    },
    contentType: "json",
    delaySeconds: delay,
  }));
  for (let i = 0; i < batches.length; i += 100) {
    await env.SCAN_QUEUE.sendBatch(batches.slice(i, i + 100));
  }
  return batches.length;
}

async function persistMayorJourney(env, { mayorId, jobId, scanId = null, result = null }) {
  if (!jobId || !mayorId) return null;
  const resolvedScanId = await resolveScanId(env, { jobId, mayorId, scanId });
  const assessment = await assessMayorJourney(env, { mayorId, scanId: resolvedScanId });
  const previous = parseTaskResult(
    (
      await env.DB.prepare(
        `SELECT result_json FROM search_job_tasks WHERE job_id = ? AND mayor_id = ?`,
      )
        .bind(jobId, mayorId)
        .first()
    )?.result_json,
  );
  const merged = {
    ...previous,
    ...(result || {}),
    scanId: resolvedScanId || previous.scanId || result?.scanId || null,
    journey: {
      stage: assessment.stage,
      reading: assessment.reading,
      verifying: assessment.verifying,
      settled: assessment.settled,
      total: assessment.total,
      resumeAt: assessment.resumeAt,
    },
  };
  const terminal = assessment.status === "completed";
  await env.DB.prepare(
    `UPDATE search_job_tasks
     SET status = ?,
         stage = ?,
         detail = ?,
         finished_at = CASE WHEN ? THEN datetime('now') ELSE NULL END,
         result_json = ?,
         error = NULL
     WHERE job_id = ? AND mayor_id = ?
       AND IFNULL(status, '') <> 'failed'`,
  )
    .bind(
      assessment.status,
      assessment.stage,
      String(assessment.detail || "").slice(0, 300),
      terminal ? 1 : 0,
      JSON.stringify(merged),
      jobId,
      mayorId,
    )
    .run();
  await refreshSearchJobStatus(env, jobId);
  return assessment;
}

async function refreshJobJourney(env, jobId) {
  if (!jobId) return;
  const { results: tasks } = await env.DB.prepare(
    `SELECT mayor_id FROM search_job_tasks
     WHERE job_id = ? AND status NOT IN ('completed', 'failed')`,
  )
    .bind(jobId)
    .all();
  for (const task of tasks || []) {
    await persistMayorJourney(env, { mayorId: task.mayor_id, jobId });
  }
}

async function refreshOpenSearchJobs(env) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT job_id FROM search_job_tasks
     WHERE status IN ('running', 'waiting', 'retrying')`,
  ).all();
  for (const row of results || []) {
    await refreshJobJourney(env, row.job_id);
  }
}

function earliestIso(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return left < right ? left : right;
}

export async function completeMayorDesk(env, { mayorId, jobId, scanId }) {
  const review = await reviewInbox(env, { mayorId, limit: 500, useAiMerge: false });
  const lanes = await assignPendingLanes(env, mayorId);
  const backlog = await briefBacklog(env, mayorId);
  const verify = await verificationBacklog(env);
  const pending = await pendingCandidateCount(env, mayorId, scanId);
  const foundRow = scanId
    ? await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM items WHERE scan_id = ? AND mayor_id = ?`,
      )
        .bind(scanId, mayorId)
        .first()
    : { n: 0 };
  const result = {
    found: Number(foundRow?.n) || 0,
    review,
    assigned: lanes.assigned,
    aiPending: backlog.pending,
    pendingCandidates: pending,
    scanId: scanId || null,
  };
  const assessment = jobId
    ? await persistMayorJourney(env, { mayorId, jobId, scanId, result })
    : await assessMayorJourney(env, { mayorId, scanId });
  if (assessment?.status !== "completed") {
    const ready = await slotsWithCapacity(env, "brief");
    const pendingWork = (backlog.pending || 0) + (verify.pending || 0);
    if (ready.length && ((backlog.eligible || 0) > 0 || (verify.eligible || 0) > 0)) {
      await enqueueBriefPump(env, { jobId, delaySeconds: 0 });
    } else if (
      shouldContinueBriefs({
        pending: pendingWork,
        deferred: assessment?.blocked ? 1 : 0,
        nextAt: assessment?.resumeAt || backlog.nextAt || verify.nextAt,
      })
    ) {
      await enqueueBriefPump(env, {
        jobId,
        delaySeconds: continuationDelaySeconds({
          nextAt: assessment?.resumeAt || backlog.nextAt || verify.nextAt,
        }),
      });
    }
  }
  return {
    review,
    assigned: lanes.assigned,
    aiPending: backlog.pending,
    journey: assessment,
  };
}

export async function maybeFinishMayor(env, { mayorId, jobId, scanId }) {
  const polls = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN status IN ('polled', 'failed') THEN 1 ELSE 0 END) AS done
     FROM scan_sources WHERE scan_id = ? AND mayor_id = ?`,
  )
    .bind(scanId, mayorId)
    .first();
  if (!polls?.n || Number(polls.done) < Number(polls.n)) return { done: false };
  const backlog = await pendingCandidateBacklog(env, mayorId, scanId, {
    limit: ARTICLE_FETCH_BATCH * 8,
  });
  if (backlog.pending > 0) {
    if (backlog.ids.length) {
      if (env.SCAN_QUEUE) await enqueueArticleFetches(env, { ids: backlog.ids, mayorId, scanId, jobId });
      else await fetchCandidateBatch(env, { ids: backlog.ids, mayorId, scanId, limit: INLINE_ARTICLE_FETCH_LIMIT });
    } else if (backlog.nextAt && env.SCAN_QUEUE) {
      await enqueueArticleFetches(env, {
        ids: [],
        mayorId,
        scanId,
        jobId,
        delaySeconds: continuationDelaySeconds({ nextAt: backlog.nextAt }),
      });
    }
    return { done: false, pending: backlog.pending, nextAt: backlog.nextAt };
  }
  await completeMayorDesk(env, { mayorId, jobId, scanId });
  await releaseDeskRun(env, { mayorId, jobId, scanId });
  return { done: true };
}

export async function processSourcePollMessage(env, message, extra = {}) {
  const body = message.body || {};
  const { mayorId, sourceId, scanId, jobId, query } = body;
  if (!mayorId || !sourceId || !scanId) {
    message.ack();
    return { kind: "ignored" };
  }

  const claimed = await claimSourcePoll(env, { scanId, sourceId, mayorId });
  if (!claimed) {
    const row = await readScanSource(env, scanId, sourceId);
    if (isTerminalSourceStatus(row?.status)) {
      message.ack();
      return { kind: "noop", status: row.status };
    }
    message.retry({ delaySeconds: sourcePollRetryDelaySeconds(row) });
    return { kind: "retry_later", status: row?.status || "missing" };
  }

  if (typeof extra.afterClaim === "function") await extra.afterClaim(claimed);

  if (jobId) {
    await env.DB.prepare(
      `UPDATE search_job_tasks
       SET status = 'running', stage = 'source_poll',
           detail = ?, started_at = COALESCE(started_at, datetime('now'))
       WHERE job_id = ? AND mayor_id = ?
         AND EXISTS (
           SELECT 1 FROM scan_sources
           WHERE scan_id = ? AND source_id = ? AND claim_id = ?
         )`,
    )
      .bind(`يفحص المصدر ${sourceId}`, jobId, mayorId, scanId, sourceId, claimed.claim_id)
      .run();
  }

  const finishOwned = async (completion) => {
    const mayor = await resolveMayor(env, mayorId);
    const source = sourceById(sourceId);
    const outcome = await persistSourcePollOutcome(env, claimed, {
      mayor,
      source,
      scanId,
      rows: completion.rows || [],
      health: completion.health || {},
      completion: {
        status: completion.status,
        detail: completion.detail,
        lastError: completion.lastError || null,
        delaySeconds: completion.delaySeconds,
      },
    });
    if (!outcome.wrote) {
      message.ack();
      return { kind: "stale_claim", wrote: false };
    }
    if (completion.status === "polled" && outcome.newIds.length) {
      if (env.SCAN_QUEUE) {
        await enqueueArticleFetches(env, { ids: outcome.newIds, mayorId, scanId, jobId });
      } else {
        await fetchCandidateBatch(env, {
          ids: outcome.newIds,
          mayorId,
          scanId,
          limit: ARTICLE_FETCH_BATCH,
          fetch: extra.fetch,
        });
      }
    }
    if (completion.status === "retrying") {
      message.retry({ delaySeconds: completion.delaySeconds || sourcePollRetryDelaySeconds({ attempts: claimed.attempts }) });
      return { kind: "retrying", wrote: true, lastError: completion.lastError };
    }
    await maybeFinishMayor(env, { mayorId, jobId, scanId });
    message.ack();
    return { kind: completion.status, wrote: true, lastError: completion.lastError };
  };

  try {
    const polled = await pollOneSource(env, {
      sourceId,
      mayorId,
      scanId,
      query,
      fetch: extra.fetch,
      persist: false,
    });
    if (polled.health?.ok) {
      return finishOwned({
        status: "polled",
        detail: String(polled.health.status || "ok").slice(0, 160),
        health: { ...polled.health, id: sourceId },
        rows: polled.rows || [],
      });
    }

    const failReason = polled.health?.fail_reason || polled.health?.status || "poll_failed";
    if (
      isPermanentSourceFailure(polled.health) ||
      Number(claimed.attempts) >= MAX_SOURCE_POLL_ATTEMPTS
    ) {
      return finishOwned({
        status: "failed",
        detail: String(failReason).slice(0, 160),
        lastError: failReason,
        health: { ...polled.health, id: sourceId },
      });
    }
    return finishOwned({
      status: "retrying",
      detail: String(failReason).slice(0, 160),
      lastError: failReason,
      health: { ...polled.health, id: sourceId },
      delaySeconds: sourcePollBackoffSeconds(claimed.attempts),
    });
  } catch (error) {
    const lastError = String(error?.message || error || claimed.last_error || "poll_failed").slice(0, 300);
    if (Number(claimed.attempts) >= MAX_SOURCE_POLL_ATTEMPTS || isPermanentSourceFailure({ fail_reason: lastError })) {
      return finishOwned({
        status: "failed",
        detail: lastError.slice(0, 160),
        lastError,
        health: { id: sourceId, ok: false, status: "exception", fail_reason: lastError },
      });
    }
    return finishOwned({
      status: "retrying",
      detail: lastError.slice(0, 160),
      lastError,
      health: { id: sourceId, ok: false, status: "exception", fail_reason: lastError },
      delaySeconds: sourcePollBackoffSeconds(claimed.attempts),
    });
  }
}

export async function processArticleFetchMessage(env, message, extra = {}) {
  const body = message.body || {};
  const { mayorId, scanId, jobId, candidateIds } = body;
  if (jobId && mayorId) {
    await env.DB.prepare(
      `UPDATE search_job_tasks
       SET status = 'running', stage = 'article_fetch', detail = 'يفتح المقالات المكتشفة'
       WHERE job_id = ? AND mayor_id = ?`,
    )
      .bind(jobId, mayorId)
      .run();
  }
  try {
    await fetchCandidateBatch(env, {
      ids: candidateIds || [],
      mayorId,
      scanId,
      limit: ARTICLE_FETCH_BATCH,
      fetch: extra.fetch,
      afterClaim: extra.afterClaim,
    });
    const backlog = await pendingCandidateBacklog(env, mayorId, scanId, { limit: ARTICLE_FETCH_BATCH });
    if (backlog.pending > 0 && env.SCAN_QUEUE) {
      if (backlog.ids.length) {
        await enqueueArticleFetches(env, { ids: backlog.ids, mayorId, scanId, jobId });
      } else if (backlog.nextAt) {
        await enqueueArticleFetches(env, {
          ids: candidateIds || [],
          mayorId,
          scanId,
          jobId,
          delaySeconds: continuationDelaySeconds({ nextAt: backlog.nextAt }),
        });
      }
    } else if (backlog.pending <= 0) {
      await maybeFinishMayor(env, { mayorId, jobId, scanId });
    }
    message.ack();
  } catch {
    message.retry({ delaySeconds: 20 });
  }
}

async function finishAllOffices(env, type = "weekly") {
  const results = [];
  const errors = [];
  const offices = await listMayors(env);
  for (let i = 0; i < offices.length; i += 2) {
    const chunk = offices.slice(i, i + 2);
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
    }    );
  }
  await assignPendingLanes(env);
  if (env.SCAN_QUEUE) await enqueueBriefPump(env);
  else await drainBriefs(env);
  return { offices: results.length, failed: errors.length, errors, results };
}

async function enqueueAllOffices(env, type = "weekly") {
  if (!env.SCAN_QUEUE) return finishAllOffices(env, type);
  const mayorIds = (await listMayors(env)).map((mayor) => mayor.id);
  const scanId = crypto.randomUUID();
  const claimed = await claimDeskRun(env, { mayorId: null, kind: type, jobId: null, scanId });
  if (!claimed.acquired) {
    return {
      queued: 0,
      type,
      scanId: claimed.lock?.scan_id || null,
      jobId: claimed.lock?.job_id || null,
      reused: true,
      reusedKind: claimed.lock?.kind || null,
    };
  }
  try {
    const queued = await enqueueSourcePolls(env, { mayorIds, type, scanId });
    return { queued: queued.queued, type, scanId: queued.scanId, reused: false };
  } catch (error) {
    await releaseDeskRun(env, { mayorId: null, scanId });
    throw error;
  }
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

export function searchJobSnapshot(job, tasks, mayors = MAYORS) {
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
    } else if (
      task.status === "running" ||
      task.status === "retrying" ||
      task.status === "waiting"
    ) {
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
      mayor_name: mayors.find((mayor) => mayor.id === task.mayor_id)?.name_ar || task.mayor_id,
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
  return searchJobSnapshot(job, results || [], await listMayors(env));
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
  const catalog = await listMayors(env);
  const targets = mayorId ? catalog.filter((mayor) => mayor.id === mayorId) : catalog;
  if (!targets.length) throw new Error("mayor_not_found");
  const jobId = crypto.randomUUID();
  const scanId = crypto.randomUUID();
  const claimed = await claimDeskRun(env, {
    mayorId: mayorId || null,
    kind: "manual",
    jobId,
    scanId,
  });
  if (!claimed.acquired) {
    return {
      jobId: claimed.lock?.job_id || null,
      queued: 0,
      scanId: claimed.lock?.scan_id || null,
      reused: true,
      reusedKind: claimed.lock?.kind || null,
    };
  }
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
    const queued = await enqueueSourcePolls(env, {
      mayorIds: targets.map((mayor) => mayor.id),
      type: "manual",
      query,
      jobId,
      scanId,
    });
    if (!queued.queued) {
      await releaseDeskRun(env, { mayorId: mayorId || null, jobId, scanId });
    }
    return { jobId, queued: queued.queued || 0, scanId: queued.scanId, reused: false };
  } catch (error) {
    await releaseDeskRun(env, { mayorId: mayorId || null, jobId, scanId });
    await env.DB.prepare(
      `UPDATE search_job_tasks SET status = 'failed', error = ? WHERE job_id = ?`,
    )
      .bind(String(error.message || error).slice(0, 300), jobId)
      .run();
    await refreshSearchJobStatus(env, jobId);
    throw error;
  }
}

async function processBriefContinuation(env, message) {
  const body = message.body || {};
  const jobId = body.jobId || null;
  try {
    await assignPendingLanes(env);
    const summary = await summarizeBatch(env, null);
    await verifyPending(env, BRIEF_BATCH_SIZE);
    await assignPendingLanes(env);
    const leftover = await briefBacklog(env);
    const verify = await verificationBacklog(env);
    if (jobId) await refreshJobJourney(env, jobId);
    const nextAt = earliestIso(leftover.nextAt, verify.nextAt);
    if ((leftover.eligible || 0) > 0 || (verify.eligible || 0) > 0) {
      await enqueueBriefPump(env, {
        jobId,
        delaySeconds: summary.summarized > 0 || summary.failed > 0 ? 0 : 5,
      });
    } else if (
      shouldContinueBriefs({
        ...summary,
        pending: (leftover.pending || 0) + (verify.pending || 0),
        nextAt,
      })
    ) {
      await enqueueBriefPump(env, {
        jobId,
        delaySeconds: continuationDelaySeconds({ ...summary, nextAt }),
      });
    }
    message.ack();
  } catch {
    message.retry({ delaySeconds: 30 });
  }
}

async function requeueDueSourcePolls(env) {
  if (!env.SCAN_QUEUE) return 0;
  const due = await dueSourcePolls(env);
  if (!due.length) return 0;
  const messages = [];
  for (const row of due) {
    const scan = await env.DB.prepare(`SELECT query FROM scans WHERE id = ?`)
      .bind(row.scan_id)
      .first();
    messages.push({
      body: {
        type: "source_poll",
        mayorId: row.mayor_id,
        sourceId: row.source_id,
        scanId: row.scan_id,
        jobId: row.job_id || null,
        query: scan?.query || "",
      },
      contentType: "json",
    });
  }
  for (let i = 0; i < messages.length; i += 100) {
    await env.SCAN_QUEUE.sendBatch(messages.slice(i, i + 100));
  }
  return messages.length;
}

async function processQueuedSearch(env, message) {
  const body = message.body || {};
  if (body.type === "brief") {
    await processBriefContinuation(env, message);
    return;
  }
  if (body.type === "source_poll") {
    await processSourcePollMessage(env, message);
    return;
  }
  if (body.type === "article_fetch") {
    await processArticleFetchMessage(env, message);
    return;
  }
  const mayorId = body.mayorId;
  const mayor = await resolveMayor(env, mayorId);
  if (!mayorId || !mayor) {
    message.ack();
    return;
  }
  if (env.SCAN_QUEUE) {
    await enqueueSourcePolls(env, {
      mayorIds: [mayorId],
      type: body.type || "weekly",
      query: body.query || "",
      jobId: body.jobId || null,
    });
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
    const assessment = jobId
      ? await persistMayorJourney(env, {
          mayorId,
          jobId,
          scanId: result.scanId || null,
          result: { ...result, scanId: result.scanId || null },
        })
      : await assessMayorJourney(env, { mayorId, scanId: result.scanId || null });
    if (assessment?.status !== "completed") {
      await enqueueBriefPump(env, { jobId, delaySeconds: 0 });
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

/** هوية المراجع كما وصلت فعلًا، ولا تُنسب القرارات إلى مجهول بصمت. */
export function reviewerOf(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (header.startsWith("Basic ")) {
    try {
      const user = atob(header.slice(6)).split(":")[0];
      if (user) return user;
    } catch {
      /* fall through to the configured identity */
    }
  }
  return env.DASHBOARD_USER || "unauthenticated-local";
}

export function authorized(request, env) {
  if (!env.DASHBOARD_PASSWORD) return !anyAiKey(env);
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

function publicSlotStatus(slot, { includeHasKey = false } = {}) {
  const budget = slot.budget || {};
  const row = {
    id: slot.id,
    nameAr: slot.nameAr,
    model: slot.model,
    bound: Boolean(slot.bound),
    enabled: Boolean(slot.enabled),
    blocked: Boolean(slot.blocked),
    budget: {
      remaining: Number(budget.remaining) || 0,
      dailyLimit: Number(budget.dailyLimit) || 0,
      used: Number(budget.used) || 0,
      minIntervalMs: Number(budget.minIntervalMs) || 0,
      resumesInSeconds: Number(budget.resumesInSeconds) || 0,
      blockReason: budget.blockReason || null,
    },
    lastError: slot.lastError
      ? { code: String(slot.lastError.code), at: slot.lastError.at || null }
      : null,
  };
  if (includeHasKey) row.hasKey = Boolean(slot.hasKey);
  return row;
}

function aiToolChips(slots) {
  return slots.map((slot) => {
    const budget = slot.budget || {};
    let ok = true;
    let detail = `يقرأ الصفحة ويكتب الموجز بنداء واحد · بقي ${budget.remaining} من ${budget.dailyLimit} نداءً`;
    if (!slot.enabled) {
      ok = false;
      detail = "موقوف من إعداد التفعيل";
    } else if (!slot.bound) {
      ok = false;
      detail = "المفتاح غير مربوط";
    } else if (budget.blocked || Number(budget.remaining) <= 0) {
      ok = "warn";
      detail = budget.blocked
        ? `متوقف مؤقتًا · بقي ${budget.remaining} من ${budget.dailyLimit} نداءً`
        : `نفدت الحصة اليومية · بقي 0 من ${budget.dailyLimit} نداءً`;
    }
    if (slot.lastError?.code) {
      detail += ` · آخر خطأ: ${slot.lastError.code}`;
    }
    return {
      id: `ai-${slot.id}`,
      name: `الذكاء الاصطناعي — ${slot.nameAr} — ${slot.model}`,
      icon: "spark",
      ok,
      detail,
    };
  });
}

async function slotOverview(env) {
  const slots = await slotRuntimeStatuses(env);
  return {
    slots,
    budget: aggregateSlotBudget(slots),
    configured: aiBriefEnabled(env),
    model: slots.find((slot) => slot.bound)?.model || null,
  };
}

async function publicHealth(env) {
  const ai = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN trans_engine = 'brief-pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN trans_engine = 'brief-deferred' THEN 1 ELSE 0 END) AS waitingQuota,
       SUM(CASE WHEN trans_engine = 'brief-unconfigured' THEN 1 ELSE 0 END) AS unconfigured,
       SUM(CASE WHEN trans_engine = 'brief-ai-error' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN trans_engine LIKE 'brief-ai-%-v2:%' THEN 1 ELSE 0 END) AS completed
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
  const overview = await slotOverview(env);
  return {
    ok: true,
    cron: "Sunday 06:00 Asia/Riyadh",
    briefDrainCron: "every 10 minutes",
    queue: Boolean(env.SCAN_QUEUE),
    ai: {
      configured: overview.configured,
      model: overview.model,
      pending: Number(ai?.pending) || 0,
      waitingQuota: Number(ai?.waitingQuota) || 0,
      unconfigured: Number(ai?.unconfigured) || 0,
      failed: Number(ai?.failed) || 0,
      completed: Number(ai?.completed) || 0,
      retryable: await pendingBriefCount(env),
      maxAttempts: MAX_BRIEF_ATTEMPTS,
      errors: results || [],
      budget: overview.budget,
      slots: overview.slots.map((slot) => publicSlotStatus(slot)),
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
  const laneSql = deskLaneStatSql("items");
  const row = await env.DB.prepare(
    `SELECT
      ${laneSql},
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'excluded' THEN 1 ELSE 0 END) AS excluded,
      COUNT(*) AS total
     FROM items`,
  ).first();
  const byMayor = await env.DB.prepare(
    `SELECT mayor_id, COUNT(*) AS total,
            ${laneSql},
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
       AND COALESCE(published_at, created_at) >= datetime('now', '-${ITEM_WINDOW_DAYS} days')`,
  )
    .bind(REASON.DUPLICATE)
    .first();
  const weekFound = await env.DB.prepare(
    `SELECT COUNT(*) AS found
     FROM items
     WHERE COALESCE(published_at, created_at) >= datetime('now', '-${ITEM_WINDOW_DAYS} days')`,
  ).first();
  const overview = await slotOverview(env);
  const lanes = publicLaneStats(row);
  return {
    ...lanes,
    approved: row?.approved || 0,
    excluded: row?.excluded || 0,
    total: row?.total || 0,
    byMayor: (byMayor.results || []).map((entry) => ({
      mayor_id: entry.mayor_id,
      total: entry.total || 0,
      approved: entry.approved || 0,
      excluded: entry.excluded || 0,
      ...publicLaneStats(entry),
    })),
    lastWeekly,
    lastManual,
    week: { duplicates: weekDup?.duplicates || 0, found: weekFound?.found || 0 },
    sources: {
      ...sourceStatus(env),
      ai_brief: aiBriefEnabled(env) ? "ready" : "unconfigured",
    },
    ai: {
      configured: overview.configured,
      model: overview.model,
      pending: await pendingBriefCount(env),
      budget: overview.budget,
      slots: overview.slots.map((slot) => publicSlotStatus(slot)),
    },
    registry: await registrySummary(env),
  };
}

async function providerLanes(env) {
  return providerLaneSnapshot(env, await briefBacklog(env));
}

/** كل ما يشرح ما يعمل الآن ولماذا، في مكان واحد يفتحه المستخدم عند الحاجة. */
async function diagnostics(env) {
  const brief = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN trans_engine LIKE 'brief-ai-%-v2:%' THEN 1 ELSE 0 END) AS completed,
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
            sources.enabled, sources.connect_status, sources.http_status, sources.parse_status,
            sources.discovered_count, sources.new_count, sources.last_checked_at,
            sources.last_discovery_at, sources.fail_reason, sources.last_strategy,
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
  const overview = await slotOverview(env);
  const budget = overview.budget;
  const mergeSlot =
    overview.slots.find((slot) => slot.id === "gemini" && slot.bound) ||
    overview.slots.find((slot) => slot.bound);
  const pageSources = APPROVED_SOURCES.filter((source) =>
    (source.discovery || []).some((step) => step.type === "newsroom"),
  ).length;
  const readerOk = Number(window?.total) > 0 || !lastScan;
  return {
    windowDays: ITEM_WINDOW_DAYS,
    retentionDays: ITEM_RETENTION_DAYS,
    tools: [
      {
        id: "registry",
        name: "سجل المصادر",
        icon: "list",
        ...registryChip(registry),
      },
      {
        id: "reader",
        name: "قارئ الصفحات",
        icon: "page",
        ok: readerOk,
        detail: `يفتح كل رابط ويستخرج نص الخبر · ${pageSources} مصدرًا يُقرأ من صفحته لعدم نشره تغذية`,
      },
      ...aiToolChips(overview.slots),
      {
        id: "merge",
        name: "دمج الأحداث",
        icon: "merge",
        ok: overview.configured,
        detail: `يوحّد تغطية الحدث نفسه عبر اللغات والمنصات · حصته ${Number(mergeSlot?.budget?.mergeLimit) || 0} نداءً يوميًا`,
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
      configured: overview.configured,
      model: overview.model,
      budget,
      slots: overview.slots.map((slot) => publicSlotStatus(slot, { includeHasKey: true })),
    },
    verification: await env.DB.prepare(
      `SELECT
         IFNULL(SUM(CASE WHEN verify_state = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
         IFNULL(SUM(CASE WHEN verify_state = 'passed' THEN 1 ELSE 0 END), 0) AS passed,
         IFNULL(SUM(CASE WHEN verify_state = 'failed' THEN 1 ELSE 0 END), 0) AS failed
       FROM brief_versions WHERE superseded_at IS NULL`,
    ).first(),
    decisions: await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              IFNULL(SUM(CASE WHEN decision = 'approved' THEN 1 ELSE 0 END), 0) AS approved
       FROM approvals`,
    ).first(),
    registry,
    sources: (sources || []).map((row) => ({ ...row, operational: operationalStatus(row) })),
    lastScan: lastScan || null,
    queue: Boolean(env.SCAN_QUEUE),
    providers: await providerLanes(env),
  };
}

export function operationalStatus(row) {
  if (Number(row?.enabled) === 0) {
    return { code: "disabled", label: "متوقفة يدويًا" };
  }
  const status = String(row?.last_status || row?.connect_status || "");
  if (!row?.last_checked_at && !status) {
    return { code: "unchecked", label: "لم تُفحص بعد في هذه البيئة" };
  }
  if (status === "ok_no_new" || (row?.ok && Number(row.new_count) === 0 && Number(row.consecutive_failures) === 0)) {
    return { code: "ok_no_new", label: "تعمل ولا توجد أخبار جديدة" };
  }
  if (status === "ok") return { code: "ok", label: "تعمل" };
  if (status === "feed_stalled") {
    return { code: "feed_stalled", label: "التغذية توقفت عن التحديث" };
  }
  if (status === "feed_corrupt") {
    return { code: "feed_corrupt", label: "التغذية فاسدة" };
  }
  if (status === "bad_url" || status === "error_page") {
    return { code: "bad_url", label: "رابط المصدر غير صحيح" };
  }
  if (status === "needs_javascript") {
    return { code: "needs_javascript", label: "الصفحة تحتاج JavaScript" };
  }
  if (status === "worker_rejected" || /403|401/.test(status)) {
    return { code: "worker_rejected", label: "الموقع يرفض العامل" };
  }
  if (status === "empty_parse" || status === "no_article_links") {
    return { code: "empty_parse", label: "التحليل لم يجد روابط" };
  }
  if (status === "not_articles") {
    return { code: "not_articles", label: "الروابط المكتشفة ليست مقالات" };
  }
  if (status === "unrelated") {
    return { code: "unrelated", label: "المقالات لا تتعلق بالعمدة" };
  }
  if (Number(row?.consecutive_failures) >= 3) {
    return { code: "failing", label: row.fail_reason || status || "متعثر" };
  }
  return { code: status || "unknown", label: row.fail_reason || status || "غير معروف" };
}

export function registryChip(registry) {
  const failing = Number(registry?.failing) || 0;
  const total = Number(registry?.total) || 0;
  const verified = Number(registry?.verified) || 0;
  const perOffice = Number(registry?.perOffice) || 3;
  if (!total) {
    return { ok: false, detail: "السجل فارغ — لا نطاقات معتمدة." };
  }
  if (failing > 0) {
    return {
      ok: "warn",
      detail:
        `السجل يعمل ولم يُوقف. ${failing} مصدرًا من ${total} تعثر ثلاث مرات متتالية عند الجلب ` +
        `(غالبًا رفض 403 أو مهلة من موقع البلدية). باقي المصادر تُقرأ كالمعتاد.`,
    };
  }
  return {
    ok: true,
    detail: `${total} نطاقًا معتمدًا · ${perOffice} لكل مكتب · مُتحقق منها بالفحص ${verified}`,
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

async function settingsOffices(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM sources ORDER BY mayor_id, rank`,
  ).all();
  const byMayor = new Map();
  for (const row of results || []) {
    if (!byMayor.has(row.mayor_id)) byMayor.set(row.mayor_id, []);
    const registered = sourceById(row.id);
    byMayor.get(row.mayor_id).push({
      id: row.id,
      domain: row.domain,
      name: row.name,
      tier: row.tier,
      kind: row.kind,
      url: row.url,
      rank: row.rank,
      enabled: Number(row.enabled) !== 0,
      platform: registered?.platform || (row.tier === 0 ? "official" : "newspaper"),
      platform_ar: platformLabelAr(registered || row),
      strategies: (registered?.discovery || []).map((step) => ({
        type: step.type,
        type_ar: strategyLabelAr(step.type),
        url: step.url || null,
        enabled: step.enabled !== false,
      })),
      last_checked_at: row.last_checked_at,
      last_discovery_at: row.last_discovery_at,
      last_ok_at: row.last_ok_at,
      last_status: row.last_status,
      fail_reason: row.fail_reason,
      operational: operationalStatus(row),
    });
  }
  const catalog = await listMayors(env);
  return catalog.map((mayor) => ({
    id: mayor.id,
    origin: mayor.origin || "seed",
    name_ar: mayor.name_ar,
    name_en: mayor.name_en,
    name_native: mayor.name_native,
    city_ar: mayor.city_ar,
    city_en: mayor.city_en,
    country_ar: mayor.country_ar,
    country_code: mayor.country_code,
    title_ar: mayor.title_ar,
    title_en: mayor.title_en,
    official_host: mayor.official_host || "",
    platforms: byMayor.get(mayor.id) || [],
  }));
}

async function setSourceEnabled(env, sourceId, enabled, actor) {
  if (!sourceById(sourceId)) {
    return { error: "unknown_source", status: 404 };
  }
  const before = await env.DB.prepare(`SELECT enabled FROM sources WHERE id = ?`)
    .bind(sourceId)
    .first();
  const next = enabled ? 1 : 0;
  await env.DB.prepare(`UPDATE sources SET enabled = ? WHERE id = ?`)
    .bind(next, sourceId)
    .run();
  await env.DB.prepare(
    `INSERT INTO settings_audit (id, actor, action, source_id, mayor_id, before_json, after_json)
     VALUES (?, ?, 'source_enabled', ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      actor || "unknown",
      sourceId,
      sourceById(sourceId).mayor_id,
      JSON.stringify({ enabled: Number(before?.enabled) !== 0 }),
      JSON.stringify({ enabled: Boolean(next) }),
    )
    .run();
  return { ok: true, id: sourceId, enabled: Boolean(next) };
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/mayors" && method === "GET") {
    return json({ mayors: await listMayors(env) });
  }

  if (path === "/api/diagnostics" && method === "GET") {
    return json(await diagnostics(env));
  }

  const retryMatch = path.match(/^\/api\/items\/([0-9a-f-]+)\/retry-brief$/i);
  if (retryMatch && method === "POST") {
    await env.DB.prepare(
      `UPDATE items
       SET brief_attempts = 0, brief_error = NULL, brief_attempted_at = NULL,
           brief_claim_id = NULL, brief_claimed_at = NULL, brief_provider = NULL,
           trans_engine = 'brief-pending'
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

  if (path === "/api/settings/offices" && method === "GET") {
    return json({ offices: await settingsOffices(env) });
  }

  const toggleMatch = path.match(/^\/api\/settings\/sources\/([^/]+)$/i);
  if (toggleMatch && method === "POST") {
    const body = await readBody(request);
    if (typeof body.enabled !== "boolean") {
      return json({ error: "enabled_required" }, 400);
    }
    if (body.domain || body.url) {
      return json({ error: "registry_closed", detail: "لا تُضاف النطاقات من الواجهة." }, 403);
    }
    const result = await setSourceEnabled(
      env,
      decodeURIComponent(toggleMatch[1]),
      body.enabled,
      reviewerOf(request, env),
    );
    if (result.error) return json(result, result.status || 400);
    return json(result);
  }

  if (path === "/api/settings/mayors" && method === "POST") {
    const body = await readBody(request);
    if (body.domain || body.url || body.discovery || body.sources) {
      return json(
        {
          error: "registry_closed",
          message: "لا يمكن إضافة منصة أو نطاق رصد من الواجهة — أضف هوية العمدة فقط.",
        },
        403,
      );
    }
    const parsed = parseMayorInput(body);
    if (parsed.error) {
      return json(
        { error: parsed.error, detail: parsed.detail || null, message: mayorInputMessage(parsed) },
        400,
      );
    }
    const existing = await env.DB.prepare(`SELECT id FROM mayors WHERE id = ?`)
      .bind(parsed.mayor.id)
      .first();
    if (existing) {
      return json({ error: "duplicate_id", message: "معرّف العمدة مستخدم مسبقاً" }, 409);
    }
    const mayor = await insertCustomMayor(env, parsed.mayor);
    await env.DB.prepare(
      `INSERT INTO settings_audit (id, actor, action, source_id, mayor_id, before_json, after_json)
       VALUES (?, ?, 'mayor_created', NULL, ?, NULL, ?)`,
    )
      .bind(crypto.randomUUID(), reviewerOf(request, env), mayor.id, JSON.stringify(mayor))
      .run();
    return json(
      {
        ok: true,
        mayor,
        note: "أُضيفت هوية العمدة فقط. المنصات تُفعَّل من السجل المغلق في الكود إن وُجدت.",
        offices: await settingsOffices(env),
      },
      201,
    );
  }

  if (path === "/api/admin/migrations/desk-lanes" && method === "GET") {
    const stored = await env.DB.prepare(
      `SELECT v FROM meta WHERE k = 'desk_lane_migration_report'`,
    ).first();
    let lastApplied = null;
    try {
      lastApplied = stored?.v ? JSON.parse(stored.v) : null;
    } catch {
      lastApplied = null;
    }
    return json({
      dryRun: true,
      plan: await planDeskLaneMigration(env),
      lastApplied,
    });
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
    const rawStatus = url.searchParams.get("status") || "inbox";
    const laneParam = url.searchParams.get("lane");
    const resolved = resolveDeskQuery(rawStatus, laneParam);
    if (resolved.kind === "invalid") {
      return json({ error: "bad_status", requested: resolved.requested }, 400);
    }
    const mayorId = url.searchParams.get("mayor_id");
    const q = url.searchParams.get("q");
    const clauses = [];
    const binds = [];
    if (resolved.kind === "lane") {
      clauses.push("items.status = 'inbox'");
      clauses.push(inDisplayWindowSql("items"));
      clauses.push(deskLanePredicateSql(resolved.value, "items"));
    } else {
      clauses.push("items.status = ?");
      binds.push(resolved.value);
      clauses.push(inDisplayWindowSql("items"));
    }
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
    return json({
      items: results,
      lane: resolved.kind === "lane" ? resolved.value : null,
      status: resolved.kind === "status" ? resolved.value : "inbox",
    });
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
    const itemId = statusMatch[1];
    const version = await currentVersion(env, itemId);

    /**
     * الاعتماد قرار على محتوى بعينه. موجز لم يجتز التدقيق الدلالي ليس جاهزًا،
     * فمنعه هنا أصدق من عرضه ثم تبرير قرار بُني على ادعاء غير مثبت.
     */
    if (status === "approved" && !isReadyForApproval(version)) {
      return json(
        {
          error: "brief_not_verified",
          verify_state: version?.verify_state || "missing",
          detail: version
            ? "لم يجتز الموجز التدقيق الدلالي بعد."
            : "لا يوجد موجز محفوظ لهذا الخبر.",
        },
        409,
      );
    }

    const reason = status === "excluded" ? REASON.MANUAL : null;
    await env.DB.prepare(`UPDATE items SET status = ?, exclude_reason = ? WHERE id = ?`)
      .bind(status, reason, itemId)
      .run();

    if (version && status !== "inbox") {
      const source = await env.DB.prepare(`SELECT article_text FROM items WHERE id = ?`)
        .bind(itemId)
        .first();
      await recordDecision(env, {
        itemId,
        version,
        decision: status,
        reviewer: reviewerOf(request, env),
        note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
        sourceText: source?.article_text || "",
      });
    }
    return json({ ok: true, version_id: version?.id || null });
  }

  const decisionsMatch = path.match(/^\/api\/items\/([0-9a-f-]+)\/decisions$/i);
  if (decisionsMatch && method === "GET") {
    return json({ decisions: await decisionsFor(env, decisionsMatch[1]) });
  }

  if (path === "/api/review" && method === "POST") {
    const body = await readBody(request);
    const mayorId = body.mayor_id || null;
    const result = await reviewInbox(env, { mayorId, limit: 500, useAiMerge: false });
    await assignPendingLanes(env, mayorId);
    const backlog = await briefBacklog(env, mayorId);
    if (backlog.pending > 0) await enqueueBriefPump(env);
    return json({ ok: true, ...result, ai: backlog });
  }

  if (path === "/api/admin/reset" && method === "POST") {
    const body = await readBody(request);
    if (body.confirm !== "احذف كل الأخبار") {
      return json(
        {
          error: "confirmation_required",
          detail: 'أرسل confirm بالقيمة "احذف كل الأخبار" لتأكيد الحذف.',
        },
        400,
      );
    }
    // القرارات المحفوظة أرشيف، فلا يمسّها إجراء تنظيف الأخبار.
    const removed = await env.DB.prepare(
      `DELETE FROM items WHERE NOT ${protectedItemsSql()}`,
    ).run();
    await env.DB.prepare(`DELETE FROM scans`).run();
    await env.DB.prepare(`DELETE FROM search_job_tasks`).run();
    await env.DB.prepare(`DELETE FROM search_jobs`).run();
    return json({
      ok: true,
      removedItems: Number(removed?.meta?.changes) || 0,
      keptDecided: Number(
        (await env.DB.prepare(`SELECT COUNT(*) AS n FROM items`).first())?.n || 0,
      ),
      by: reviewerOf(request, env),
    });
  }

  if (path === "/api/briefs/drain" && method === "POST") {
    const drained = await drainBriefs(env);
    const overview = await slotOverview(env);
    return json({
      ok: true,
      ...drained,
      budget: overview.budget,
      slots: overview.slots.map((slot) => publicSlotStatus(slot)),
    });
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

export {
  enqueueAllOffices,
  enqueueManualSearch,
  enqueueSourcePolls,
  requeueDueSourcePolls,
};

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
        const leftoverFetch = await pendingFetchIds(env, { limit: ARTICLE_FETCH_BATCH * 4 });
        if (leftoverFetch.length && env.SCAN_QUEUE) {
          const groups = await groupCandidatesForEnqueue(env, leftoverFetch);
          for (const group of groups) {
            await enqueueArticleFetches(env, group);
          }
        }
        await requeueDueSourcePolls(env);
        await drainBriefs(env);
        const leftover = await briefBacklog(env);
        const verify = await verificationBacklog(env);
        if (leftover.pending > 0 || verify.pending > 0) await enqueueBriefPump(env);
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
