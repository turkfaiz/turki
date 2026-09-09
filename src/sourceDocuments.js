import { MAX_ARTICLE_CHARS } from "./article.js";

export const MAX_MERGED_ARTICLE_CHARS = 240000;
const MAX_SOURCES = 20;

function compact(value, max) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function keyOf(document) {
  return (
    document.url ||
    `${document.domain || ""}|${document.source || ""}|${document.title || ""}`
  );
}

export function sourceDocument(row, domain = row.publisher_domain) {
  return {
    source: row.source || "source",
    domain: domain || null,
    url: row.url || "",
    title: compact(row.title, 500),
    published_at: row.published_at || null,
    article_text: compact(row.page_body || row.article_text || row.snippet, MAX_ARTICLE_CHARS),
  };
}

function parsedDocuments(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function legacyBodies(articleText, metadata) {
  const text = String(articleText || "");
  const markers = metadata
    .map((row, index) => {
      const marker = `[${row.domain || row.source || "source"}] ${row.title || ""}\n`;
      return { index, marker, start: text.indexOf(marker) };
    })
    .filter((row) => row.start >= 0)
    .sort((a, b) => a.start - b.start);
  const bodies = new Map();
  markers.forEach((row, position) => {
    const start = row.start + row.marker.length;
    const end = markers[position + 1]?.start ?? text.length;
    bodies.set(row.index, compact(text.slice(start, end), MAX_ARTICLE_CHARS));
  });
  return bodies;
}

export function readSourceDocuments(item) {
  const stored = parsedDocuments(item.source_documents)
    .map((row) => ({
      source: row.source || "source",
      domain: row.domain || null,
      url: row.url || "",
      title: compact(row.title, 500),
      published_at: row.published_at || null,
      article_text: compact(row.article_text, MAX_ARTICLE_CHARS),
    }))
    .filter((row) => keyOf(row));
  if (stored.length) return stored;

  const metadata = parsedDocuments(item.merged_sources);
  if (metadata.length) {
    const bodies = legacyBodies(item.article_text, metadata);
    return metadata.slice(0, MAX_SOURCES).map((row, index) => ({
      source: row.source || item.source || "source",
      domain: row.domain || item.publisher_domain || null,
      url: row.url || "",
      title: compact(row.title || item.title, 500),
      published_at: row.published_at || item.published_at || null,
      article_text: bodies.size
        ? bodies.get(index) || ""
        : index === 0
          ? compact(item.article_text || item.snippet, MAX_ARTICLE_CHARS)
          : "",
    }));
  }
  return [sourceDocument(item)];
}

export function mergeSourceDocuments(items) {
  const merged = new Map();
  for (const item of items) {
    for (const document of readSourceDocuments(item)) {
      const key = keyOf(document);
      if (!key) continue;
      const previous = merged.get(key);
      if (!previous || document.article_text.length > previous.article_text.length) {
        merged.set(key, document);
      }
    }
  }
  return [...merged.values()].slice(0, MAX_SOURCES);
}

export function renderSourceDocuments(documents) {
  return documents
    .filter((document) => document.article_text)
    .map(
      (document) =>
        `<source domain="${document.domain || document.source}" url="${document.url}">\n` +
        `<title>${document.title}</title>\n` +
        `${document.article_text}\n</source>`,
    )
    .join("\n\n")
    .slice(0, MAX_MERGED_ARTICLE_CHARS);
}

export function sourceMetadata(documents) {
  return documents.map(({ article_text: _articleText, ...metadata }) => metadata);
}

export function refreshSourceDocuments(existing, row, domain) {
  const documents = readSourceDocuments(existing);
  const current = sourceDocument(row, domain);
  const key = keyOf(current);
  const index = documents.findIndex((document) => keyOf(document) === key);
  const previous = index >= 0 ? documents[index] : null;
  const changed =
    !previous ||
    previous.article_text !== current.article_text ||
    previous.title !== current.title ||
    previous.published_at !== current.published_at;
  if (index >= 0) documents[index] = current;
  else documents.push(current);
  const kept = documents.slice(0, MAX_SOURCES);
  return {
    changed,
    documents: kept,
    articleText: renderSourceDocuments(kept),
    metadata: sourceMetadata(kept),
  };
}
