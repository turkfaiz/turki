/**
 * حاكم ميزانية الذكاء الاصطناعي.
 *
 * كل نداء لمزوّد يمر من هنا أولًا، وميزانية كل فتحة مستقلة: رفض جيميني لا يوقف
 * ديبسيك. الهدف أن يصبح نفاد الحصة حالة نظام معروفة ومُدارة، لا خطأ يُسجَّل
 * على الأخبار ويحرق محاولاتها.
 */

import { boundSlot, firstBoundSlot, slotById, slotDailyLimit, slotIntervalMs } from "./aiProviders.js";

const DEFAULT_PROVIDER = "gemini";

/** الدمج تحسين اختياري، أما الموجز فهو جوهر المنتج، فلا يأخذ الدمج إلا حصة صغيرة. */
const PURPOSE_SHARE = { brief: 1, merge: 0.3 };

const PROVIDER_COOLDOWN_SECONDS = 90;
const MAX_COOLDOWN_SECONDS = 6 * 3600;
const BUDGET_HISTORY_DAYS = 7;

/** حصة المزوّد اليومية تُصفَّر عند منتصف ليل المحيط الهادئ، فيتبعها عدادنا. */
const QUOTA_TIMEZONE = "America/Los_Angeles";
/** عند رفض المزوّد لحد يومي نتوقف ساعة ثم نجرب، بدل تخمين لحظة التصفير. */
const DAILY_PROBE_SECONDS = 3600;

export const AI_DEFERRED = "ai_deferred";

export class AiDeferredError extends Error {
  constructor(reason, retryAfterSeconds, providerId = DEFAULT_PROVIDER) {
    super(`${AI_DEFERRED}:${reason}`);
    this.name = "AiDeferredError";
    this.deferred = true;
    this.reason = reason;
    this.providerId = providerId;
    this.retryAfterSeconds = Math.max(1, Math.round(retryAfterSeconds) || 1);
  }
}

export function isDeferredAiError(error) {
  return Boolean(error?.deferred);
}

export function resolveProviderId(env, providerId) {
  if (providerId && slotById(providerId)) return providerId;
  return boundSlot(env, DEFAULT_PROVIDER)?.id || firstBoundSlot(env)?.id || DEFAULT_PROVIDER;
}

export function budgetSettings(env, providerId = DEFAULT_PROVIDER) {
  const slot = slotById(providerId) || slotById(DEFAULT_PROVIDER);
  return {
    providerId: slot.id,
    dailyLimit: slotDailyLimit(env, slot),
    minIntervalMs: slotIntervalMs(env, slot),
  };
}

export function purposeLimit(dailyLimit, purpose) {
  const share = PURPOSE_SHARE[purpose] ?? 1;
  return Math.max(1, Math.floor(dailyLimit * share));
}

export function quotaDay(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: QUOTA_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function secondsUntilQuotaReset(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: QUOTA_TIMEZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const value = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  const elapsed = (value("hour") % 24) * 3600 + value("minute") * 60 + value("second");
  return Math.max(60, 86400 - elapsed);
}

function secondsUntil(iso, now = new Date()) {
  if (!iso) return 0;
  const at = Date.parse(`${String(iso).replace(" ", "T")}Z`);
  if (!Number.isFinite(at)) return 0;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

async function readDay(env, day, providerId) {
  return env.DB.prepare(
    `SELECT day, provider, calls, last_call_at, blocked_until, block_reason
     FROM ai_provider_budget WHERE day = ? AND provider = ?`,
  )
    .bind(day, providerId)
    .first();
}

/**
 * يحجز نداءً واحدًا ذريًا على فتحة واحدة. الشرط داخل جملة SQL نفسها حتى لا
 * يتجاوز السقف عاملان متزامنان في الطابور.
 */
export async function reserveAiCall(env, purpose = "brief", providerId = DEFAULT_PROVIDER) {
  const id = resolveProviderId(env, providerId);
  const { dailyLimit, minIntervalMs } = budgetSettings(env, id);
  const limit = purposeLimit(dailyLimit, purpose);
  const day = quotaDay();
  const pacing = `-${(minIntervalMs / 1000).toFixed(3)} seconds`;

  const result = await env.DB.prepare(
    `INSERT INTO ai_provider_budget (day, provider, calls, last_call_at)
     VALUES (?, ?, 1, datetime('now'))
     ON CONFLICT(day, provider) DO UPDATE
       SET calls = ai_provider_budget.calls + 1, last_call_at = datetime('now')
       WHERE ai_provider_budget.calls < ?
         AND (ai_provider_budget.blocked_until IS NULL
              OR ai_provider_budget.blocked_until <= datetime('now'))
         AND (ai_provider_budget.last_call_at IS NULL
              OR ai_provider_budget.last_call_at <= datetime('now', ?))`,
  )
    .bind(day, id, limit, pacing)
    .run();

  if (Number(result?.meta?.changes) > 0) return { ok: true, purpose, limit, providerId: id };

  const row = await readDay(env, day, id);
  const cooldown = secondsUntil(row?.blocked_until);
  if (cooldown > 0) {
    return {
      ok: false,
      providerId: id,
      reason: row?.block_reason || "provider_cooldown",
      retryAfterSeconds: cooldown,
    };
  }
  if (Number(row?.calls || 0) >= limit) {
    return {
      ok: false,
      providerId: id,
      reason: purpose === "brief" ? "daily_limit" : "merge_share_spent",
      retryAfterSeconds: secondsUntilQuotaReset(),
    };
  }
  return {
    ok: false,
    providerId: id,
    reason: "rate_pacing",
    retryAfterSeconds: Math.max(1, Math.ceil(minIntervalMs / 1000)),
  };
}

/** يوقف فتحة واحدة مؤقتًا بدل أن يصطدم كل عامل بالحد بمفرده. */
export async function blockAiCalls(
  env,
  seconds,
  reason = "provider_cooldown",
  providerId = DEFAULT_PROVIDER,
) {
  const id = resolveProviderId(env, providerId);
  const wait = Math.min(Math.max(Math.round(seconds) || PROVIDER_COOLDOWN_SECONDS, 1), MAX_COOLDOWN_SECONDS);
  const day = quotaDay();
  await env.DB.prepare(
    `INSERT INTO ai_provider_budget (day, provider, calls, blocked_until, block_reason)
     VALUES (?, ?, 0, datetime('now', ?), ?)
     ON CONFLICT(day, provider) DO UPDATE
       SET blocked_until = MAX(IFNULL(ai_provider_budget.blocked_until, ''), datetime('now', ?)),
           block_reason = ?`,
  )
    .bind(day, id, `+${wait} seconds`, reason, `+${wait} seconds`, reason)
    .run();
  return wait;
}

/**
 * يترجم رفض المزوّد إلى تبريد على مستوى فتحته فقط. حصة اليوم المنتهية توقف
 * تلك الفتحة حتى إعادة الفحص، أما حد الدقيقة فيوقفها لحظيًا فقط.
 */
export async function noteAiFailure(env, error, providerId = DEFAULT_PROVIDER) {
  const id = resolveProviderId(env, providerId);
  const status = Number(error?.status) || 0;
  if (status !== 429 && status < 500) return 0;
  if (status >= 500) {
    return blockAiCalls(env, error?.retryAfterSeconds || 30, "provider_error", id);
  }
  if (error?.quotaScope === "day") {
    return blockAiCalls(
      env,
      Math.min(DAILY_PROBE_SECONDS, secondsUntilQuotaReset()),
      "daily_limit",
      id,
    );
  }
  return blockAiCalls(
    env,
    error?.retryAfterSeconds || PROVIDER_COOLDOWN_SECONDS,
    "provider_cooldown",
    id,
  );
}

/**
 * عدد النداءات التي يمكن تنفيذها الآن لهذه الفتحة. الحجز يمنع تجاوز الحد،
 * ومعرفة السعة مقدمًا تمنع مطالبة صفوف لن تُخدم.
 */
export async function availableAiCalls(env, purpose = "brief", providerId = DEFAULT_PROVIDER) {
  const id = resolveProviderId(env, providerId);
  const { dailyLimit, minIntervalMs } = budgetSettings(env, id);
  const limit = purposeLimit(dailyLimit, purpose);
  const row = await readDay(env, quotaDay(), id);
  if (!row) return limit;
  if (secondsUntil(row.blocked_until) > 0) return 0;
  const left = Math.max(0, limit - Number(row.calls || 0));
  if (!left) return 0;
  if (minIntervalMs > 0 && secondsUntil(row.last_call_at) === 0) {
    const since = Date.now() - Date.parse(`${String(row.last_call_at).replace(" ", "T")}Z`);
    if (Number.isFinite(since) && since < minIntervalMs) return 0;
    return Math.min(left, 1);
  }
  return left;
}

export function formatBudgetState(row, dailyLimit, minIntervalMs, providerId) {
  const used = Number(row?.calls || 0);
  const cooldown = secondsUntil(row?.blocked_until);
  return {
    providerId,
    day: row?.day || quotaDay(),
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

export async function budgetState(env, providerId = DEFAULT_PROVIDER) {
  const id = resolveProviderId(env, providerId);
  const { dailyLimit, minIntervalMs } = budgetSettings(env, id);
  const row = await readDay(env, quotaDay(), id);
  return formatBudgetState(row, dailyLimit, minIntervalMs, id);
}

export async function pruneAiBudget(env) {
  await env.DB.prepare(
    `DELETE FROM ai_provider_budget WHERE day < date('now', '-${BUDGET_HISTORY_DAYS} days')`,
  ).run();
  await env.DB.prepare(
    `DELETE FROM ai_budget WHERE day < date('now', '-${BUDGET_HISTORY_DAYS} days')`,
  ).run();
}
