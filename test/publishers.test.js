import test from "node:test";
import assert from "node:assert/strict";
import { publisherDomain, resolvePublisherDomain, isAggregatorHost } from "../src/domain.js";
import { classifyItem, matchPublisher, PUBLISHERS, UNTRUSTED_REASON } from "../src/publishers.js";
import { parseRssItems } from "../src/rss.js";
import { MAYORS } from "../src/mayors.js";

test("compound domains keep the organization", () => {
  assert.equal(publisherDomain("https://www.seoul.go.kr/news"), "seoul.go.kr");
  assert.equal(publisherDomain("https://city.osaka.lg.jp/a"), "osaka.lg.jp");
  assert.equal(publisherDomain("https://www.bbc.co.uk/news"), "bbc.co.uk");
  assert.equal(publisherDomain("https://en.yna.co.kr/view/1"), "yna.co.kr");
});

test("google wrappers are aggregators", () => {
  assert.equal(isAggregatorHost("google.com"), true);
  assert.equal(isAggregatorHost(publisherDomain("https://news.google.com/rss/articles/x")), true);
  assert.equal(isAggregatorHost("elpais.com"), false);
});

test("RSS source url is preferred over google article link", () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item>
      <title>Oh Se-hoon budget - Yonhap</title>
      <link>https://news.google.com/rss/articles/CBMiABC</link>
      <source url="https://en.yna.co.kr/view/AEN">Yonhap</source>
    </item>
  </channel></rss>`;
  const [item] = parseRssItems(xml);
  assert.equal(item.publisher_url, "https://en.yna.co.kr/view/AEN");
  assert.equal(resolvePublisherDomain(item), "yna.co.kr");
});

test("trusted yonhap reaches inbox for seoul", () => {
  const seoul = MAYORS.find((m) => m.id === "seoul");
  const verdict = classifyItem(
    {
      title: "Oh Se-hoon announces Seoul housing plan",
      snippet: "Seoul mayor",
      url: "https://news.google.com/rss/articles/x",
      publisher_url: "https://www.koreaherald.com/article/1",
      source: "google_news",
    },
    seoul,
  );
  assert.equal(verdict.status, "inbox");
  assert.equal(verdict.publisher_domain, "koreaherald.com");
  assert.equal(verdict.exclude_reason, null);
});

test("google wrapper with allowlisted outlet suffix is trusted", () => {
  const turin = MAYORS.find((m) => m.id === "turin");
  const verdict = classifyItem(
    {
      title: "Turin, clashes at the Askatasuna social centre rally, Lo Russo - Il Sole 24 ORE",
      url: "https://news.google.com/rss/articles/CBMiabc",
      source: "google_news",
    },
    turin,
  );
  assert.equal(verdict.status, "inbox");
  assert.equal(verdict.publisher_domain, "ilsole24ore.com");
});

test("turin local paper in the title suffix is trusted", () => {
  const turin = MAYORS.find((m) => m.id === "turin");
  const verdict = classifyItem(
    {
      title: 'Torino al buio, blackout a catena. Lo Russo: “È un’emergenza, rete vecchia” - Quotidiano Piemontese',
      url: "https://news.google.com/rss/articles/CBMiblackout",
      source: "google_news",
    },
    turin,
  );
  assert.equal(verdict.status, "inbox");
  assert.equal(verdict.publisher_domain, "quotidianopiemontese.it");
});

test("unknown click-farm is excluded as untrusted", () => {
  const seoul = MAYORS.find((m) => m.id === "seoul");
  const verdict = classifyItem(
    {
      title: "Oh Se-hoon shocking secret you will not believe",
      url: "https://topviral-daily24.com/oh-se-hoon",
      publisher_url: "https://topviral-daily24.com/",
      source: "google_news",
    },
    seoul,
  );
  assert.equal(verdict.status, "excluded");
  assert.equal(verdict.exclude_reason, UNTRUSTED_REASON);
});

test("official host is tier 0", () => {
  const madrid = MAYORS.find((m) => m.id === "madrid");
  const pub = matchPublisher("madrid.es", madrid);
  assert.equal(pub.tier, 0);
  const osaka = MAYORS.find((m) => m.id === "osaka");
  const osakaPub = matchPublisher("osaka.lg.jp", osaka);
  assert.ok(osakaPub);
  assert.equal(osakaPub.tier, 0);
});

test("publisher registry covers all phase-1 countries", () => {
  const codes = new Set(MAYORS.map((m) => m.country_code));
  for (const code of codes) {
    assert.ok(
      PUBLISHERS.some((p) => p.country_code === code && p.tier === 0),
      `missing official publisher for ${code}`,
    );
  }
});
