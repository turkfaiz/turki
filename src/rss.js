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

export function parseRssItems(xml) {
  if (!xml || !xml.includes("<item")) return [];
  return xml
    .split(/<item[\s>]/i)
    .slice(1)
    .map((block) => {
      const title = tag(block, "title");
      const link = tag(block, "link") || tag(block, "guid");
      const published = tag(block, "pubDate");
      const snippet = tag(block, "description").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const { publisher_name, publisher_url } = sourceMeta(block);
      return { title, url: link, published_at: published || null, snippet, publisher_name, publisher_url };
    })
    .filter((item) => item.title && item.url);
}

export function googleNewsRssUrl(query, hl, gl) {
  const q = withWeekQuery(query);
  const ceid = `${gl}:${hl}`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;
}

export function bingNewsRssUrl(query) {
  return `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&qft=interval%3d%227%22&format=rss`;
}
