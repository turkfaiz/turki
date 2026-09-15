/**
 * مسارات المكتب التشغيلي.
 *
 * «بانتظار القرار» كان يخلط ما زال يُقرأ مع ما اكتمل موجزه. اكتمال
 * trans_engine لا يعني أن الخبر جاهز للاعتماد: الاعتماد قرار على نسخة
 * مدقّقة داخل نافذة العرض. المسارات هنا مشتقة من الحالة الفعلية، لا من
 * نصوص الواجهة، ولا يُحذف خبر لنقله بينها.
 */

import { BRIEF_STATE } from "./aiBrief.js";
import { MAX_BRIEF_ATTEMPTS } from "./aiDispatch.js";
import { completedBriefSql } from "./aiProviders.js";
import { SEED_MAYOR_IDS } from "./mayors.js";
import { MAX_VERIFY_ATTEMPTS, VERIFY_STATE } from "./versions.js";

export const DISPLAY_WINDOW_DAYS = 7;

export const DESK_LANES = {
  READING: "reading",
  VERIFYING: "verifying",
  DECISION_READY: "decision_ready",
  ATTENTION_REQUIRED: "attention_required",
};

export const DESK_LANE_VALUES = Object.values(DESK_LANES);

export const ITEM_STATUSES = ["approved", "excluded"];

export const LANE_ALIASES = {
  inbox: DESK_LANES.DECISION_READY,
  waiting: DESK_LANES.READING,
  decision: DESK_LANES.DECISION_READY,
};

export const LANE_LABELS_AR = {
  [DESK_LANES.READING]: "قيد القراءة",
  [DESK_LANES.VERIFYING]: "التدقيق",
  [DESK_LANES.DECISION_READY]: "بانتظار القرار",
  [DESK_LANES.ATTENTION_REQUIRED]: "يحتاج تدخلاً",
};

export const ATTENTION_REASONS = {
  VERIFY_FAILED: "verify_failed",
  MISSING_VERSION: "missing_version",
  AI_UNCONFIGURED: "ai_unconfigured",
  BRIEF_EXHAUSTED: "brief_exhausted",
  BRIEF_ERROR: "brief_error",
  BRIEF_WITHOUT_VERSION: "brief_without_version",
  VERIFY_EXHAUSTED: "verify_exhausted",
};

export const ATTENTION_REASON_AR = {
  [ATTENTION_REASONS.VERIFY_FAILED]: "رُفض الموجز في التدقيق الدلالي ويحتاج مراجعة أو إعادة إنتاج.",
  [ATTENTION_REASONS.MISSING_VERSION]: "current_version_id يشير إلى نسخة غير موجودة، فلا يُعتمد الخبر.",
  [ATTENTION_REASONS.AI_UNCONFIGURED]: "مفتاح الذكاء الاصطناعي غير مربوط، فتوقفت القراءة.",
  [ATTENTION_REASONS.BRIEF_EXHAUSTED]: "استُنفدت محاولات التلخيص دون موجز صالح.",
  [ATTENTION_REASONS.BRIEF_ERROR]: "تعذر التلخيص بعد خطأ تشغيلي ويحتاج تدخلاً.",
  [ATTENTION_REASONS.BRIEF_WITHOUT_VERSION]: "يوجد موجز مكتمل بلا نسخة محفوظة، فلا يُعتمد.",
  [ATTENTION_REASONS.VERIFY_EXHAUSTED]: "استُنفدت محاولات التدقيق دون اجتياز.",
};

export const DESK_LANE_EPOCH = "desk-lanes-v1";
export const DESK_LANE_REPORT_KEY = "desk_lane_migration_report";

const PROTECTED_COUNT_KEYS = [
  "approvals",
  "brief_versions",
  "passed_versions",
  "approved_versions",
  "evidence_rows",
  "decided_items",
  "items",
  "scans",
  "jobs",
  "sources",
  "mayors",
  "custom_mayors",
  "ai_calls",
];

export function inDisplayWindowSql(alias = "items") {
  return `COALESCE(${alias}.published_at, ${alias}.created_at) >= datetime('now', '-${DISPLAY_WINDOW_DAYS} days')`;
}

export function currentVerifyStateSql(alias = "items") {
  return `(SELECT verify_state FROM brief_versions WHERE brief_versions.id = ${alias}.current_version_id)`;
}

export function currentVerifyAttemptsSql(alias = "items") {
  return `(SELECT verify_attempts FROM brief_versions WHERE brief_versions.id = ${alias}.current_version_id)`;
}

/**
 * جاهزية القرار: نسخة حالية + تدقيق مجتاز + داخل نافذة العرض.
 * اكتمال trans_engine وحده لا يكفي.
 */
export function decisionReadySql(alias = "items") {
  return `${alias}.status = 'inbox'
    AND ${alias}.current_version_id IS NOT NULL
    AND ${currentVerifyStateSql(alias)} = '${VERIFY_STATE.PASSED}'
    AND ${inDisplayWindowSql(alias)}`;
}

/**
 * المسار اللحظي من الحالة الفعلية. لا تُقرأ items.desk_lane المخزّنة في واجهة
 * البرمجة: القيمة المخزّنة تتقادم بعد انتقال الخبر.
 */
export function deskLaneCaseSql(alias = "items") {
  const verifyState = currentVerifyStateSql(alias);
  const verifyAttempts = currentVerifyAttemptsSql(alias);
  return `CASE
    WHEN ${alias}.status <> 'inbox' THEN NULL
    WHEN ${alias}.current_version_id IS NOT NULL
         AND ${verifyState} = '${VERIFY_STATE.PASSED}'
         AND ${inDisplayWindowSql(alias)}
      THEN '${DESK_LANES.DECISION_READY}'
    WHEN ${alias}.current_version_id IS NOT NULL
         AND ${verifyState} = '${VERIFY_STATE.PASSED}'
      THEN NULL
    WHEN ${alias}.current_version_id IS NOT NULL
         AND ${verifyState} = '${VERIFY_STATE.FAILED}'
      THEN '${DESK_LANES.ATTENTION_REQUIRED}'
    WHEN ${alias}.current_version_id IS NOT NULL
         AND ${verifyState} IS NULL
      THEN '${DESK_LANES.ATTENTION_REQUIRED}'
    WHEN IFNULL(${alias}.trans_engine, '') = '${BRIEF_STATE.UNCONFIGURED}'
      THEN '${DESK_LANES.ATTENTION_REQUIRED}'
    WHEN IFNULL(${alias}.brief_attempts, 0) >= ${MAX_BRIEF_ATTEMPTS}
      THEN '${DESK_LANES.ATTENTION_REQUIRED}'
    WHEN IFNULL(${alias}.trans_engine, '') = '${BRIEF_STATE.FAILED}'
      THEN '${DESK_LANES.ATTENTION_REQUIRED}'
    WHEN (${completedBriefSql(alias)}) AND ${alias}.current_version_id IS NULL
      THEN '${DESK_LANES.ATTENTION_REQUIRED}'
    WHEN ${alias}.current_version_id IS NOT NULL
         AND IFNULL(${verifyAttempts}, 0) >= ${MAX_VERIFY_ATTEMPTS}
      THEN '${DESK_LANES.ATTENTION_REQUIRED}'
    WHEN ${alias}.current_version_id IS NOT NULL
         AND ${verifyState} = '${VERIFY_STATE.PENDING}'
      THEN '${DESK_LANES.VERIFYING}'
    ELSE '${DESK_LANES.READING}'
  END`;
}

export function attentionReasonCaseSql(alias = "items") {
  const verifyState = currentVerifyStateSql(alias);
  const verifyAttempts = currentVerifyAttemptsSql(alias);
  return `CASE
    WHEN (${deskLaneCaseSql(alias)}) <> '${DESK_LANES.ATTENTION_REQUIRED}' THEN NULL
    WHEN ${alias}.current_version_id IS NOT NULL
         AND ${verifyState} = '${VERIFY_STATE.FAILED}'
      THEN '${ATTENTION_REASONS.VERIFY_FAILED}'
    WHEN ${alias}.current_version_id IS NOT NULL
         AND ${verifyState} IS NULL
      THEN '${ATTENTION_REASONS.MISSING_VERSION}'
    WHEN IFNULL(${alias}.trans_engine, '') = '${BRIEF_STATE.UNCONFIGURED}'
      THEN '${ATTENTION_REASONS.AI_UNCONFIGURED}'
    WHEN IFNULL(${alias}.brief_attempts, 0) >= ${MAX_BRIEF_ATTEMPTS}
      THEN '${ATTENTION_REASONS.BRIEF_EXHAUSTED}'
    WHEN (${completedBriefSql(alias)}) AND ${alias}.current_version_id IS NULL
      THEN '${ATTENTION_REASONS.BRIEF_WITHOUT_VERSION}'
    WHEN ${alias}.current_version_id IS NOT NULL
         AND IFNULL(${verifyAttempts}, 0) >= ${MAX_VERIFY_ATTEMPTS}
      THEN '${ATTENTION_REASONS.VERIFY_EXHAUSTED}'
    WHEN IFNULL(${alias}.trans_engine, '') = '${BRIEF_STATE.FAILED}'
      THEN '${ATTENTION_REASONS.BRIEF_ERROR}'
    ELSE '${ATTENTION_REASONS.BRIEF_ERROR}'
  END`;
}

export function deskLanePredicateSql(lane, alias = "items") {
  if (!DESK_LANE_VALUES.includes(lane)) {
    throw new Error(`unknown_desk_lane:${lane}`);
  }
  return `(${deskLaneCaseSql(alias)}) = '${lane}'`;
}

export function deskLaneStatSql(alias = "items") {
  const lane = deskLaneCaseSql(alias);
  const windowed = inDisplayWindowSql(alias);
  return DESK_LANE_VALUES.map(
    (value) =>
      `SUM(CASE WHEN ${windowed} AND (${lane}) = '${value}' THEN 1 ELSE 0 END) AS ${value}`,
  ).join(",\n      ");
}

export function resolveDeskQuery(status, lane) {
  const raw = String(lane || status || LANE_ALIASES.inbox);
  if (LANE_ALIASES[raw]) {
    return { kind: "lane", value: LANE_ALIASES[raw], requested: raw };
  }
  if (DESK_LANE_VALUES.includes(raw)) {
    return { kind: "lane", value: raw, requested: raw };
  }
  if (ITEM_STATUSES.includes(raw)) {
    return { kind: "status", value: raw, requested: raw };
  }
  return { kind: "invalid", value: raw, requested: raw };
}

export async function ensureDeskLaneColumns(env) {
  const info = await env.DB.prepare(`PRAGMA table_info(items)`).all();
  const names = new Set((info.results || []).map((column) => column.name));
  if (!names.size) return names;
  if (!names.has("desk_lane")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN desk_lane TEXT`).run();
  }
  if (!names.has("desk_attention_reason")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN desk_attention_reason TEXT`).run();
  }
  /**
   * العمود المخزّن ليس مصدر الحقيقة: المسار يُحسب من الحالة الفعلية.
   * الإبقاء على العمود آمن إنتاجيًا، أما الفهرسة عليه فتوهم أن القيمة المخزّنة صالحة للقراءة.
   */
  await env.DB.prepare(`DROP INDEX IF EXISTS idx_items_desk_lane`).run();
  return names;
}

function placeholders(count) {
  return Array.from({ length: count }, () => "?").join(", ");
}

export async function countProtectedRecords(env) {
  const seedIds = [...SEED_MAYOR_IDS];
  const customMayors = seedIds.length
    ? await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM mayors WHERE id NOT IN (${placeholders(seedIds.length)})`,
      )
        .bind(...seedIds)
        .first()
    : { n: 0 };

  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM approvals) AS approvals,
       (SELECT COUNT(*) FROM brief_versions) AS brief_versions,
       (SELECT COUNT(*) FROM brief_versions WHERE verify_state = '${VERIFY_STATE.PASSED}') AS passed_versions,
       (SELECT COUNT(*) FROM brief_versions
         WHERE id IN (SELECT approved_version_id FROM items WHERE approved_version_id IS NOT NULL)
            OR id IN (SELECT version_id FROM approvals WHERE decision = 'approved')) AS approved_versions,
       (SELECT COUNT(*) FROM brief_versions WHERE IFNULL(evidence, '') <> '')
         + (SELECT COUNT(*) FROM approvals WHERE IFNULL(evidence, '') <> '') AS evidence_rows,
       (SELECT COUNT(*) FROM items
         WHERE EXISTS (SELECT 1 FROM approvals WHERE approvals.item_id = items.id)) AS decided_items,
       (SELECT COUNT(*) FROM items) AS items,
       (SELECT COUNT(*) FROM scans) AS scans,
       (SELECT COUNT(*) FROM search_jobs) AS jobs,
       (SELECT COUNT(*) FROM sources) AS sources,
       (SELECT COUNT(*) FROM mayors) AS mayors,
       (SELECT IFNULL(SUM(calls), 0) FROM ai_provider_budget) AS ai_calls`,
  ).first();

  return {
    approvals: Number(row?.approvals) || 0,
    brief_versions: Number(row?.brief_versions) || 0,
    passed_versions: Number(row?.passed_versions) || 0,
    approved_versions: Number(row?.approved_versions) || 0,
    evidence_rows: Number(row?.evidence_rows) || 0,
    decided_items: Number(row?.decided_items) || 0,
    items: Number(row?.items) || 0,
    scans: Number(row?.scans) || 0,
    jobs: Number(row?.jobs) || 0,
    sources: Number(row?.sources) || 0,
    mayors: Number(row?.mayors) || 0,
    custom_mayors: Number(customMayors?.n) || 0,
    ai_calls: Number(row?.ai_calls) || 0,
  };
}

function emptyLaneCounts() {
  return {
    [DESK_LANES.READING]: 0,
    [DESK_LANES.VERIFYING]: 0,
    [DESK_LANES.DECISION_READY]: 0,
    [DESK_LANES.ATTENTION_REQUIRED]: 0,
    unset: 0,
  };
}

function foldLaneCounts(rows) {
  const lanes = emptyLaneCounts();
  for (const row of rows || []) {
    const key = row.lane || "unset";
    lanes[key] = (lanes[key] || 0) + (Number(row.n) || 0);
  }
  return lanes;
}

export async function planDeskLaneMigration(env) {
  await ensureDeskLaneColumns(env);
  const protectedCounts = await countProtectedRecords(env);
  const { results: laneRows } = await env.DB.prepare(
    `SELECT ${deskLaneCaseSql("items")} AS lane, COUNT(*) AS n
     FROM items
     GROUP BY 1`,
  ).all();
  const wouldChange = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items
     WHERE IFNULL(desk_lane, '<null>') <> IFNULL(${deskLaneCaseSql("items")}, '<null>')
        OR IFNULL(desk_attention_reason, '<null>')
           <> IFNULL(${attentionReasonCaseSql("items")}, '<null>')`,
  ).first();

  return {
    dryRun: true,
    applied: false,
    epoch: DESK_LANE_EPOCH,
    wouldDelete: {
      items: 0,
      approvals: 0,
      brief_versions: 0,
      scans: 0,
      jobs: 0,
      sources: 0,
      mayors: 0,
      ai_budget: 0,
    },
    wouldChange: Number(wouldChange?.n) || 0,
    lanes: foldLaneCounts(laneRows),
    protected: protectedCounts,
  };
}

export function assertProtectedNotReduced(before, after) {
  const dropped = [];
  for (const key of PROTECTED_COUNT_KEYS) {
    if (Number(after[key]) < Number(before[key])) {
      dropped.push(`${key}: ${before[key]} → ${after[key]}`);
    }
  }
  if (dropped.length) {
    throw new Error(`desk_lane_migration_refused: ${dropped.join("; ")}`);
  }
}

export async function applyDeskLaneMigration(env, { dryRun = false } = {}) {
  const plan = await planDeskLaneMigration(env);
  if (dryRun) {
    return { ...plan, dryRun: true, applied: false };
  }

  await env.DB.prepare(
    `UPDATE items
     SET desk_lane = ${deskLaneCaseSql("items")},
         desk_attention_reason = ${attentionReasonCaseSql("items")}`,
  ).run();

  const protectedAfter = await countProtectedRecords(env);
  assertProtectedNotReduced(plan.protected, protectedAfter);

  const report = {
    ...plan,
    dryRun: false,
    applied: true,
    protectedAfter,
    appliedAt: new Date().toISOString(),
  };
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`)
    .bind(DESK_LANE_REPORT_KEY, JSON.stringify(report))
    .run();
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`)
    .bind("desk_lane_epoch", DESK_LANE_EPOCH)
    .run();
  return report;
}

export function publicLaneStats(row = {}) {
  const reading = Number(row.reading) || 0;
  const verifying = Number(row.verifying) || 0;
  const decisionReady = Number(row.decision_ready) || 0;
  const attentionRequired = Number(row.attention_required) || 0;
  return {
    reading,
    verifying,
    decision_ready: decisionReady,
    attention_required: attentionRequired,
    inbox: decisionReady,
    waiting: reading,
  };
}
