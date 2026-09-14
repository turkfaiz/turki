import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { extractArticleLinks, inspectListingPage } from "../src/newsroom.js";
import { parseFeed } from "../src/rss.js";
import { discoverSource } from "../src/discovery.js";
import { MAYORS } from "../src/mayors.js";
import { sourcesFor } from "../src/sources.js";

const fixture = (name) =>
  fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        const hit = Object.entries(headers).find(
          ([key]) => key.toLowerCase() === name.toLowerCase(),
        );
        return hit ? String(hit[1]) : null;
      },
    },
    async text() {
      return body;
    },
  };
}

test("malaga press adapter keeps note ids and drops service tramites", () => {
  const html = fixture("malaga-press.html");
  const links = extractArticleLinks(
    html,
    "https://www.malaga.eu/el-ayuntamiento/notas-de-prensa/",
    "malaga-press",
  );
  assert.ok(links.length > 3, "real press notes should be extracted");
  assert.ok(links.every((link) => /id=\d+/.test(link.url)));
  assert.ok(!links.some((link) => /tramite|sede\.malaga/.test(link.url)));
});

test("pristina listing extracts lajmet articles from the live page snapshot", () => {
  const html = fixture("pristina-lajmet.html");
  const links = extractArticleLinks(html, "https://prishtinaonline.com/lajmet", "pristina-lajmet");
  assert.ok(links.length > 0);
  assert.ok(links.every((link) => /\/lajmet\/\d+\//.test(link.url)));
});

test("osaka newsroom snapshot yields municipal page urls", () => {
  const html = fixture("osaka-newsroom.html");
  const links = extractArticleLinks(
    html,
    "https://www.city.osaka.lg.jp/shisei/news/curr.html",
    "osaka-city",
  );
  assert.ok(links.length > 0);
  assert.ok(links.every((link) => /city\.osaka\.lg\.jp/.test(link.url)));
  assert.ok(!links.some((link) => /site_policy/.test(link.url)));
});

test("oman observer keeps numbered articles and drops section indexes", () => {
  const html = fixture("oman-observer.html");
  const links = extractArticleLinks(html, "https://www.omanobserver.om/oman", "oman-observer");
  assert.equal(links.length, 2);
  assert.ok(links.every((link) => /\/article\/\d+\//.test(link.url)));
  assert.ok(!links.some((link) => /morearticles|terms-and-conditions/.test(link.url)));
});

test("a site adapter does not treat service indexes as articles", () => {
  const html = `
    <a href="/ar/Page.aspx?PAID=1">عن البلدية</a>
    <a href="/ar/Page.aspx?PAID=2#NewsDetails&NID=2704">خبر بلدية مسقط</a>
    <a href="/ar/SiteMap.aspx">الخريطة</a>`;
  const links = extractArticleLinks(html, "https://www.mm.gov.om/ar/Page.aspx?PAID=2", "muscat-mm");
  assert.deepEqual(
    links.map((link) => link.url),
    ["https://www.mm.gov.om/ar/Page.aspx?PAID=2&NID=2704"],
  );
});

test("service and contact links are not treated as articles", () => {
  const html = fixture("service-links.html");
  const links = extractArticleLinks(
    html,
    "https://www.ammancity.gov.jo/ar/gam/news.aspx",
    "amman-gam",
  );
  assert.deepEqual(
    links.map((link) => link.url),
    ["https://www.ammancity.gov.jo/ar/gam/news-details.aspx?id=1024"],
  );
});

test("a 200 error page is not a successful listing", () => {
  const html = fixture("error-200.html");
  const verdict = inspectListingPage(html, 200, "https://prishtinaonline.com/missing");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "error_page");
});

test("a javascript shell is reported as needing the browser", () => {
  const html = fixture("js-shell.html");
  const verdict = inspectListingPage(html, 200, "https://www.northeast-ca.gov.uk/news");
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "needs_javascript");
});

test("rabat next-data adapter reads embedded posts and skips contact", () => {
  const html = fixture("rabat-next.html");
  const links = extractArticleLinks(html, "https://mairiederabat.ma/ar-AR", "rabat-mairie");
  assert.ok(links.some((link) => /madame-fatiha-el-moudni/.test(link.url)));
  assert.ok(!links.some((link) => /Contact/.test(link.url)));
});

test("muscat rss snapshot is a real feed with article links", () => {
  const parsed = parseFeed(fixture("muscat-rss.xml"));
  assert.equal(parsed.corrupt, false);
  assert.ok(parsed.items.length > 0);
  assert.ok(parsed.items.every((item) => /mm\.gov\.om/.test(item.url)));
});

test("healthy rss with no items is success, not a fallback", async () => {
  const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Seoul</title></channel></rss>`;
  const source = sourcesFor("seoul")[0];
  const mayor = MAYORS.find((row) => row.id === "seoul");
  const fetchImpl = async (url) => {
    if (String(url).includes("/feed")) return response(200, xml);
    throw new Error(`unexpected fallback ${url}`);
  };
  const result = await discoverSource(source, mayor, { fetch: fetchImpl });
  assert.equal(result.health.ok, true);
  assert.equal(result.health.status, "ok_no_new");
  assert.equal(result.used, "rss");
  assert.equal(result.rows.length, 0);
});

test("not-modified rss is success without opening the newsroom", async () => {
  const source = sourcesFor("seoul")[0];
  const mayor = MAYORS.find((row) => row.id === "seoul");
  const fetchImpl = async () => response(304, "", { ETag: '"abc"' });
  const result = await discoverSource(source, mayor, {
    fetch: fetchImpl,
    cond: { etag: '"abc"' },
    condUrl: source.url,
  });
  assert.equal(result.health.ok, true);
  assert.equal(result.health.status, "ok_no_new");
  assert.equal(result.used, "rss");
});

test("healthy rss with no new items this week is not a fault", async () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>Oh Se-hoon yesterday</title><link>https://english.seoul.go.kr/a</link>
    <pubDate>Sun, 13 Sep 2026 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const source = sourcesFor("seoul")[0];
  const mayor = MAYORS.find((row) => row.id === "seoul");
  const fetchImpl = async (url) => {
    if (String(url).includes("/feed")) return response(200, xml);
    throw new Error(`unexpected ${url}`);
  };
  const result = await discoverSource(source, mayor, { fetch: fetchImpl });
  assert.equal(result.health.ok, true);
  assert.equal(result.health.status, "ok");
  assert.equal(result.rows.length, 1);
});

test("corrupt rss falls back to the newsroom strategy", async () => {
  const source = {
    ...sourcesFor("muscat")[0],
    discovery: [
      { type: "rss", url: "https://www.mm.gov.om/ar/rss.aspx", enabled: true },
      { type: "newsroom", url: "https://www.mm.gov.om/ar/", adapter: "muscat-mm", enabled: true },
    ],
  };
  const mayor = MAYORS.find((row) => row.id === "muscat");
    const newsroom = `
    <html><head><title>Muscat</title></head><body>
      <a href="/ar/Page.aspx?PAID=2&NID=2704">خبر بلدية مسقط</a>
    </body></html>`;
  const fetchImpl = async (url) => {
    if (String(url).includes("rss.aspx")) return response(200, fixture("corrupt-rss.html"));
    if (String(url).includes("/ar/")) return response(200, newsroom);
    throw new Error(`unexpected ${url}`);
  };
  const result = await discoverSource(source, mayor, { fetch: fetchImpl });
  assert.equal(result.used, "newsroom");
  assert.equal(result.health.ok, true);
  assert.ok(result.rows.some((row) => /NID=2704/.test(row.url)));
});

test("stalled rss keeps its article urls if the newsroom is empty", async () => {
  const source = {
    ...sourcesFor("muscat")[0],
    discovery: [
      { type: "rss", url: "https://www.mm.gov.om/ar/rss.aspx", enabled: true },
      { type: "newsroom", url: "https://www.mm.gov.om/ar/Page.aspx?PAID=2", adapter: "muscat-mm", enabled: true },
    ],
  };
  const mayor = MAYORS.find((row) => row.id === "muscat");
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title>بلدية مسقط</title>
    <link>https://www.mm.gov.om/ar/Page.aspx?PAID=2#NewsDetails&amp;NID=1</link>
    <pubDate>Mon, 01 Jan 2024 10:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const fetchImpl = async (url) => {
    if (String(url).includes("rss.aspx")) return response(200, xml);
    return response(200, "<html><head><title>News</title></head><body><a href='/ar/Page.aspx?PAID=1'>عن البلدية</a></body></html>");
  };
  const result = await discoverSource(source, mayor, { fetch: fetchImpl });
  assert.equal(result.health.ok, false);
  assert.equal(result.health.status, "feed_stalled");
  assert.ok(result.rows.some((row) => /NID=1/.test(row.url)));
});

test("one source failure does not prevent discovering another office source", async () => {
  const mayor = MAYORS.find((row) => row.id === "turin");
  const official = sourcesFor("turin")[0];
  const press = sourcesFor("turin")[2];
  const fetchImpl = async (url) => {
    if (String(url).includes("comune.torino.it")) return response(403, "denied");
    if (String(url).includes("repubblica")) {
      return response(
        200,
        `<?xml version="1.0"?><rss><channel>
          <item><title>Lo Russo in centro</title>
          <link>https://torino.repubblica.it/2026/09/lo-russo</link>
          <pubDate>Sun, 13 Sep 2026 09:00:00 GMT</pubDate></item>
        </channel></rss>`,
      );
    }
    throw new Error(`unexpected ${url}`);
  };
  const failed = await discoverSource(official, mayor, { fetch: fetchImpl });
  const ok = await discoverSource(press, mayor, { fetch: fetchImpl });
  assert.equal(failed.health.ok, false);
  assert.match(failed.health.status, /worker_rejected|http_403|403/);
  assert.equal(ok.health.ok, true);
  assert.equal(ok.rows.length, 1);
});
