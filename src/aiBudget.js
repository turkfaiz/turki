/**
 * حاكم ميزانية الذكاء الاصطناعي.
 *
 * كل نداء لمزوّد الذكاء الاصطناعي يمر من هنا أولًا. الهدف أن يصبح نفاد الحصة
 * حالة نظام معروفة ومُدارة، لا خطأ يُسجَّل على الأخبار ويحرق محاولاتها.
 * الحاكم يفرض ثلاثة قيود: سقف يومي، وتباعد بين النداءات، وتبريد بعد رفض المزوّد.
 */

const DEFAULT_DAILY_LIMIT = 400;
const DEFAULT_MIN_INTERVAL_MS = 4000;

/** الدمج تحسين اختياري، أما الموجز فهو جوهر المنتج، فلا يأخذ الدمج إلا حصة صغيرة. */
const PURPOSE_SHARE = { brief: 1, merge: 0.3 };

const PROVIDER_COOLDOWN_SECONDS = 90;
const MAX_COOLDOWN_SECONDS = 6 * 3600;
const BUDGET_HISTORY_DAYS = 7;

export const AI_DEFERRED = "ai_deferred";

export class AiDeferredError extends Error {
  constructor(reason, retryAfterSeconds) {
    super(`${AI_DEFERRED}:${reason}`);
    this.name = "AiDeferredError";
    this.deferred = true;
    this.reason = reason;
    this.retryAfterSeconds = Math.max(1, Math.round(retryAfterSeconds) || 1);
  }
}

export function isDeferredAiError(error) {
  return Boolean(error?.deferred);
}

function positiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

export function budgetSettings(env) {
  return {
    dailyLimit: positiveInt(env?.AI_DAILY_LIMIT, DEFAULT_DAILY_LIMIT, 1, 100000),
    minIntervalMs: positiveInt(env?.AI_MIN_INTERVAL_MS, DEFAULT_MIN_INTERVAL_MS, 0, 600000),
  };
}

export function purposeLimit(dailyLimit, purpose) {
  const share = PURPOSE_SHARE[purpose] ?? 1;
  return Math.max(1, Math.floor(dailyLimit * share));
}

export function utcDay(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function secondsUntilUtcMidnight(now = new Date()) {
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  );
  return Math.max(60, Math.ceil((next - now.getTime()) / 1000));
}

function secondsUntil(iso, now = new Date()) {
  if (!iso) return 0;
  const at = Date.parse(`${String(iso).replace(" ", "T")}Z`);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

async function readDay(env, day) {
  return env.DB.prepare(
    `SELECT day, calls, last_call_at, blocked_until, block_reason
     FROM ai_budget WHERE day = ?`,
  )
    .bind(day)
    .first();
}

/**
 * يحجز نداءً واحدًا ذريًا. الشرط داخل جملة SQL نفسها حتى لا يتجاوز السقف
 * عاملان متزامنان في الطابور.
 */
export async function reserveAiCall(env, purpose = "brief") {
  const { dailyLimit, minIntervalMs } = budgetSettings(env);
  const limit = purposeLimit(dailyLimit, purpose);
  const day = utcDay();
  const pacing = `-${(minIntervalMs / 1000).toFixed(3)} seconds`;

  const result = await env.DB.prepare(
    `INSERT INTO ai_budget (day, calls, last_call_at) VALUES (?, 1, datetime('now'))
     ON CONFLICT(day) DO UPDATE
       SET calls = ai_budget.calls + 1, last_call_at = datetime('now')
       WHERE ai_budget.calls < ?
         AND (ai_budget.blocked_until IS NULL OR ai_budget.blocked_until <= datetime('now'))
         AND (ai_budget.last_call_at IS NULL OR ai_budget.last_call_at <= datetime('now', ?))`,
  )
    .bind(day, limit, pacing)
    .run();

  if (Number(result?.meta?.changes) > 0) return { ok: true, purpose, limit };

  const row = await readDay(env, day);
  const cooldown = secondsUntil(row?.blocked_until);
  if (cooldown > 0) {
    return {
      ok: false,
      reason: row?.block_reason || "provider_cooldown",
      retryAfterSeconds: cooldown,
    };
  }
  if (Number(row?.calls || 0) >= limit) {
    return {
      ok: false,
      reason: purpose === "brief" ? "daily_limit" : "merge_share_spent",
      retryAfterSeconds:
        purpose === "brief" ? secondsUntilUtcMidnight() : secondsUntilUtcMidnight(),
    };
  }
  return {
    ok: false,
    reason: "rate_pacing",
    retryAfterSeconds: Math.max(1, Math.ceil(minIntervalMs / 1000)),
  };
}

/** يوقف كل النظام مؤقتًا بدل أن يصطدم كل عامل بالحد بمفرده. */
export async function blockAiCalls(env, seconds, reason = "provider_cooldown") {
  const wait = Math.min(Math.max(Math.round(seconds) || PROVIDER_COOLDOWN_SECONDS, 1), MAX_COOLDOWN_SECONDS);
  const day = utcDay();
  await env.DB.prepare(
    `INSERT INTO ai_budget (day, calls, blocked_until, block_reason)
     VALUES (?, 0, datetime('now', ?), ?)
     ON CONFLICT(day) DO UPDATE
       SET blocked_until = MAX(IFNULL(ai_budget.blocked_until, ''), datetime('now', ?)),
           block_reason = ?`,
  )
    .bind(day, `+${wait} seconds`, reason, `+${wait} seconds`, reason)
    .run();
  return wait;
}

/**
 * يترجم رفض المزوّد إلى تبريد على مستوى النظام. حصة اليوم المنتهية توقف العمل
 * حتى منتصف الليل بتوقيت UTC، أما حد الدقيقة فيوقفه لحظيًا فقط.
 */
export async function noteAiFailure(env, error) {
  const status = Number(error?.status) || 0;
  if (status !== 429 && status < 500) return 0;
  if (status >= 500) {
    return blockAiCalls(env, error?.retryAfterSeconds || 30, "provider_error");
  }
  if (error?.quotaScope === "day") {
    return blockAiCalls(env, secondsUntilUtcMidnight(), "daily_limit");
  }
  return blockAiCalls(
    env,
    error?.retryAfterSeconds || PROVIDER_COOLDOWN_SECONDS,
    "provider_cooldown",
  );
}

export async function budgetState(env) {
  const { dailyLimit, minIntervalMs } = budgetSettings(env);
  const day = utcDay();
  const row = await readDay(env, day);
  const used = Number(row?.calls || 0);
  const cooldown = secondsUntil(row?.blocked_until);
  return {
    day,
    used,
    dailyLimit,
    remaining: Math.max(0, dailyLimit - used),
    minIntervalMs,
    mergeLimit: purposeLimit(dailyLimit, "merge"),
    blocked: cooldown > 0,
    blockReason: cooldown > 0 ? row?.block_reason || "provider_cooldown" : null,
    resumesInSeconds: cooldown,
  };
}

export async function pruneAiBudget(env) {
  await env.DB.prepare(
    `DELETE FROM ai_budget WHERE day < date('now', '-${BUDGET_HISTORY_DAYS} days')`,
  ).run();
}
