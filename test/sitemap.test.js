import test from "node:test";
import assert from "node:assert/strict";
import { parseSitemap } from "../src/sitemap.js";

const THIS_WEEK = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();

test("sitemaps without lastmod are treated as archives and dropped", () => {
  const xml = `<?xml version="1.0"?>
    <urlset>
      <url><loc>https://www.comune.torino.it/archive/1</loc></url>
      <url><loc>https://www.comune.torino.it/archive/2</loc></url>
    </urlset>`;
  assert.deepEqual(parseSitemap(xml), []);
});

test("stale lastmod urls are dropped and in-week urls are kept", () => {
  const xml = `<?xml version="1.0"?>
    <urlset>
      <url>
        <loc>https://www.comune.torino.it/old</loc>
        <lastmod>2020-01-01</lastmod>
      </url>
      <url>
        <loc>https://www.comune.torino.it/fresh</loc>
        <lastmod>${THIS_WEEK}</lastmod>
      </url>
    </urlset>`;
  const rows = parseSitemap(xml);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, "https://www.comune.torino.it/fresh");
});
