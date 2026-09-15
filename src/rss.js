import { withWeekQuery } from "./time.js";

export function decodeXml(value) {
  return String(value || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .trim();
}

function tag(block, name) {
  const re = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i");
  const m = block.match(re);
  return m ? decodeXml(m[1]) : "";
}

function sourceMeta(block) {
  const open = block.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
  if (!open) return { publisher_name: "", publisher_url: "" };
  const href = open[1].match(/url\s*=\s*["']([^"']+)["']/i);
  return {
    publisher_url: href ? decodeXml(href[1]) : "",
    publisher_name: decodeXml(open[2] || ""),
  };
}

function attrLink(block) {
  const href = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
  return href ? decodeXml(href[1]) : "";
}

export function parseRssItems(xml) {
  if (!xml || !/<item[\s>]/i.test(xml)) return [];
  return xml
    .split(/<item[\s>]/i)
    .slice(1)
    .map((block) => {
      const title = tag(block, "title");
      const link = tag(block, "link") || attrLink(block) || tag(block, "guid");
      const published = tag(block, "pubDate") || tag(block, "dc:date") || tag(block, "updated");
      const snippet = tag(block, "description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const { publisher_name, publisher_url } = sourceMeta(block);
      return { title, url: link, published_at: published || null, snippet, publisher_name, publisher_url };
    })
    .filter((item) => item.title && item.url);
}

export function parseAtomItems(xml) {
  if (!xml || !/<entry[\s>]/i.test(xml)) return [];
  return xml
    .split(/<entry[\s>]/i)
    .slice(1)
    .map((block) => {
      const title = tag(block, "title");
      const link = attrLink(block) || tag(block, "id");
      const published = tag(block, "published") || tag(block, "updated");
      const snippet = (tag(block, "summary") || tag(block, "content"))
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return {
        title,
        url: link,
        published_at: published || null,
        snippet,
        publisher_name: "",
        publisher_url: "",
      };
    })
    .filter((item) => item.title && item.url);
}

export function looksLikeHtmlDocument(text) {
  const head = String(text || "").slice(0, 400).toLowerCase();
  return /<!doctype html|<html[\s>]/.test(head);
}

export function parseFeed(xml) {
  const text = String(xml || "");
  if (!text.trim()) {
    return { items: [], kind: null, corrupt: true, reason: "empty" };
  }
  const hasFeed = /<rss[\s>]|<rdf:rdf|<feed[\s>]|<item[\s>]|<entry[\s>]/i.test(text);
  if (looksLikeHtmlDocument(text) && !hasFeed) {
    return { items: [], kind: null, corrupt: true, reason: "html_not_feed" };
  }
  if (/<rss[\s>]|<rdf:rdf/i.test(text) || /<item[\s>]/i.test(text)) {
    return { items: parseRssItems(text), kind: "rss", corrupt: false, reason: "" };
  }
  if (/<feed[\s>]/i.test(text) || /<entry[\s>]/i.test(text)) {
    return { items: parseAtomItems(text), kind: "atom", corrupt: false, reason: "" };
  }
  return { items: [], kind: null, corrupt: true, reason: "unrecognized_feed" };
}

export function googleNewsRssUrl(query, hl, gl) {
  const q = withWeekQuery(query);
  const ceid = `${gl}:${hl}`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;
}

export function bingNewsRssUrl(query) {
  return `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&qft=interval%3d%227%22&format=rss`;
}
