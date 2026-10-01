import { REASON } from "../reasons.js";
import { APPROVED_SOURCES } from "../sources.js";

export async function upsertRows(env, prefix, rows, width, chunkSize, conflictClause = "") {
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

export async function migrateSearchJobs(env) {
  const info = await env.DB.prepare(`PRAGMA table_info(search_job_tasks)`).all();
  const names = new Set((info.results || []).map((column) => column.name));
  if (!names.has("stage")) {
    await env.DB.prepare(`ALTER TABLE search_job_tasks ADD COLUMN stage TEXT DEFAULT 'queued'`).run();
  }
  if (!names.has("detail")) {
    await env.DB.prepare(`ALTER TABLE search_job_tasks ADD COLUMN detail TEXT`).run();
  }
}

export async function migrateAiProviderBudget(env) {
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
  // مصادر الإعدادات: origin='custom' وخطوات الاكتشاف المحفوظة JSON.
  await add("origin", `ALTER TABLE sources ADD COLUMN origin TEXT DEFAULT 'registry'`);
  await add("discovery_json", `ALTER TABLE sources ADD COLUMN discovery_json TEXT`);
  await add("platform", `ALTER TABLE sources ADD COLUMN platform TEXT`);
  await add("added_by", `ALTER TABLE sources ADD COLUMN added_by TEXT`);
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_sources_origin ON sources(origin)`).run();
}

export async function seedSources(env) {
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

export async function migrateItems(env) {
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
  // الفهرس يُنشأ هنا بعد ضمان وجود العمود، فقراءة الحجز تبحث بالفهرس لا بمسح كامل.
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_items_claim ON items(brief_claim_id)`,
  ).run();
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
