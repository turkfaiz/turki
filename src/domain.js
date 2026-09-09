const COMPOUND_SUFFIXES = new Set([
  "co.kr",
  "or.kr",
  "go.kr",
  "ac.kr",
  "ne.kr",
  "com.es",
  "gob.es",
  "org.es",
  "co.uk",
  "gov.uk",
  "ac.uk",
  "org.uk",
  "gov.jo",
  "com.jo",
  "gov.iq",
  "gov.om",
  "com.om",
  "co.om",
  "lg.jp",
  "go.jp",
  "co.jp",
  "or.jp",
  "ne.jp",
  "ac.jp",
  "gov.gr",
  "co.ma",
  "gov.ma",
  "ac.ma",
]);

const AGGREGATORS = new Set([
  "google.com",
  "news.google.com",
  "googleusercontent.com",
  "gstatic.com",
  "bing.com",
  "www.bing.com",
  "msn.com",
  "www.msn.com",
  "t.co",
  "news.yahoo.com",
]);

export function publisherDomain(urlOrHost) {
  if (!urlOrHost) return "";
  let host = String(urlOrHost).trim().toLowerCase();
  try {
    if (/^https?:\/\//i.test(host)) host = new URL(host).hostname;
  } catch {
    return "";
  }
  host = host.replace(/^www\./, "");
  if (!host || !host.includes(".")) return "";
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return host;
  const last2 = parts.slice(-2).join(".");
  if (COMPOUND_SUFFIXES.has(last2) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return last2;
}

export function isAggregatorHost(domain) {
  if (!domain) return true;
  if (AGGREGATORS.has(domain)) return true;
  return [...AGGREGATORS].some((agg) => domain === agg || domain.endsWith(`.${agg}`));
}

export function resolvePublisherDomain(row) {
  const named = publisherDomain(row?.publisher_url);
  if (named && !isAggregatorHost(named)) return named;
  const linked = publisherDomain(row?.url);
  if (linked && !isAggregatorHost(linked)) return linked;
  return named || linked || "";
}
