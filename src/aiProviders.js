/**
 * حوكمة نماذج القراءة.
 *
 * الشيفرة تغلق الفتحات: ثلاثة مسارات معروفة، بروتوكول كل مسار، وأسماء متغيرات
 * Cloudflare. هوية النموذج والرابط والحد والتفعيل تُقرأ من المتغيرات في لوحة
 * Cloudflare، والمفاتيح من الأسرار فقط. تغيير الطراز لاحقًا يتم هناك بلا تعديل
 * شيفرة. لا يُمرَّر المفتاح إلى الواجهة ولا إلى التشخيص.
 */

export const BRIEF_ENGINE_VERSION = "v2";

function text(env, name, fallback = "") {
  const value = env?.[name];
  if (value == null) return fallback;
  const trimmed = String(value).trim();
  return trimmed || fallback;
}

function flag(env, name, defaultOn = true) {
  const raw = text(env, name, "");
  if (!raw) return defaultOn;
  return !["0", "false", "off", "no"].includes(raw.toLowerCase());
}

function positiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), min), max);
}

/**
 * الفتحات المغلقة. إضافة مسار رابع تحتاج صفًا هنا، أما تبديل الطراز داخل
 * الفتحة فمتغير Cloudflare كافٍ.
 */
export const AI_SLOTS = [
  {
    id: "gemini",
    nameAr: "جيميني",
    protocol: "gemini",
    keyVar: "GEMINI_API_KEY",
    modelVar: "GEMINI_MODEL",
    enabledVar: "GEMINI_ENABLED",
    dailyLimitVar: "AI_DAILY_LIMIT",
    intervalVar: "AI_MIN_INTERVAL_MS",
    baseUrlVar: "GEMINI_BASE_URL",
    defaultModel: "gemini-3.5-flash-lite",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/interactions",
    defaultDailyLimit: 400,
    defaultIntervalMs: 4500,
  },
  {
    id: "deepseek",
    nameAr: "ديبسيك",
    protocol: "openai",
    keyVar: "DEEPSEEK_API_KEY",
    modelVar: "DEEPSEEK_MODEL",
    enabledVar: "DEEPSEEK_ENABLED",
    dailyLimitVar: "DEEPSEEK_DAILY_LIMIT",
    intervalVar: "DEEPSEEK_MIN_INTERVAL_MS",
    baseUrlVar: "DEEPSEEK_BASE_URL",
    defaultModel: "deepseek-flash",
    defaultBaseUrl: "https://api.deepseek.com/v1",
    defaultDailyLimit: 2000,
    defaultIntervalMs: 800,
    disableThinking: true,
  },
  {
    id: "qwen",
    nameAr: "كوين",
    protocol: "openai",
    keyVar: "QWEN_API_KEY",
    modelVar: "QWEN_MODEL",
    enabledVar: "QWEN_ENABLED",
    dailyLimitVar: "QWEN_DAILY_LIMIT",
    intervalVar: "QWEN_MIN_INTERVAL_MS",
    baseUrlVar: "QWEN_BASE_URL",
    defaultModel: "qwen-flash",
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    defaultDailyLimit: 2000,
    defaultIntervalMs: 800,
    // كوين للتفكير يرفض النداء غير المتدفق بلا هذا الحقل، فيبدو متوقفًا 30 دقيقة دون أن يبدأ.
    enableThinking: false,
  },
];

export function slotById(id) {
  return AI_SLOTS.find((slot) => slot.id === id) || null;
}

export function hasSlotKey(env, slot) {
  return Boolean(text(env, slot.keyVar));
}

export function slotEnabled(env, slot) {
  return flag(env, slot.enabledVar, true);
}

export function slotBound(env, slot) {
  return hasSlotKey(env, slot) && slotEnabled(env, slot);
}

export function slotModel(env, slot) {
  return text(env, slot.modelVar, slot.defaultModel);
}

export function slotBaseUrl(env, slot) {
  return text(env, slot.baseUrlVar, slot.defaultBaseUrl).replace(/\/+$/, "");
}

export function slotDailyLimit(env, slot) {
  return positiveInt(env?.[slot.dailyLimitVar], slot.defaultDailyLimit, 1, 100000);
}

export function slotIntervalMs(env, slot) {
  return positiveInt(env?.[slot.intervalVar], slot.defaultIntervalMs, 0, 600000);
}

export function slotKey(env, slot) {
  return text(env, slot.keyVar);
}

export function boundSlots(env) {
  return AI_SLOTS.filter((slot) => slotBound(env, slot));
}

export function firstBoundSlot(env) {
  return boundSlots(env)[0] || null;
}

export function boundSlot(env, id) {
  const slot = slotById(id);
  return slot && slotBound(env, slot) ? slot : null;
}

export function anyAiKey(env) {
  return AI_SLOTS.some((slot) => hasSlotKey(env, slot));
}

export function aiBriefEnabled(env) {
  return boundSlots(env).length > 0;
}

export function engineForSlot(env, slot) {
  if (!slot) return `brief-ai-gemini-${BRIEF_ENGINE_VERSION}:unbound`;
  return `brief-ai-${slot.id}-${BRIEF_ENGINE_VERSION}:${slotModel(env, slot)}`;
}

export function aiBriefEngine(env) {
  const slot = boundSlot(env, "gemini") || firstBoundSlot(env);
  return engineForSlot(env, slot);
}

export function completedBriefSql(alias = "items") {
  return `${alias}.trans_engine LIKE 'brief-ai-%-${BRIEF_ENGINE_VERSION}:%'`;
}

export function providerIdFromEngine(engine) {
  const match = String(engine || "").match(/^brief-ai-([a-z0-9]+)-v2:/i);
  return match?.[1]?.toLowerCase() || null;
}

export function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/**
 * لقطة للوحة التفاصيل: أسماء المتغيرات لا قيم الأسرار. الصفحة تعرض الربط
 * كما هو في Cloudflare الآن.
 */
export function slotBinding(env, slot) {
  return {
    id: slot.id,
    nameAr: slot.nameAr,
    protocol: slot.protocol,
    model: slotModel(env, slot),
    baseUrl: slot.protocol === "openai" ? slotBaseUrl(env, slot) : null,
    bound: slotBound(env, slot),
    enabled: slotEnabled(env, slot),
    hasKey: hasSlotKey(env, slot),
    dailyLimit: slotDailyLimit(env, slot),
    minIntervalMs: slotIntervalMs(env, slot),
    vars: {
      key: slot.keyVar,
      model: slot.modelVar,
      enabled: slot.enabledVar,
      dailyLimit: slot.dailyLimitVar,
      interval: slot.intervalVar,
      baseUrl: slot.baseUrlVar,
    },
  };
}

export function allSlotBindings(env) {
  return AI_SLOTS.map((slot) => slotBinding(env, slot));
}
