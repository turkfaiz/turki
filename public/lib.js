/** أدوات مشتركة بين صفحة الرصد وصفحة الإعدادات. */

export const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export const num = (value) => new Intl.NumberFormat("en-US").format(Number(value) || 0);

/** تواريخ D1 بلا منطقة زمنية ("2026-10-01 07:18:38") وهي UTC. */
export function parseDbDate(value) {
  if (!value) return null;
  const raw = String(value);
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** مفرد/مثنى/جمع القلة/جمع الكثرة بالعربية: [1, 2, 3-10, 11+]. */
export function plural(n, [one, two, few, many]) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return `${num(n)} ${few}`;
  return `${num(n)} ${many}`;
}

const UNITS = {
  second: ["ثانية", "ثانيتين", "ثوانٍ", "ثانية"],
  minute: ["دقيقة", "دقيقتين", "دقائق", "دقيقة"],
  hour: ["ساعة", "ساعتين", "ساعات", "ساعة"],
  day: ["يوم", "يومين", "أيام", "يومًا"],
  office: ["مكتب واحد", "مكتبان", "مكاتب", "مكتبًا"],
};

/** عدد ووحدة بصيغة سليمة: «دقيقتين»، «5 دقائق»، «12 دقيقة». */
export function amount(n, unit) {
  const forms = UNITS[unit];
  return n === 1 || n === 2 ? forms[n - 1] : plural(n, forms);
}

export function relTime(value, now = Date.now(), empty = "لم يُفحص بعد") {
  const date = parseDbDate(value);
  if (!date) return empty;
  const minutes = Math.round((now - date.getTime()) / 60000);
  if (minutes < 1) return "الآن";
  if (minutes < 60) return `قبل ${amount(minutes, "minute")}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `قبل ${amount(hours, "hour")}`;
  return `قبل ${amount(Math.round(hours / 24), "day")}`;
}

/** مدة بين لحظتين بصيغة مقروءة: «45 ثانية»، «3 دقائق». */
export function duration(from, to = Date.now()) {
  const start = parseDbDate(from);
  if (!start) return "";
  const end = typeof to === "number" ? to : (parseDbDate(to)?.getTime() ?? Date.now());
  const seconds = Math.max(0, Math.round((end - start.getTime()) / 1000));
  if (seconds < 90) return amount(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return amount(minutes, "minute");
  return amount(Math.round(minutes / 60), "hour");
}

/** تاريخ بتوقيت الرياض، للتلميح وللنص الكامل. */
export function fmtDate(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.message || data.error || "request_failed");
    error.data = data;
    throw error;
  }
  return data;
}

/** رموز حالة المواقع كما تسجلها الشيفرة، بالعربية. */
export const SOURCE_STATUS_AR = {
  ok: "تعمل",
  ok_no_new: "تعمل · لا جديد",
  worker_rejected: "الموقع يرفض الطلب الآلي",
  bad_url: "الرابط غير صحيح",
  error_page: "صفحة خطأ",
  feed_stalled: "التغذية متوقفة",
  feed_corrupt: "التغذية فاسدة",
  empty_parse: "لم يجد روابط",
  needs_javascript: "يحتاج جافاسكربت",
  not_articles: "ليست مقالات",
  transient: "خطأ مؤقت",
  request_budget: "تجاوز حد الطلبات",
  redirect_outside_registry: "يحوّل إلى نطاق غير معتمد",
};

export function sourceStatusAr(code) {
  const raw = String(code || "");
  if (SOURCE_STATUS_AR[raw]) return SOURCE_STATUS_AR[raw];
  const http = raw.match(/^http_(\d{3})$/);
  if (http) {
    const status = Number(http[1]);
    if (status === 401 || status === 403) return `الموقع يرفض الطلب الآلي (${status})`;
    if (status === 404 || status === 410) return `الصفحة غير موجودة (${status})`;
    if (status >= 500) return `خطأ في الموقع (${status})`;
    return `استجابة غير متوقعة (${status})`;
  }
  return raw;
}
