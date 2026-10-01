import {
  CONTINUATION_DEFER_CEILING,
  CONTINUATION_MAX_SECONDS,
  CONTINUATION_MIN_SECONDS,
} from "../config.js";

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

export function earliestIso(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return left < right ? left : right;
}
