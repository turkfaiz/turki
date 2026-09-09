import test from "node:test";
import assert from "node:assert/strict";
import { extractArticle, extractJinaMarkdown } from "../src/article.js";
import { isWithinWeek, parseDate, withWeekQuery } from "../src/time.js";

test("week window rejects 2023 and keeps yesterday", () => {
  const now = Date.parse("2026-09-09T12:00:00Z");
  assert.equal(isWithinWeek("2023-05-27T10:00:00Z", now), false);
  assert.equal(isWithinWeek("2026-09-08T09:00:00Z", now), true);
  assert.equal(isWithinWeek("not-a-date", now), null);
});

test("withWeekQuery appends when:7d once", () => {
  assert.equal(withWeekQuery('"Oh Se-hoon" Seoul'), '"Oh Se-hoon" Seoul when:7d');
  assert.equal(withWeekQuery("x when:7d"), "x when:7d");
});

test("extractArticle reads og title, canonical, published time and paragraphs", () => {
  const html = `<html><head>
    <meta property="og:title" content="Stefano Lo Russo announces grid repair">
    <meta property="og:description" content="The mayor of Turin declared an emergency.">
    <meta property="article:published_time" content="2026-09-08T11:00:00Z">
    <link rel="canonical" href="https://www.lastampa.it/torino/2026/09/08/lo-russo-rete">
  </head><body>
    <p>Short</p>
    <p>Stefano Lo Russo said the old network in Turin needs maintenance after a blackout across several districts this week.</p>
  </body></html>`;
  const art = extractArticle(html, "https://www.lastampa.it/foo");
  assert.equal(art.title, "Stefano Lo Russo announces grid repair");
  assert.match(art.url, /lo-russo-rete/);
  assert.equal(art.published_at, "2026-09-08T11:00:00.000Z");
  assert.match(art.body, /blackout/);
});

test("jina markdown extractor keeps the source url", () => {
  const md = `Title: Lo Russo on the grid\nURL Source: https://www.lastampa.it/a\nPublished Time: 2026-09-08T10:00:00Z\n\nMarkdown Content:\nThe mayor spoke about rete vecchia.`;
  const art = extractJinaMarkdown(md, "https://example.com");
  assert.equal(art.title, "Lo Russo on the grid");
  assert.equal(art.url, "https://www.lastampa.it/a");
  assert.ok(parseDate(art.published_at));
});
