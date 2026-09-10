import test from "node:test";
import assert from "node:assert/strict";
import { buildSearchQueries, MAYORS } from "../src/mayors.js";
import { parseRssItems, googleNewsRssUrl } from "../src/rss.js";
import { arabicRatio, splitHeadline } from "../src/translate.js";
import { isRelevant, normalizeTitle, tokenOverlap } from "../src/dedup.js";
import { isAboutMayor } from "../src/mayors.js";
import { extractArticleLinks, stampBrief } from "../src/collect.js";
import {
  APPROVED_SOURCES,
  MAX_SOURCES_PER_OFFICE,
  approvedSourceFor,
  isApprovedUrl,
  sourcesFor,
} from "../src/sources.js";

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

test("every office is governed by at most three approved sources, ranked", () => {
  for (const mayor of MAYORS) {
    const sources = sourcesFor(mayor.id);
    assert.ok(sources.length > 0, `${mayor.id} has no approved source`);
    assert.ok(
      sources.length <= MAX_SOURCES_PER_OFFICE,
      `${mayor.id} exceeds the source cap`,
    );
    assert.deepEqual(
      sources.map((source) => source.rank),
      sources.map((_source, index) => index + 1),
    );
    assert.equal(sources[0].tier, 0, `${mayor.id} must lead with its official newsroom`);
    for (const source of sources) {
      assert.match(source.url, /^https:\/\//);
      assert.ok(["feed", "page"].includes(source.kind));
    }
  }
  assert.equal(APPROVED_SOURCES.length, MAYORS.length * MAX_SOURCES_PER_OFFICE);
});

test("only approved domains may be opened, and never an aggregator wrapper", () => {
  assert.equal(isApprovedUrl("https://www.comune.torino.it/via-roma", "turin"), true);
  assert.equal(
    approvedSourceFor("https://torino.repubblica.it/2026/09/piano", "turin").tier,
    1,
  );
  // نطاق معتمد لمكتب آخر لا يفتح لهذا المكتب.
  assert.equal(isApprovedUrl("https://www.comune.torino.it/via-roma", "seoul"), false);
  // المجمّعات ومحركات البحث خارج السجل نهائيًا.
  assert.equal(isApprovedUrl("https://news.google.com/rss/articles/CBMiabc", "turin"), false);
  assert.equal(isApprovedUrl("https://www.bing.com/news/apiclick.aspx?url=x", "turin"), false);
  assert.equal(isApprovedUrl("https://random-blog.example/turin", "turin"), false);
});

test("newsroom page extraction stays inside the approved domain", () => {
  const html = `
    <a href="/ar/gam/news-details.aspx?id=1024">قرار أمانة عمّان الجديد</a>
    <a href="https://www.ammancity.gov.jo/ar/gam/news/2026-plan-approved">خطة 2026</a>
    <a href="https://twitter.com/ammancity">تابعنا</a>
    <a href="/ar/gam/category/news/">الأخبار</a>
    <a href="/logo.png">صورة</a>
    <a href="#top">أعلى</a>`;
  const links = extractArticleLinks(html, "https://www.ammancity.gov.jo/ar/gam/news.aspx");
  const urls = links.map((link) => link.url);
  assert.equal(urls.length, 2);
  assert.ok(urls.every((url) => url.includes("ammancity.gov.jo")));
  assert.ok(!urls.some((url) => url.includes("twitter.com")), "external domains are dropped");
  assert.ok(!urls.some((url) => url.includes("/category/")), "navigation pages are dropped");
  assert.ok(!urls.some((url) => url.endsWith(".png")), "assets are dropped");
});

test("page extraction ignores service pages outside the newsroom", () => {
  const html = `
    <a href="/ar/gam/news-details.aspx?id=1024">قرار جديد</a>
    <a href="/ar/eservices/BuildingsAndLandTax.aspx">ضريبة الأبنية</a>
    <a href="/ar/gameservices/eservices.aspx">الخدمات الإلكترونية</a>`;
  const urls = extractArticleLinks(
    html,
    "https://www.ammancity.gov.jo/ar/gam/news.aspx",
  ).map((link) => link.url);
  assert.deepEqual(urls, [
    "https://www.ammancity.gov.jo/ar/gam/news-details.aspx?id=1024",
  ]);
});
