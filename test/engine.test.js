import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchQueries, MAYORS } from "../src/mayors.js";
import { parseRssItems } from "../src/rss.js";
import { isRelevant, normalizeTitle, tokenOverlap } from "../src/dedup.js";

test("phase-1 list has 12 mayors", () => {
  assert.equal(MAYORS.length, 12);
});

test("search keys use english plus native language", () => {
  const seoul = MAYORS.find((m) => m.id === "seoul");
  const q = buildSearchQueries(seoul);
  assert.match(q.native, /Oh Se-hoon/);
  assert.match(q.native, /오세훈/);
  assert.match(q.official, /seoul\.go\.kr/);
});

test("arabic names are display-only and still used when arabic is native", () => {
  const amman = MAYORS.find((m) => m.id === "amman");
  const q = buildSearchQueries(amman);
  assert.match(q.native, /Yousef Al-Shawarbeh/);
  assert.match(q.native, /يوسف الشواربة/);
});

test("rss parser reads google-like items", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Oh Se-hoon visits site</title><link>https://example.com/a</link><pubDate>Tue, 08 Sep 2026 10:00:00 GMT</pubDate><description>Mayor news</description></item>
    <item><title><![CDATA[Second]]></title><link>https://example.com/b</link></item>
  </channel></rss>`;
  const items = parseRssItems(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Oh Se-hoon visits site");
});

test("dedup normalization collapses source suffixes", () => {
  assert.equal(
    normalizeTitle("Oh Se-hoon announces plan - Korea Herald"),
    normalizeTitle("Oh Se-hoon announces plan"),
  );
});

test("relevance requires mayor tokens", () => {
  const tokens = ["oh", "se-hoon", "seoul", "오세훈"];
  assert.equal(isRelevant("Seoul mayor Oh Se-hoon budget", tokens), true);
  assert.equal(isRelevant("random sports score", tokens), false);
});

test("overlap detects near-duplicate titles", () => {
  const a = "Mayor Oh Se-hoon unveils housing plan in Seoul";
  const b = "Oh Se-hoon unveils housing plan in Seoul today";
  assert.ok(tokenOverlap(a, b) > 0.6);
});
