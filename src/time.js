export const WEEK_DAYS = 7;
export const WEEK_MS = WEEK_DAYS * 24 * 60 * 60 * 1000;

export function parseDate(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  const raw = String(value).trim();
  if (!raw) return null;
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})T?(\d{2})(\d{2})(\d{2})Z?$/);
  if (compact) {
    const iso = `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4]}:${compact[5]}:${compact[6]}Z`;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function isWithinWeek(value, now = Date.now()) {
  const d = parseDate(value);
  if (!d) return null;
  const t = d.getTime();
  if (t > now + 18 * 60 * 60 * 1000) return false;
  return now - t <= WEEK_MS;
}

export function toIso(value) {
  const d = parseDate(value);
  return d ? d.toISOString() : null;
}

export function withWeekQuery(query) {
  const q = String(query || "").trim();
  if (/\bwhen:\d+[dhw]\b/i.test(q)) return q;
  return `${q} when:${WEEK_DAYS}d`;
}
