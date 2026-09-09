import { decodeEntities } from "./text.js";
import { isAggregatorHost, publisherDomain } from "./domain.js";
import { isWithinWeek, parseDate, toIso } from "./time.js";
import { isAboutMayor } from "./mayors.js";

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const BATCH_URL = "https://news.google.com/_/DotsSplashUi/data/batchexecute";
export const MAX_ARTICLE_CHARS = 80000;

export function isGoogleNewsUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    return host === "news.google.com" || host.endsWith(".news.google.com");
  } catch {
    return false;
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

export function extractJinaMarkdown(md, fallbackUrl = "") {
  const title = (md.match(/^Title:\s*(.+)$/m) || [])[1] || "";
  const source = (md.match(/^URL Source:\s*(.+)$/m) || [])[1] || fallbackUrl;
  const published = (md.match(/^Published Time:\s*(.+)$/m) || [])[1] || "";
  const body = md.replace(/^[\s\S]*?Markdown Content:\s*/i, "").replace(/\s+/g, " ").trim();
  return {
    title: decodeEntities(title).trim(),
    description: body.slice(0, 400),
    body: body.slice(0, MAX_ARTICLE_CHARS),
    published_at: toIso(published),
    url: source || fallbackUrl,
    domain: publisherDomain(source || fallbackUrl),
  };
}

export function usableArticle(article) {
  return Boolean(article?.title && String(article.body || "").trim().length > 80);
}

async function fetchResponse(url, timeoutMs = 12000, extra = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: extra.accept || "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        ...extra.headers,
      },
      method: extra.method || "GET",
      body: extra.body,
      redirect: "follow",
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function unwrapGoogleNews(url) {
  if (!isGoogleNewsUrl(url)) return url;
  const articleId = url.split("/articles/")[1]?.split("?")[0];
  if (!articleId) return "";
  const pageUrl = `https://news.google.com/articles/${articleId}`;
  const pageRes = await fetchResponse(pageUrl, 10000);
  const pageText = await pageRes.text();
  const signature = (pageText.match(/data-n-a-sg="([^"]+)"/) || [])[1];
  const timestamp = (pageText.match(/data-n-a-ts="([^"]+)"/) || [])[1];
  if (!signature || !timestamp) return "";
  const rpcInner = JSON.stringify([
    "garturlreq",
    [
      ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1],
      "X",
      "X",
      1,
      [1, 1, 1],
      1,
      1,
      null,
      0,
      0,
      null,
      0,
    ],
    articleId,
    Number(timestamp),
    signature,
  ]);
  const fReq = JSON.stringify([[["Fbv4je", rpcInner, null, "generic"]]]);
  const post = await fetchResponse(BATCH_URL, 10000, {
    method: "POST",
    accept: "*/*",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Referer: "https://news.google.com/",
    },
    body: new URLSearchParams({ "f.req": fReq }).toString(),
  });
  let body = await post.text();
  if (body.startsWith(")]}'")) body = body.split("\n").slice(1).join("\n");
  body = body.replace(/^\s*\d+\n/, "");
  try {
    const envelopes = JSON.parse(body.trim());
    for (const env of envelopes) {
      if (Array.isArray(env) && env[0] === "wrb.fr" && env[1] === "Fbv4je") {
        const payload = JSON.parse(env[2]);
        if (payload && payload[0] === "garturlres" && payload[1]) return String(payload[1]);
      }
    }
  } catch {
    return "";
  }
  return "";
}

async function readViaJina(url) {
  const res = await fetchResponse(`https://r.jina.ai/${url}`, 14000, { accept: "text/plain" });
  if (!res.ok) return null;
  const md = await res.text();
  if (!md || md.length < 80) return null;
  return extractJinaMarkdown(md, url);
}

export async function readArticle(startUrl) {
  let url = startUrl;
  if (isGoogleNewsUrl(url)) {
    const unwrapped = await unwrapGoogleNews(url);
    if (!unwrapped || isGoogleNewsUrl(unwrapped)) return null;
    url = unwrapped;
  }
  if (!url || isGoogleNewsUrl(url)) return null;
  try {
    const res = await fetchResponse(url, 12000);
    if (res.ok) {
      const html = await res.text();
      const extracted = extractArticle(html, res.url || url);
      if (usableArticle(extracted)) {
        return extracted;
      }
    }
  } catch {
    /* try reader */
  }
  try {
    const reader = await readViaJina(url);
    if (usableArticle(reader)) return reader;
  } catch {
    /* fail closed below */
  }
  return null;
}

export function articleIsAboutMayor(article, mayor) {
  const pageText = `${article?.title || ""} ${article?.description || ""} ${article?.body || ""}`;
  return isAboutMayor(pageText, mayor);
}

export async function verifyCandidate(row, mayor) {
  const rssDate = parseDate(row.published_at);
  if (rssDate && isWithinWeek(rssDate) === false) {
    return { ok: false, reason: "stale", pageRead: false };
  }
  const article = await readArticle(row.publisher_article_url || row.url);
  if (!article?.url || isAggregatorHost(article.domain)) {
    return { ok: false, reason: "unverified", pageRead: false };
  }
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
