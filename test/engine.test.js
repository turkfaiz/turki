import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchQueries, MAYORS } from "../src/mayors.js";
import { parseRssItems, googleNewsRssUrl } from "../src/rss.js";
import { arabicRatio, splitHeadline } from "../src/translate.js";
import { isRelevant, normalizeTitle, tokenOverlap } from "../src/dedup.js";
import { isAboutMayor } from "../src/mayors.js";
import {
  isUnreadableWrapper,
  parseSitemap,
  stampBrief,
  unwrapBingUrl,
} from "../src/collect.js";

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

test("office match requires the mayor identity, not just the city", () => {
  const seoul = MAYORS.find((m) => m.id === "seoul");
  assert.equal(isAboutMayor("Oh Se-hoon announces housing plan", seoul), true);
  assert.equal(isAboutMayor("Seoul mayor unveils a generic city budget", seoul), false);
});

test("a common given name is not enough to identify a mayor", () => {
  const madrid = MAYORS.find((m) => m.id === "madrid");
  const turin = MAYORS.find((m) => m.id === "turin");
  assert.equal(isAboutMayor("Luis presenta un progetto culturale a Madrid", madrid), false);
  assert.equal(isAboutMayor("Il sindaco Russo presenta il progetto a Torino", turin), true);
});

test("google news search is limited to the last seven days", () => {
  const url = googleNewsRssUrl('"Oh Se-hoon" Seoul', "ko", "KR");
  assert.match(url, /when%3A7d/);
});

test("overlap detects near-duplicate titles", () => {
  const a = "Mayor Oh Se-hoon unveils housing plan in Seoul";
  const b = "Oh Se-hoon unveils housing plan in Seoul today";
  assert.ok(tokenOverlap(a, b) > 0.6);
});

test("arabic ratio detects native arabic text", () => {
  assert.ok(arabicRatio("يوسف الشواربة يعتمد ميزانية عمان") > 0.5);
  assert.ok(arabicRatio("Oh Se-hoon housing plan") < 0.1);
});

test("splitHeadline pulls outlet off a wire title", () => {
  const s = splitHeadline("Oh Se-hoon announces plan - Korea Herald");
  assert.equal(s.headline, "Oh Se-hoon announces plan");
  assert.equal(s.outlet, "Korea Herald");
});

test("inbox rows wait for AI instead of receiving an unsafe rule-based brief", () => {
  const turin = MAYORS.find((m) => m.id === "turin");
  const stamped = stampBrief(
    turin,
    {
      title: "Inaugurazione della via pedonale di Via Roma. Sabato 12 settembre",
      snippet: "Grande festa. Stefano Lo Russo.",
    },
    "inbox",
  );
  assert.equal(stamped.trans_engine, "brief-pending");
  assert.match(stamped.title_ar, /بانتظار قراءة الذكاء الاصطناعي/);
  const skipped = stampBrief(turin, { title: "x", snippet: "" }, "excluded");
  assert.equal(skipped.trans_engine, null);
});

test("discovery keeps publisher urls and drops unreadable aggregator wrappers", () => {
  assert.equal(
    unwrapBingUrl(
      "http://www.bing.com/news/apiclick.aspx?ref=FexRss&url=https%3A%2F%2Fwww.lastampa.it%2Ftorino&c=1",
    ),
    "https://www.lastampa.it/torino",
  );
  assert.equal(unwrapBingUrl("https://www.lastampa.it/torino"), "https://www.lastampa.it/torino");
  assert.equal(isUnreadableWrapper("https://news.google.com/rss/articles/CBMiabc"), true);
  assert.equal(isUnreadableWrapper("https://www.comune.torino.it/via-roma"), false);
});

test("official sitemap discovery reads page urls and update dates", () => {
  const parsed = parseSitemap(`<?xml version="1.0"?>
    <urlset>
      <url>
        <loc>https://city.example/news/mayor-update</loc>
        <lastmod>2026-09-09T10:00:00Z</lastmod>
      </url>
    </urlset>`);
  assert.equal(parsed.index, false);
  assert.deepEqual(parsed.rows, [
    {
      loc: "https://city.example/news/mayor-update",
      lastmod: "2026-09-09T10:00:00Z",
    },
  ]);
});
