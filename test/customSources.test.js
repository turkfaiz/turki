import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { ensureDb } from "../src/db/bootstrap.js";
import { refreshCustomSources } from "../src/db/customSources.js";
import { createTestD1 } from "./helpers/d1.js";
import { runScan, enabledSources } from "../src/pipeline.js";
import { isApprovedUrl, sourcesFor, setCustomSources } from "../src/sources.js";
import { normalizeSiteInput } from "../src/sourceProbe.js";
import { classifyItem } from "../src/publishers.js";
import { resolveMayor } from "../src/mayors.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  setCustomSources([]);
});

const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000);

/** موقع وهمي: خريطة رابط → { status, body, headers }. */
function fakeWeb(routes) {
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    const hit = routes[url] ?? routes[url.replace(/\/$/, "")];
    const spec = hit ?? { status: 404, body: "not found" };
    const headers = spec.headers || {};
    return {
      status: spec.status ?? 200,
      headers: {
        get: (name) => {
          const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase());
          return key ? String(headers[key]) : null;
        },
      },
      async text() {
        return spec.body ?? "";
      },
    };
  };
}

const rss = (items) =>
  `<?xml version="1.0"?><rss><channel>${items
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>${item.link}</link><pubDate>${item.date.toUTCString()}</pubDate></item>`,
    )
    .join("")}</channel></rss>`;

const MAYOR_BODY = {
  name_ar: "نورة العبدالله",
  name_en: "Noura Alabdullah",
  city_ar: "الرياض",
  city_en: "Riyadh",
  country_ar: "السعودية",
  country_code: "SA",
  native_lang: "en",
};

function request(path, { method = "GET", body } = {}) {
  return new Request(`https://mayor-watch.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function newDesk() {
  const env = { DB: createTestD1(), GEMINI_MODEL: "t" };
  await ensureDb(env);
  const res = await worker.fetch(request("/api/settings/mayors", { method: "POST", body: MAYOR_BODY }), env);
  assert.equal(res.status, 201);
  const { mayor } = await res.json();
  return { env, mayorId: mayor.id };
}

const addSite = (env, mayorId, url, platform) =>
  worker.fetch(request(`/api/settings/mayors/${mayorId}/sites`, { method: "POST", body: { url, platform } }), env);

const feedSite = (host, items) => ({
  [`https://${host}/`]: {
    body: `<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body></body></html>`,
  },
  [`https://${host}/feed.xml`]: { body: rss(items) },
});

test("site input is normalised and unsafe targets are refused with a reason", () => {
  const ok = normalizeSiteInput("WWW.Example.com/news/");
  assert.equal(ok.ok, true);
  assert.equal(ok.domain, "example.com");
  for (const [input, error] of [
    ["", "empty"],
    ["ftp://example.com", "bad_scheme"],
    ["https://user:pass@example.com", "credentials_in_url"],
    ["http://127.0.0.1/admin", "bad_host"],
    ["http://169.254.169.254/", "bad_host"],
    ["localhost", "bad_host"],
    ["https://news.google.com/rss", "aggregator"],
    ["https://www.facebook.com/mayor", "shared_platform"],
    ["https://someone.blogspot.com", "shared_platform"],
  ]) {
    const result = normalizeSiteInput(input);
    assert.equal(result.ok, false, input);
    assert.equal(result.error, error, input);
  }
});

test("a site with an RSS feed is detected, registered, trialled and approved for its office only", async () => {
  const { env, mayorId } = await newDesk();
  fakeWeb(
    feedSite("news.example.org", [
      { title: "Noura Alabdullah opens a new park", link: "https://news.example.org/a1", date: hoursAgo(5) },
      { title: "Unrelated sports score", link: "https://news.example.org/a2", date: hoursAgo(6) },
    ]),
  );
  const res = await addSite(env, mayorId, "https://news.example.org/");
  assert.equal(res.status, 201);
  const added = await res.json();
  assert.equal(added.id, `${mayorId}:news.example.org`);
  assert.deepEqual(added.steps.map((step) => step.type), ["rss"]);
  assert.equal(added.trial.recent_links, 2);
  assert.equal(added.trial.about_mayor, 1);

  assert.equal(isApprovedUrl("https://news.example.org/a1", mayorId), true);
  assert.equal(isApprovedUrl("https://news.example.org/a1", "turin"), false);
  assert.equal(isApprovedUrl("https://other.example.net/a1", mayorId), false);
  assert.equal(sourcesFor(mayorId).length, 1);
  assert.equal((await enabledSources(env, mayorId)).length, 1);

  const mayor = await resolveMayor(env, mayorId);
  const verdict = classifyItem(
    { title: "Noura Alabdullah opens a new park", url: "https://news.example.org/a1", source: "approved_rss" },
    mayor,
  );
  assert.equal(verdict.status, "inbox");
  assert.equal(verdict.publisher_tier, 1);
});

test("a new office is created with its sites in one request and scans them automatically", async () => {
  const env = { DB: createTestD1(), GEMINI_MODEL: "t" };
  await ensureDb(env);
  fakeWeb(
    feedSite("daily.example.org", [
      { title: "Noura Alabdullah visits the new school", link: "https://daily.example.org/s1", date: hoursAgo(3) },
    ]),
  );
  const res = await worker.fetch(
    request("/api/settings/mayors", {
      method: "POST",
      body: { ...MAYOR_BODY, sites: [{ url: "daily.example.org", platform: "official" }] },
    }),
    env,
  );
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.equal(created.sites[0].ok, true);
  assert.equal(sourcesFor(created.mayor.id)[0].tier, 0);

  const scan = await runScan(env, { type: "manual", mayorId: created.mayor.id });
  assert.deepEqual(scan.errors, []);
  assert.equal(scan.discovered, 1);
  const candidate = env.DB.one(`SELECT url, source_id FROM candidates`);
  assert.equal(candidate.url, "https://daily.example.org/s1");
  assert.equal(candidate.source_id, `${created.mayor.id}:daily.example.org`);
});

test("an office never has more than three active sites", async () => {
  const { env, mayorId } = await newDesk();
  for (const host of ["a.example.org", "b.example.org", "c.example.org"]) {
    fakeWeb({
      ...feedSite("a.example.org", [{ title: "x one two", link: "https://a.example.org/1", date: hoursAgo(1) }]),
      ...feedSite("b.example.org", [{ title: "x one two", link: "https://b.example.org/1", date: hoursAgo(1) }]),
      ...feedSite("c.example.org", [{ title: "x one two", link: "https://c.example.org/1", date: hoursAgo(1) }]),
      ...feedSite("d.example.org", [{ title: "x one two", link: "https://d.example.org/1", date: hoursAgo(1) }]),
    });
    assert.equal((await addSite(env, mayorId, host)).status, 201, host);
  }
  const fourth = await addSite(env, mayorId, "d.example.org");
  assert.equal(fourth.status, 409);
  assert.equal((await fourth.json()).error, "office_full");
  const dup = await addSite(env, mayorId, "a.example.org");
  assert.equal((await dup.json()).error, "duplicate_domain");

  // إيقاف موقع يفرّغ خانة.
  const off = await worker.fetch(
    request(`/api/settings/sources/${encodeURIComponent(`${mayorId}:a.example.org`)}`, {
      method: "POST",
      body: { enabled: false },
    }),
    env,
  );
  assert.equal(off.status, 200);
  assert.equal((await addSite(env, mayorId, "d.example.org")).status, 201);
});

test("a site that cannot be read is rejected and leaves no trace", async () => {
  const { env, mayorId } = await newDesk();
  fakeWeb({ "https://empty.example.org/": { body: "<html><body><p>Hello</p></body></html>" } });
  const res = await addSite(env, mayorId, "empty.example.org");
  assert.equal(res.status, 422);
  assert.equal((await res.json()).error, "nothing_readable");
  assert.equal(env.DB.one(`SELECT COUNT(*) AS n FROM sources WHERE origin = 'custom'`).n, 0);

  fakeWeb({ "https://blocked.example.org/": { status: 403, body: "no" } });
  const blocked = await addSite(env, mayorId, "blocked.example.org");
  assert.equal(blocked.status, 422);
  assert.equal((await blocked.json()).error, "unreachable");

  fakeWeb({
    "https://moved.example.org/": { status: 301, headers: { Location: "https://elsewhere.example.net/" } },
    "https://elsewhere.example.net/": { body: "<html></html>" },
  });
  const moved = await addSite(env, mayorId, "moved.example.org");
  assert.equal((await moved.json()).error, "redirects_elsewhere");
});

test("a WordPress site also searches by the mayor's name and merges the results", async () => {
  const { env, mayorId } = await newDesk();
  const post = (id, title, date) => ({
    link: `https://wp.example.org/p/${id}`,
    title: { rendered: title },
    date_gmt: date.toISOString(),
    excerpt: { rendered: "" },
  });
  fakeWeb({
    "https://wp.example.org/": { body: `<html><head><link rel="stylesheet" href="/wp-content/x.css"></head></html>` },
    "https://wp.example.org/feed": { status: 404 },
    "https://wp.example.org/wp-json/wp/v2/posts?per_page=20&orderby=date": {
      body: JSON.stringify([post(1, "Weather today", hoursAgo(2)), post(2, "Local sports", hoursAgo(3))]),
    },
    "https://wp.example.org/wp-json/wp/v2/posts?per_page=20&orderby=date&search=Noura%20Alabdullah": {
      body: JSON.stringify([post(9, "Noura Alabdullah launches the bus plan", hoursAgo(20))]),
    },
  });
  const res = await addSite(env, mayorId, "wp.example.org");
  assert.equal(res.status, 201);
  const added = await res.json();
  assert.deepEqual(added.steps.map((step) => `${step.type}${step.supplement ? "+" : ""}`), ["api", "api+"]);
  assert.equal(added.trial.supplement_found, 1);
  assert.equal(added.trial.about_mayor, 1);
  assert.match(added.trial.samples[0].title, /bus plan/);
});

test("custom sources can be removed but registry sources cannot", async () => {
  const { env, mayorId } = await newDesk();
  fakeWeb(feedSite("gone.example.org", [{ title: "x one two", link: "https://gone.example.org/1", date: hoursAgo(1) }]));
  await addSite(env, mayorId, "gone.example.org");
  const id = encodeURIComponent(`${mayorId}:gone.example.org`);
  const del = await worker.fetch(request(`/api/settings/sources/${id}`, { method: "DELETE" }), env);
  assert.equal(del.status, 200);
  assert.equal(sourcesFor(mayorId).length, 0);
  assert.equal(isApprovedUrl("https://gone.example.org/1", mayorId), false);

  const seed = await worker.fetch(
    request(`/api/settings/sources/${encodeURIComponent("turin:comune.torino.it")}`, { method: "DELETE" }),
    env,
  );
  assert.equal(seed.status, 403);
  assert.equal(env.DB.one(`SELECT COUNT(*) AS n FROM settings_audit WHERE action = 'source_removed'`).n, 1);
});

test("custom sources survive a new worker isolate through the D1 reload", async () => {
  const { env, mayorId } = await newDesk();
  fakeWeb(feedSite("keep.example.org", [{ title: "x one two", link: "https://keep.example.org/1", date: hoursAgo(1) }]));
  await addSite(env, mayorId, "keep.example.org");
  setCustomSources([]);
  assert.equal(sourcesFor(mayorId).length, 0);
  await refreshCustomSources(env, { force: true });
  assert.equal(sourcesFor(mayorId).length, 1);
  assert.equal(sourcesFor(mayorId)[0].origin, "custom");
});
