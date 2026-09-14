import { decodeEntities } from "./text.js";
import { isAggregatorHost, publisherDomain } from "./domain.js";
import { isWithinWeek, parseDate, toIso } from "./time.js";
import { isAboutMayor } from "./mayors.js";
import { assertCanonicalApproved, governedFetch } from "./governedFetch.js";

export const MAX_ARTICLE_CHARS = 80000;

export function isGoogleNewsUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "news.google.com" || host.endsWith(".news.google.com");
  } catch {
    return false;
  }
}

export function isListingPageUrl(url) {
  try {
    const path = new URL(url).pathname.toLowerCase();
    if (path === "/" || !path) return true;
    return (
      /(?:^|\/)(?:index|list|search)\.(?:do|jsp|php|html?)$/.test(path) ||
      /\/(?:news|notizie|actualidad|소식)\/?$/.test(path)
    );
  } catch {
    return true;
  }
}

function attr(html, names) {
  for (const name of names) {
    const a = html.match(
      new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']+)["']`, "i"),
    );
    if (a) return decodeEntities(a[1]);
    const b = html.match(
      new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["']${name}["']`, "i"),
    );
    if (b) return decodeEntities(b[1]);
  }
  return "";
}

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      out.push(JSON.parse(m[1].replace(/[\u0000-\u001f]+/g, " ")));
    } catch {
      /* ignore broken ld+json */
    }
  }
  return out;
}

function walkLd(node, acc = []) {
  if (!node) return acc;
  if (Array.isArray(node)) {
    node.forEach((n) => walkLd(n, acc));
    return acc;
  }
  if (typeof node === "object") {
    acc.push(node);
    if (node["@graph"]) walkLd(node["@graph"], acc);
  }
  return acc;
}

function bodyText(html) {
  const cleaned = String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  const parts = [];
  const re = /<p\b[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(cleaned)) && parts.join(" ").length < MAX_ARTICLE_CHARS + 2000) {
    const text = decodeEntities(m[1]);
    if (text.length > 40) parts.push(text);
  }
  return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, MAX_ARTICLE_CHARS);
}

export function extractArticle(html, url = "") {
  const ld = walkLd(jsonLdBlocks(html));
  const news = ld.find((n) => /NewsArticle|Article/i.test(String(n["@type"] || ""))) || {};
  const title =
    attr(html, ["og:title", "twitter:title"]) ||
    decodeEntities(news.headline || news.name || "") ||
    decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
  const description =
    attr(html, ["og:description", "twitter:description", "description"]) ||
    decodeEntities(news.description || "");
  const published =
    attr(html, ["article:published_time", "pubdate", "date"]) ||
    news.datePublished ||
    news.dateCreated ||
    "";
  const canonicalRaw =
    (html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) || [])[1] ||
    news.url ||
    attr(html, ["og:url"]) ||
    url;
  let canonical = canonicalRaw;
  try {
    canonical = new URL(canonicalRaw, url || "https://example.com").toString();
  } catch {
    canonical = url;
  }
  const paragraphBody = bodyText(html);
  const structuredBody = decodeEntities(news.articleBody || "").slice(0, MAX_ARTICLE_CHARS);
  const body = structuredBody.length > paragraphBody.length ? structuredBody : paragraphBody;
  return {
    title: title.replace(/\s+/g, " ").trim(),
    description: description.replace(/\s+/g, " ").trim(),
    body,
    published_at: toIso(published),
    url: canonical,
    domain: publisherDomain(canonical),
  };
}

export function usableArticle(article) {
  return Boolean(article?.title && String(article.body || "").trim().length > 80);
}

export async function readArticle(startUrl, opts = {}) {
  const url = startUrl;
  if (!url || isGoogleNewsUrl(url)) return null;
  try {
    const fetched = await governedFetch(url, {
      mayorId: opts.mayorId || null,
      fetch: opts.fetch,
      timeoutMs: 12000,
      etag: opts.etag,
      lastModified: opts.lastModified,
    });
    if (fetched.notModified) return { notModified: true, url: fetched.url };
    if (!fetched.ok) return { error: `http_${fetched.status}`, httpStatus: fetched.status };
    const extracted = extractArticle(fetched.body, fetched.url);
    const canonical = assertCanonicalApproved(extracted.url, opts.mayorId, fetched.url);
    if (!canonical.ok) {
      return { error: canonical.reason, url: canonical.url || extracted.url };
    }
    extracted.url = canonical.url;
    extracted.domain = publisherDomain(canonical.url);
    extracted.httpStatus = fetched.status;
    extracted.etag = fetched.etag;
    extracted.lastModified = fetched.lastModified;
    if (usableArticle(extracted)) return extracted;
    return { error: "article_too_short", article: extracted };
  } catch (error) {
    return { error: error.code || String(error.message || error).slice(0, 80) };
  }
}

export function articleIsAboutMayor(article, mayor) {
  const pageText = `${article?.title || ""} ${article?.description || ""} ${article?.body || ""}`;
  return isAboutMayor(pageText, mayor);
}

export function judgeArticle(article, mayor, row = {}) {
  if (!article?.url || isAggregatorHost(article.domain)) {
    return { ok: false, reason: "unverified", pageRead: Boolean(article?.url) };
  }
  if (isListingPageUrl(article.url)) {
    return { ok: false, reason: "unrelated", pageRead: true };
  }
  const rssDate = parseDate(row.published_at);
  const articleDate = parseDate(article.published_at);
  const pageDate = articleDate || (row.date_is_discovery ? null : rssDate);
  if (pageDate && isWithinWeek(pageDate) === false) {
    return { ok: false, reason: "stale", pageRead: true };
  }
  if (!pageDate) {
    return { ok: false, reason: "stale", pageRead: true };
  }
  if (!articleIsAboutMayor(article, mayor)) {
    return { ok: false, reason: "unrelated", pageRead: true };
  }
  return {
    ok: true,
    pageRead: true,
    row: {
      ...row,
      title: article.title || row.title,
      snippet: [article.description, article.body].filter(Boolean).join(" ").slice(0, 1600),
      page_body: article.body,
      url: article.url,
      publisher_url: article.url,
      published_at: toIso(pageDate),
    },
  };
}

export async function verifyCandidate(row, mayor, opts = {}) {
  const rssDate = parseDate(row.published_at);
  if (rssDate && isWithinWeek(rssDate) === false) {
    return { ok: false, reason: "stale", pageRead: false };
  }
  const article = await readArticle(row.publisher_article_url || row.url, {
    mayorId: mayor.id,
    fetch: opts.fetch,
  });
  if (!article || article.error || article.notModified) {
    return { ok: false, reason: article?.error === "canonical_outside_registry" ? "untrusted" : "unverified", pageRead: false };
  }
  return judgeArticle(article, mayor, row);
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length || 1));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}
