/**
 * نسخ الموجز وقرارات الاعتماد.
 *
 * الموجز يُحفظ بمجرد إنتاجه، قبل التدقيق الدلالي، حتى لا يُفقد ولا يُعاد إنتاجه
 * إن منعت الميزانية الاستدعاء الثاني. والتدقيق مرحلة مستقلة لها حالتها ووقت
 * استئنافها. ولا يصبح الموجز جاهزًا للاعتماد إلا باجتياز التدقيق.
 *
 * والاعتماد يرتبط بنسخة محددة: تُجمَّد صورة ما رآه المراجع، مع هويته ووقت
 * قراره. فإن تغيّر المصدر لاحقًا نشأت نسخة جديدة تحتاج مراجعة جديدة، وبقيت
 * النسخة المعتمدة وأدلتها كما هي.
 */

export const VERIFY_STATE = {
  PENDING: "pending",
  PASSED: "passed",
  FAILED: "failed",
};

export const MAX_VERIFY_ATTEMPTS = 4;
export const VERIFY_CLAIM_TIMEOUT_MINUTES = 10;

export const VERSION_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS brief_versions (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    engine TEXT NOT NULL,
    title_ar TEXT NOT NULL,
    snippet_ar TEXT NOT NULL,
    evidence TEXT NOT NULL,
    sent_excerpts TEXT,
    sent_source_ids TEXT,
    verify_state TEXT NOT NULL DEFAULT 'pending',
    verify_detail TEXT,
    verify_attempts INTEGER NOT NULL DEFAULT 0,
    verify_after TEXT,
    verify_claim_id TEXT,
    verify_claimed_at TEXT,
    superseded_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_brief_versions_item
    ON brief_versions(item_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_brief_versions_verify
    ON brief_versions(verify_state, verify_after)`,
  `CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reviewer TEXT NOT NULL,
    reviewer_known INTEGER NOT NULL DEFAULT 1,
    decided_at TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    title_ar TEXT NOT NULL,
    snippet_ar TEXT NOT NULL,
    evidence TEXT,
    source_snapshot TEXT,
    note TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_approvals_item ON approvals(item_id, decided_at DESC)`,
];

const ENCODER = new TextEncoder();

/** بصمة نص المصدر: تغيّرها يعني أن المراجع لم يرَ هذا المحتوى. */
export async function sourceHash(text) {
  const digest = await crypto.subtle.digest("SHA-256", ENCODER.encode(String(text || "")));
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function migrateVersions(env) {
  for (const sql of VERSION_SCHEMA) {
    await env.DB.prepare(sql).run();
  }
  const info = await env.DB.prepare(`PRAGMA table_info(items)`).all();
  const names = new Set((info.results || []).map((column) => column.name));
  const additions = [
    ["current_version_id", "TEXT"],
    ["approved_version_id", "TEXT"],
    ["source_hash", "TEXT"],
    ["needs_review", "INTEGER DEFAULT 0"],
    ["brief_after", "TEXT"],
  ];
  for (const [column, type] of additions) {
    if (!names.has(column)) {
      await env.DB.prepare(`ALTER TABLE items ADD COLUMN ${column} ${type}`).run();
    }
  }

  const versionInfo = await env.DB.prepare(`PRAGMA table_info(brief_versions)`).all();
  const versionNames = new Set((versionInfo.results || []).map((column) => column.name));
  const versionAdditions = [
    ["verify_claim_id", "TEXT"],
    ["verify_claimed_at", "TEXT"],
  ];
  for (const [column, type] of versionAdditions) {
    if (!versionNames.has(column)) {
      await env.DB.prepare(`ALTER TABLE brief_versions ADD COLUMN ${column} ${type}`).run();
    }
  }
}

/**
 * تُحفظ النسخة أولًا بحالة «بانتظار التدقيق». إن كانت نسخة بنفس بصمة المصدر
 * موجودة ومجتازة فلا يُعاد إنتاج شيء.
 */
export async function saveBriefVersion(env, { itemId, brief, hash, sent }) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `UPDATE brief_versions SET superseded_at = datetime('now')
     WHERE item_id = ? AND superseded_at IS NULL`,
  )
    .bind(itemId)
    .run();
  await env.DB.prepare(
    `INSERT INTO brief_versions (
       id, item_id, source_hash, engine, title_ar, snippet_ar, evidence,
       sent_excerpts, sent_source_ids, verify_state, verify_attempts
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '${VERIFY_STATE.PENDING}', 0)`,
  )
    .bind(
      id,
      itemId,
      hash,
      brief.engine,
      brief.title_ar,
      brief.snippet_ar,
      brief.evidence,
      JSON.stringify(sent?.excerpts || []),
      JSON.stringify(sent?.sourceIds || []),
    )
    .run();
  return id;
}

export async function currentVersion(env, itemId) {
  return env.DB.prepare(
    `SELECT * FROM brief_versions
     WHERE item_id = ? AND superseded_at IS NULL
     ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(itemId)
    .first();
}

export function liveVerifyClaimSql(alias = "brief_versions") {
  return `${alias}.verify_claim_id IS NOT NULL
    AND ${alias}.verify_claimed_at > datetime('now', '-${VERIFY_CLAIM_TIMEOUT_MINUTES} minutes')`;
}

/**
 * حجز ذري قبل نداء التدقيق. SELECT وحده كان يسمح لمستهلكين متزامنين
 * بتدقيق النسخة نفسها. الحجز ينتهي بعد المهلة فيُسترد إن مات العامل.
 */
export async function claimVerifications(env, limit = 1) {
  const claimId = crypto.randomUUID();
  await env.DB.prepare(
    `UPDATE brief_versions
     SET verify_claim_id = ?, verify_claimed_at = datetime('now')
     WHERE id IN (
       SELECT id FROM brief_versions
       WHERE verify_state = '${VERIFY_STATE.PENDING}'
         AND superseded_at IS NULL
         AND verify_attempts < ${MAX_VERIFY_ATTEMPTS}
         AND (verify_after IS NULL OR verify_after <= datetime('now'))
         AND NOT (${liveVerifyClaimSql()})
       ORDER BY created_at ASC
       LIMIT ?
     )`,
  )
    .bind(claimId, limit)
    .run();

  const { results } = await env.DB.prepare(
    `SELECT brief_versions.*, items.mayor_id, items.article_text, items.title, items.snippet,
            mayors.name_ar, mayors.name_en, mayors.name_native
     FROM brief_versions
     JOIN items ON items.id = brief_versions.item_id
     JOIN mayors ON mayors.id = items.mayor_id
     WHERE brief_versions.verify_claim_id = ?`,
  )
    .bind(claimId)
    .all();
  return results || [];
}

/** عدد ما ينتظر التدقيق، وأقرب وقت صالح للاستئناف. */
export async function verificationBacklog(env) {
  const row = await env.DB.prepare(
    `SELECT
       COUNT(*) AS pending,
       SUM(CASE WHEN verify_after IS NULL OR verify_after <= datetime('now')
                THEN 1 ELSE 0 END) AS eligible,
       MIN(CASE WHEN verify_after IS NULL OR verify_after <= datetime('now')
                THEN NULL ELSE verify_after END) AS next_at
     FROM brief_versions
     WHERE verify_state = '${VERIFY_STATE.PENDING}'
       AND superseded_at IS NULL
       AND verify_attempts < ${MAX_VERIFY_ATTEMPTS}`,
  ).first();
  return {
    pending: Number(row?.pending) || 0,
    eligible: Number(row?.eligible) || 0,
    nextAt: row?.next_at || null,
  };
}

function claimWriteSql(extraSet) {
  return `UPDATE brief_versions
     SET ${extraSet},
         verify_claim_id = NULL, verify_claimed_at = NULL
     WHERE id = ? AND verify_claim_id = ?`;
}

async function wroteClaimedRow(result) {
  return (Number(result?.meta?.changes) || 0) > 0;
}

export async function recordVerificationPass(env, versionId, keptFacts, evidence, claimId) {
  if (!claimId) return false;
  const result = await env.DB.prepare(
    claimWriteSql(`verify_state = '${VERIFY_STATE.PASSED}', verify_detail = NULL,
         verify_attempts = verify_attempts + 1, verify_after = NULL,
         snippet_ar = ?, evidence = ?`),
  )
    .bind(keptFacts, evidence, versionId, claimId)
    .run();
  return wroteClaimedRow(result);
}

export async function recordVerificationFailure(env, versionId, detail, claimId) {
  if (!claimId) return false;
  const result = await env.DB.prepare(
    claimWriteSql(`verify_state = '${VERIFY_STATE.FAILED}', verify_detail = ?,
         verify_attempts = verify_attempts + 1, verify_after = NULL`),
  )
    .bind(String(detail || "").slice(0, 240), versionId, claimId)
    .run();
  return wroteClaimedRow(result);
}

/** تأجيل بلا فقدان: تبقى النسخة محفوظة ويُسجَّل أقرب وقت لإعادة التدقيق. */
export async function deferVerification(env, versionId, seconds, detail, claimId) {
  const wait = Math.max(1, Math.round(Number(seconds) || 60));
  if (!claimId) return 0;
  const result = await env.DB.prepare(
    claimWriteSql(`verify_after = datetime('now', ?), verify_detail = ?`),
  )
    .bind(`+${wait} seconds`, String(detail || "").slice(0, 240), versionId, claimId)
    .run();
  return wroteClaimedRow(result) ? wait : 0;
}

export function isReadyForApproval(version) {
  return Boolean(version) && version.verify_state === VERIFY_STATE.PASSED;
}

/**
 * يجمّد ما رآه المراجع فعلًا. النسخة المعتمدة وأدلتها تبقى حتى لو تغيّر المصدر
 * أو أُعيد التلخيص بعد ذلك.
 */
export async function recordDecision(env, { itemId, version, decision, reviewer, note, sourceText }) {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO approvals (
       id, item_id, version_id, decision, reviewer, reviewer_known, decided_at,
       source_hash, title_ar, snippet_ar, evidence, source_snapshot, note
     ) VALUES (?, ?, ?, ?, ?, 1, datetime('now'), ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      itemId,
      version.id,
      decision,
      reviewer,
      version.source_hash,
      version.title_ar,
      version.snippet_ar,
      version.evidence,
      String(sourceText || "").slice(0, 20000),
      note || null,
    )
    .run();
  if (decision === "approved") {
    await env.DB.prepare(
      `UPDATE items SET approved_version_id = ?, needs_review = 0 WHERE id = ?`,
    )
      .bind(version.id, itemId)
      .run();
  }
  return id;
}

export async function decisionsFor(env, itemId) {
  const { results } = await env.DB.prepare(
    `SELECT id, version_id, decision, reviewer, reviewer_known, decided_at,
            source_hash, title_ar, snippet_ar, note
     FROM approvals WHERE item_id = ? ORDER BY decided_at DESC`,
  )
    .bind(itemId)
    .all();
  return results || [];
}

/** الصفوف التي يجب ألا يمسّها التقليم: أي خبر يحمل قرارًا محفوظًا. */
export function protectedItemsSql(alias = "items") {
  return `EXISTS (SELECT 1 FROM approvals WHERE approvals.item_id = ${alias}.id)`;
}
