export function arabicRatio(text) {
  const chars = String(text || "").replace(/\s/g, "");
  if (!chars.length) return 0;
  return (chars.match(/[\u0600-\u06FF]/g) || []).length / chars.length;
}

/**
 * بقايا لغة المصدر في العنوان أو الحقائق: لاتيني، أو كوري، أو صيني، أو ياباني.
 * الأرقام وعلامات الترقيم مسموحة؛ الأسماء تُنقل إلى العربية لا تُترك كما هي.
 */
export function hasSourceScript(text) {
  const value = String(text || "");
  return /[A-Za-zÀ-ÿ]/.test(value) || /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(value);
}

export function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/&#x0*a0;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function splitHeadline(title) {
  const raw = decodeEntities(String(title || "")).replace(/\s+/g, " ").trim();
  const m = raw.match(/^(.*)\s+[-–—|]\s+(.{2,48})$/);
  if (m && !/https?:/i.test(m[2])) {
    return { headline: m[1].trim(), outlet: m[2].trim() };
  }
  return { headline: raw, outlet: "" };
}
