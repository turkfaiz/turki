import { decodeXml } from "./rss.js";
import { isWithinWeek, parseDate } from "./time.js";

const SITEMAP_LIMIT = 40;

function locsFromXml(xml) {
  return [...String(xml || "").matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)].map((m) =>
    decodeXml(m[1]),
  );
}

function lastmods(xml) {
  const blocks = String(xml || "").split(/<url[\s>]/i).slice(1);
  return blocks.map((block) => {
    const loc = decodeXml((block.match(/<loc>\s*([^<]+)\s*<\/loc>/i) || [])[1] || "");
    const lastmod = decodeXml((block.match(/<lastmod>\s*([^<]+)\s*<\/lastmod>/i) || [])[1] || "");
    return { url: loc, lastmod };
  }).filter((row) => row.url);
}

export function isSitemapIndex(xml) {
  return /<sitemapindex[\s>]/i.test(xml || "");
}

export function parseSitemap(xml, { includePatterns = [], now = Date.now() } = {}) {
  const patterns = (includePatterns || []).map((p) => (p instanceof RegExp ? p : new RegExp(p, "i")));
  const rows = lastmods(xml);
  const fallback = rows.length ? rows : locsFromXml(xml).map((url) => ({ url, lastmod: "" }));
  const filtered = fallback.filter((row) => {
    if (patterns.length && !patterns.some((re) => re.test(row.url))) return false;
    if (row.lastmod) {
      const parsed = parseDate(row.lastmod);
      if (parsed && isWithinWeek(parsed, now) === false) return false;
    }
    return true;
  });
  return filtered.slice(0, SITEMAP_LIMIT);
}

export function childSitemaps(xml) {
  if (!isSitemapIndex(xml)) return [];
  return locsFromXml(xml).slice(0, 8);
}
