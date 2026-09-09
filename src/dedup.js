export function normalizeTitle(title) {
  return String(title || "")
    .replace(/\s+[-–|]\s+[^-–|]{2,40}$/g, "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text) {
  return normalizeTitle(text)
    .split(" ")
    .filter((t) => t.length >= 3);
}

export function tokenOverlap(a, b) {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (!sa.size || !sb.size) return 0;
  let hit = 0;
  for (const t of sa) if (sb.has(t)) hit += 1;
  return hit / Math.min(sa.size, sb.size);
}

export function isRelevant(text, tokens) {
  const hay = String(text || "").toLowerCase();
  return tokens.some((t) => hay.includes(t));
}

export async function fingerprint(mayorId, title, url) {
  const key = `${mayorId}|${normalizeTitle(title).slice(0, 96)}|${stripTracking(url)}`;
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(key));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function stripTracking(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"].forEach((k) =>
      u.searchParams.delete(k),
    );
    return u.toString();
  } catch {
    return String(url || "").split("#")[0];
  }
}

export function pickConfidence(source, duplicateHits) {
  if (source === "official") return "official";
  if (duplicateHits >= 1 || source === "inoreader") return "merged";
  return "raw";
}
