export function arabicRatio(text) {
  const chars = String(text || "").replace(/\s/g, "");
  if (!chars.length) return 0;
  return (chars.match(/[\u0600-\u06FF]/g) || []).length / chars.length;
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
