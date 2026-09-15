/**
 * نهاية رحلة الرصد.
 *
 * جمع المصادر لا يعني اكتمال المهمة. بعد الصفحات تنتقل المهمة إلى القراءة ثم
 * التدقيق، ولا تُعلَن مكتملة إلا حين تستقر كل أخبار ذلك المسح: جاهزة للقرار،
 * أو تحتاج تدخلاً، أو صدر فيها قرار نهائي. تعطّل نموذج واحد لا يوقف الآخر،
 * وتعطّل الاثنين انتظارٌ بوقت استئناف لا إعلان اكتمال.
 */

import { boundSlots } from "./aiProviders.js";
import {
  DESK_LANES,
  currentVerifyStateSql,
  deskLaneCaseSql,
} from "./deskLanes.js";
import { VERIFY_STATE, verificationBacklog } from "./versions.js";
import { briefBacklog, slotsWithCapacity } from "./translate.js";

export const JOURNEY_STAGES = {
  AI_READING: "ai_reading",
  VERIFYING: "verifying",
  WAITING: "waiting",
  RETRYING: "retrying",
  COMPLETED: "completed",
};

export function scanItemSettledSql(alias = "items") {
  const lane = deskLaneCaseSql(alias);
  return `(
    ${alias}.status IN ('approved', 'excluded')
    OR ${lane} IN ('${DESK_LANES.DECISION_READY}', '${DESK_LANES.ATTENTION_REQUIRED}')
    OR (
      ${alias}.current_version_id IS NOT NULL
      AND ${currentVerifyStateSql(alias)} = '${VERIFY_STATE.PASSED}'
    )
  )`;
}

function parseTaskResult(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export async function resolveScanId(env, { jobId, mayorId, scanId = null } = {}) {
  if (scanId) return scanId;
  if (!jobId || !mayorId) return null;
  const linked = await env.DB.prepare(
    `SELECT scan_id FROM scan_sources WHERE job_id = ? AND mayor_id = ? LIMIT 1`,
  )
    .bind(jobId, mayorId)
    .first();
  if (linked?.scan_id) return linked.scan_id;
  const task = await env.DB.prepare(
    `SELECT result_json FROM search_job_tasks WHERE job_id = ? AND mayor_id = ?`,
  )
    .bind(jobId, mayorId)
    .first();
  return parseTaskResult(task?.result_json).scanId || null;
}

function journeyCountsSql() {
  const settled = scanItemSettledSql("items");
  const lane = deskLaneCaseSql("items");
  return `SELECT
       COUNT(*) AS total,
       SUM(CASE WHEN ${settled} THEN 1 ELSE 0 END) AS settled,
       SUM(CASE WHEN NOT ${settled} AND (${lane}) = '${DESK_LANES.READING}' THEN 1 ELSE 0 END) AS reading,
       SUM(CASE WHEN NOT ${settled} AND (${lane}) = '${DESK_LANES.VERIFYING}' THEN 1 ELSE 0 END) AS verifying
     FROM items
     WHERE items.mayor_id = ? AND items.scan_id = ?`;
}

function soonestIso(...values) {
  const dates = values
    .map((value) => {
      if (!value) return null;
      const at = Date.parse(`${String(value).replace(" ", "T")}Z`);
      return Number.isFinite(at) ? { value, at } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.at - b.at);
  return dates[0]?.value || null;
}

/**
 * إن بقي أحد النموذجين يعمل تستمر الرحلة عليه. إن توقفا معًا فالحالة
 * انتظار/إعادة محاولة مع وقت الاستئناف، لا اكتمال.
 */
export async function assessMayorJourney(env, { mayorId, scanId }) {
  if (!mayorId || !scanId) {
    return {
      status: "running",
      stage: JOURNEY_STAGES.AI_READING,
      detail: "اكتمل جمع الصفحات وبقيت قراءة النماذج",
      total: 0,
      settled: 0,
      reading: 0,
      verifying: 0,
      unresolved: true,
      blocked: false,
      resumeAt: null,
    };
  }

  const counts = await env.DB.prepare(journeyCountsSql()).bind(mayorId, scanId).first();
  const total = Number(counts?.total) || 0;
  const settled = Number(counts?.settled) || 0;
  const reading = Number(counts?.reading) || 0;
  const verifying = Number(counts?.verifying) || 0;
  const unsettled = Math.max(0, total - settled);

  if (unsettled <= 0) {
    return {
      status: "completed",
      stage: JOURNEY_STAGES.COMPLETED,
      detail: total
        ? `استقرت أخبار المسح: ${settled} خبرًا جاهزًا أو متدخَّلًا أو مقررًا`
        : "اكتمل جمع الصفحات ولا أخبار معلّقة في هذا المسح",
      total,
      settled,
      reading,
      verifying,
      blocked: false,
      resumeAt: null,
    };
  }

  const bound = boundSlots(env);
  const ready = bound.length ? await slotsWithCapacity(env, "brief") : [];
  const blocked = bound.length > 0 && ready.length === 0;
  const brief = await briefBacklog(env, mayorId);
  const verify = await verificationBacklog(env);
  const resumeAt = soonestIso(brief.nextAt, verify.nextAt);

  if (blocked) {
    const stage = resumeAt ? JOURNEY_STAGES.RETRYING : JOURNEY_STAGES.WAITING;
    return {
      status: stage,
      stage,
      detail: resumeAt
        ? `توقفت النماذج مؤقتًا ويستأنف العمل تلقائيًا عند ${resumeAt}`
        : "توقفت النماذج المربوطة وبقيت الأخبار بانتظار استئناف الحصة",
      total,
      settled,
      reading,
      verifying,
      blocked: true,
      resumeAt,
      pending: brief.pending + verify.pending,
    };
  }

  if (reading > 0) {
    return {
      status: "running",
      stage: JOURNEY_STAGES.AI_READING,
      detail: `يقرأ النماذج ${reading} خبرًا، وبقي ${verifying} بانتظار التدقيق`,
      total,
      settled,
      reading,
      verifying,
      blocked: false,
      resumeAt,
    };
  }

  return {
    status: "running",
    stage: JOURNEY_STAGES.VERIFYING,
    detail: `يدقّق ${verifying} موجزًا بعد القراءة`,
    total,
    settled,
    reading,
    verifying,
    blocked: false,
    resumeAt,
  };
}

export function shouldContinueJourney(briefSummary, verifySummary) {
  const pending = (Number(briefSummary?.pending) || 0) + (Number(verifySummary?.pending) || 0);
  if (pending <= 0 || briefSummary?.unconfigured) return false;
  const eligible =
    (Number(briefSummary?.eligible) || 0) + (Number(verifySummary?.eligible) || 0);
  if (eligible > 0 && !briefSummary?.deferred && !verifySummary?.deferred) return true;
  return pending > 0;
}
