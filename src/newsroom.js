/**
 * محولات غرف الأخبار: استخراج روابط المقالات من HTML/JSON-LD/واجهة الموقع،
 * بمحوّل قابل للتخصيص لكل مصدر رسمي بدل Regex عام لكل المدن.
 */
import { decodeXml } from "./rss.js";
import { decodeEntities } from "./text.js";
import { looksLikeErrorPage, looksLikeJsShell } from "./governedFetch.js";

export const ARTICLE_LINK_LIMIT = 40;

const NON_ARTICLE_PATH =
  /\.(?:jpe?g|png|gif|svg|webp|pdf|zip|docx?|xlsx?|mp[34]|css|js|woff2?)$/i;

const SERVICE_PATH =
  /\/(?:tag|tags|category|categories|author|autor|search|login|register|contact|kontakti|privacy|cookie|terms|feed|rss|sitemap|e-?services?|gameservices|tramit(?:e|os)|complaints?|opendata|site_policy|social-media|house-rules|galerie|telechargement|services-en-ligne|qasja|dokumente)(?:\/|$)/i;

const SERVICE_TITLE =
  /اتصل بنا|تواصل معنا|قواعد التواصل|سياسة الخصوصية|contact us|privacy policy|cookie policy|terms of use|house rules|social media|اتصل|الشكاوى|خدمات إلكترونية/i;

function jsonLdBlocks(html) {
  const out = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try {
      out.push(JSON.parse(m[1].replace(/[\u0000-\u001f]+/g, " ")));
    } catch {
      /* ignore */
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
    if (node.itemListElement) walkLd(node.itemListElement, acc);
  }
  return acc;
}

function resolveUrl(href, baseUrl) {
  try {
    const parsed = new URL(decodeXml(href), baseUrl);
    const materialized = new URL(materializeHashParams(parsed.toString()));
    materialized.hash = "";
    return materialized;
  } catch {
    return null;
  }
}

function hostOf(url) {
  return url.hostname.replace(/^www\./i, "").toLowerCase();
}

function sameListingHost(linkHost, baseHost) {
  return linkHost === baseHost;
}

function isServiceLink(url, title = "") {
  const path = `${url.pathname}${url.search}`.toLowerCase();
  if (SERVICE_PATH.test(path)) return true;
  if (SERVICE_TITLE.test(title)) return true;
  if (/social-media-house-rules/i.test(path)) return true;
  if (/errpage|errorpage|aspxerrorpath/i.test(path)) return true;
  return false;
}

function defaultLooksLikeArticle(url, adapter) {
  const path = url.pathname;
  const search = url.search;
  if (path === "/" || !path) return false;
  if (NON_ARTICLE_PATH.test(path)) return false;
  if (adapter.requireQuery && !adapter.requireQuery.test(search)) return false;
  if (adapter.articlePath) return adapter.articlePath.test(path + search);
  const segments = path.split("/").filter(Boolean);
  return (
    segments.length >= 2 ||
    /\d{4,}/.test(search + path) ||
    /-.*-/.test(segments.at(-1) || "")
  );
}

function pushLink(found, url, title, adapter, base) {
  if (!/^https?:$/i.test(url.protocol)) return;
  const baseHost = hostOf(base);
  const linkHost = hostOf(url);
  if (!sameListingHost(linkHost, baseHost)) return;
  if (isServiceLink(url, title)) return;
  if (adapter.excludePath && adapter.excludePath.test(url.pathname + url.search)) return;
  if (!defaultLooksLikeArticle(url, adapter)) return;
  const key = url.toString();
  if (found.has(key)) return;
  found.set(key, decodeEntities(title || "").trim());
}

function extractJsonLdLinks(html, baseUrl, adapter, found) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return;
  }
  for (const node of walkLd(jsonLdBlocks(html))) {
    const type = String(node["@type"] || "");
    if (/NewsArticle|Article|BlogPosting/i.test(type) && node.url) {
      const url = resolveUrl(node.url, base);
      if (url) pushLink(found, url, node.headline || node.name || "", adapter, base);
    }
    const item = node.item || node.url;
    const href = typeof item === "string" ? item : item?.url || item?.["@id"];
    if (href) {
      const url = resolveUrl(href, base);
      if (url) pushLink(found, url, node.name || node.headline || "", adapter, base);
    }
  }
}

function extractAnchorLinks(html, baseUrl, adapter, found) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return;
  }
  const newsroomDir = base.pathname.replace(/[^/]*$/, "");
  const tags = String(html || "").match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
  for (const tag of tags) {
    if (found.size >= ARTICLE_LINK_LIMIT) break;
    const href = tag.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href || /^(?:#|mailto:|tel:|javascript:)/i.test(href)) continue;
    const url = resolveUrl(href, base);
    if (!url) continue;
    const title = decodeEntities(tag.replace(/<[^>]+>/g, " ")).slice(0, 240);
    if (adapter.inNewsroomOnly) {
      const inNewsroom = newsroomDir.length > 1 && url.pathname.startsWith(newsroomDir);
      if (!inNewsroom && !(adapter.articlePath && adapter.articlePath.test(url.pathname + url.search))) {
        continue;
      }
    }
    pushLink(found, url, title, adapter, base);
  }
}

function extractRabatNextData(html, baseUrl, found) {
  const raw = html.match(
    /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i,
  )?.[1];
  if (!raw) return;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }
  const posts = data?.props?.pageProps?.posts || data?.props?.pageProps?.postsSlider || [];
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    return;
  }
  for (const post of posts) {
    const slug = post.slug || post.slug_ar;
    if (!slug) continue;
    const url = resolveUrl(`/ar-AR/${slug}`, base);
    if (!url) continue;
    pushLink(
      found,
      url,
      post.title_ar || post.title || "",
      ADAPTERS["rabat-mairie"],
      base,
    );
    if (found.size >= ARTICLE_LINK_LIMIT) break;
  }
}

export const ADAPTERS = {
  generic: {
    jsonLd: true,
    anchors: true,
    articlePath: /news|notiz|notic|actual|article|story|press|media|comunic|akhbar|khabar|lajme|hodo|happyo|nea|eidisi|deltio|anakoinosi|\/20\d{2}\//i,
  },
  "madrid-diario": {
    jsonLd: true,
    anchors: true,
    articlePath: /\/blog\/|\/noticia|\/20\d{2}\//i,
    excludePath: /\/contacto|\/aviso-legal|\/privacidad/i,
  },
  "malaga-press": {
    jsonLd: false,
    anchors: true,
    articlePath: /detalle-de-la-nota-de-prensa/i,
    requireQuery: /(?:\?|&)id=\d+/i,
    excludePath: /tramite|sede\.malaga|detalle-del-tramite/i,
    inNewsroomOnly: false,
  },
  "muscat-mm": {
    jsonLd: false,
    anchors: true,
    articlePath: /NewsDetails|NID=\d+/i,
  },
  "osaka-city": {
    jsonLd: false,
    anchors: true,
    articlePath: /\/page\/0*\d+\.html/i,
    excludePath: /site_policy|soshiki_list|index\.html$/i,
  },
  "athens-wp": {
    jsonLd: true,
    anchors: true,
    articlePath: /\/(deltio-typoy|anakoinosi|nea|news)\//i,
    excludePath: /\/category\/|\/tag\/|\/ekdiloseis\//i,
  },
  "pristina-lajmet": {
    jsonLd: false,
    anchors: true,
    articlePath: /\/lajmet\/\d+\//i,
    excludePath: /\/kontakti|\/dokumente|\/konkurset|\/kryetari\/?$/i,
  },
  "neca-news": {
    jsonLd: true,
    anchors: true,
    articlePath: /\/news\/[a-z0-9-]+/i,
    excludePath: /social-media|house-rules|\/about\/|\/governance\//i,
  },
  "amman-gam": {
    jsonLd: false,
    anchors: true,
    articlePath: /news-details|NewsDetails|newslist|id=\d+/i,
    inNewsroomOnly: true,
    excludePath: /eservices|errpage|gameservices/i,
  },
  "baghdad-amanat": {
    jsonLd: true,
    anchors: true,
    articlePath: /\/news\/|\/article\//i,
  },
  "rabat-mairie": {
    jsonLd: false,
    anchors: true,
    nextData: true,
    articlePath: /\/(ar-AR|fr-FR)\/[A-Za-z0-9_%-]+/i,
    excludePath:
      /Contact|Telechargement|Services-en-ligne|Appels-doffres|Galerie|Budget-et-finances|Administration|president$|Conseil-communal/i,
  },
  "seoul-wp": {
    jsonLd: true,
    anchors: true,
    articlePath: /\/[a-z0-9-]+\/?$/i,
    excludePath: /\/(category|tag|about|contact|privacy)\//i,
  },
  "oman-observer": {
    jsonLd: false,
    anchors: true,
    articlePath: /\/article\/\d+\//i,
    excludePath: /morearticles|terms-and-conditions|classifieds|epaper/i,
  },
  "ina-local": {
    jsonLd: false,
    anchors: true,
    articlePath: /\/ar\/(?:local|political|economy)\/\d+/i,
  },
};

export function getAdapter(name) {
  return ADAPTERS[name] || ADAPTERS.generic;
}

export function materializeHashParams(value) {
  try {
    const url = new URL(value);
    const hash = url.hash.replace(/^#/, "");
    if (hash && /(?:^|&)NID=\d+/i.test(hash)) {
      const params = new URLSearchParams(hash.replace(/^NewsDetails&?/i, ""));
      for (const [key, val] of params.entries()) {
        if (!url.searchParams.has(key)) url.searchParams.set(key, val);
      }
      url.hash = "";
      return url.toString();
    }
  } catch {
    /* keep original */
  }
  return value;
}

export function extractArticleLinks(html, baseUrl, adapterName = "generic") {
  const adapter = getAdapter(adapterName);
  const found = new Map();
  if (adapter.nextData) extractRabatNextData(html, baseUrl, found);
  if (adapter.jsonLd) extractJsonLdLinks(html, baseUrl, adapter, found);
  if (adapter.anchors !== false) extractAnchorLinks(html, baseUrl, adapter, found);
  return [...found.entries()].slice(0, ARTICLE_LINK_LIMIT).map(([url, title]) => ({ url, title }));
}

export function inspectListingPage(html, httpStatus, url) {
  const error = looksLikeErrorPage(html, httpStatus, url);
  if (error.error) return { ok: false, reason: error.reason, jsShell: false };
  if (looksLikeJsShell(html)) return { ok: false, reason: "needs_javascript", jsShell: true };
  return { ok: true, reason: "", jsShell: false };
}

export function parseWpJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const posts = Array.isArray(data) ? data : [];
  return posts
    .map((post) => ({
      url: post.link || post.guid?.rendered || "",
      title: decodeEntities(String(post.title?.rendered || post.title || "")),
      published_at: post.date_gmt || post.date || null,
      snippet: decodeEntities(String(post.excerpt?.rendered || "").replace(/<[^>]+>/g, " ")),
    }))
    .filter((row) => row.url && row.title);
}
