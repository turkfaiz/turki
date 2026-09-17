import test from "node:test";
import assert from "node:assert/strict";
import worker, { authorized, ensureDb } from "../src/worker.js";
import { createTestD1 } from "./helpers/d1.js";
import { MAYORS, parseMayorInput, slugifyMayorId } from "../src/mayors.js";
import { APPROVED_SOURCES, parseOfficePlatforms } from "../src/sources.js";
import { runScan } from "../src/collect.js";

function envWith(overrides = {}) {
  return {
    DB: createTestD1(),
    GEMINI_MODEL: "gemini-test",
    ...overrides,
  };
}

function request(path, { method = "GET", body, user = "mayorwatch", password } = {}) {
  const headers = { "content-type": "application/json" };
  if (password) headers.Authorization = `Basic ${btoa(`${user}:${password}`)}`;
  return new Request(`https://mayor-watch.test${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

function samplePlatforms() {
  return [
    {
      name: "بلدية الرياض",
      url: "https://www.alriyadh.gov.sa/news",
      platform: "official",
    },
    {
      name: "وكالة محلية",
      url: "https://www.spa.gov.sa/rss.xml",
      platform: "agency",
    },
  ];
}

function sampleMayor(overrides = {}) {
  return {
    name_ar: "نورة العبدالله",
    name_en: "Noura Alabdullah",
    city_ar: "الرياض",
    city_en: "Riyadh",
    country_ar: "السعودية",
    country_code: "SA",
    native_lang: "ar",
    ...overrides,
  };
}

function fakeQueue() {
  const messages = [];
  return {
    messages,
    async sendBatch(batch) {
      messages.push(...(batch || []));
    },
    async send(message) {
      messages.push(message);
    },
  };
}

test("settings list every mayor with office titles and platforms from the registry", async () => {
  const env = envWith();
  await ensureDb(env);
  const res = await worker.fetch(request("/api/settings/offices"), env);
  assert.equal(res.status, 200);
  const payload = await res.json();
  assert.equal(payload.offices.length, MAYORS.length);
  for (const mayor of MAYORS) {
    const office = payload.offices.find((row) => row.id === mayor.id);
    assert.ok(office, mayor.id);
    assert.equal(office.origin, "seed");
    assert.equal(office.name_ar, mayor.name_ar);
    assert.equal(office.name_en, mayor.name_en);
    assert.equal(office.name_native, mayor.name_native);
    assert.equal(office.title_en, mayor.title_en);
    assert.equal(office.city_en, mayor.city_en);
    assert.ok(office.platforms.length >= 1);
    assert.ok(office.platforms.every((platform) => platform.platform_ar));
  }
  assert.equal(
    payload.offices.reduce((sum, office) => sum + office.platforms.length, 0),
    APPROVED_SOURCES.length,
  );
});

test("an authorized user can disable and re-enable a registered platform", async () => {
  const env = envWith({ DASHBOARD_PASSWORD: "secret", DASHBOARD_USER: "mayorwatch" });
  await ensureDb(env);
  const auth = { password: "secret" };
  const off = await worker.fetch(
    request("/api/settings/sources/turin:comune.torino.it", {
      method: "POST",
      body: { enabled: false },
      ...auth,
    }),
    env,
  );
  assert.equal(off.status, 200);
  const listed = await worker.fetch(request("/api/settings/offices", auth), env).then((r) => r.json());
  const turin = listed.offices.find((row) => row.id === "turin");
  const official = turin.platforms.find((row) => row.id === "turin:comune.torino.it");
  assert.equal(official.enabled, false);
  const audit = env.DB.one(`SELECT actor, before_json, after_json FROM settings_audit`);
  assert.equal(audit.actor, "mayorwatch");
  assert.match(audit.before_json, /true/);
  assert.match(audit.after_json, /false/);
});

test("an unauthenticated caller cannot change platform settings", async () => {
  const env = envWith({ DASHBOARD_PASSWORD: "secret" });
  await ensureDb(env);
  const res = await worker.fetch(
    request("/api/settings/sources/turin:comune.torino.it", {
      method: "POST",
      body: { enabled: false },
    }),
    env,
  );
  assert.equal(res.status, 401);
  assert.equal(authorized(request("/api/settings/offices"), env), false);
});

test("the settings api refuses a random domain addition", async () => {
  const env = envWith({ DASHBOARD_PASSWORD: "secret" });
  await ensureDb(env);
  const res = await worker.fetch(
    request("/api/settings/sources/turin:comune.torino.it", {
      method: "POST",
      body: { enabled: true, domain: "random-blog.example" },
      password: "secret",
    }),
    env,
  );
  assert.equal(res.status, 403);
});

test("parseMayorInput fills titles and language labels from the required basics", () => {
  const parsed = parseMayorInput(sampleMayor());
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.mayor.id, slugifyMayorId("Riyadh", "Noura Alabdullah"));
  assert.equal(parsed.mayor.title_ar, "عمدة الرياض");
  assert.equal(parsed.mayor.title_en, "Mayor of Riyadh");
  assert.equal(parsed.mayor.name_native, "Noura Alabdullah");
  assert.equal(parsed.mayor.native_lang_ar, "العربية");
  assert.equal(parsed.mayor.gn_hl, "ar");
  assert.equal(parsed.mayor.gn_gl, "SA");
  assert.equal(parsed.mayor.origin, "custom");
});

test("parseMayorInput rejects a seed office and a private host", () => {
  assert.equal(parseMayorInput(sampleMayor({ id: "turin" })).error, "seed_mayor");
  assert.equal(
    parseMayorInput(sampleMayor({ official_host: "http://127.0.0.1/news" })).error,
    "bad_official_host",
  );
  const missing = parseMayorInput({ city_en: "Riyadh" });
  assert.equal(missing.error, "missing_fields");
  assert.ok(missing.detail.includes("name_ar"));
});

test("an authorized user can add a custom mayor from settings", async () => {
  const env = envWith({ DASHBOARD_PASSWORD: "secret", DASHBOARD_USER: "mayorwatch" });
  await ensureDb(env);
  const auth = { password: "secret" };
  const created = await worker.fetch(
    request("/api/settings/mayors", {
      method: "POST",
      body: sampleMayor({ official_host: "https://alriyadh.gov.sa/news", platforms: samplePlatforms() }),
      ...auth,
    }),
    env,
  );
  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.equal(payload.mayor.origin, "custom");
  assert.equal(payload.mayor.official_host, "alriyadh.gov.sa");
  assert.equal(payload.offices.length, MAYORS.length + 1);
  const office = payload.offices.find((row) => row.id === payload.mayor.id);
  assert.equal(office.origin, "custom");
  assert.equal(office.platforms.length, 2);
  assert.equal(office.platforms[0].domain, "alriyadh.gov.sa");
  assert.ok(office.platforms[0].strategies.length >= 1);

  const listed = await worker.fetch(request("/api/settings/offices", auth), env).then((r) => r.json());
  assert.ok(listed.offices.some((row) => row.id === payload.mayor.id && row.origin === "custom"));
  const mayors = await worker.fetch(request("/api/mayors", auth), env).then((r) => r.json());
  assert.ok(mayors.mayors.some((row) => row.id === payload.mayor.id && row.name_ar === "نورة العبدالله"));
  const sources = env.DB.one(`SELECT COUNT(*) AS n FROM sources WHERE mayor_id = ?`, payload.mayor.id);
  assert.equal(Number(sources.n), 2);
  const audit = env.DB.one(`SELECT actor, action, mayor_id FROM settings_audit WHERE action = 'mayor_created'`);
  assert.equal(audit.actor, "mayorwatch");
  assert.equal(audit.mayor_id, payload.mayor.id);
});

test("adding a mayor from settings still refuses a crawl domain", async () => {
  const env = envWith({ DASHBOARD_PASSWORD: "secret" });
  await ensureDb(env);
  const res = await worker.fetch(
    request("/api/settings/mayors", {
      method: "POST",
      body: { ...sampleMayor(), domain: "random-blog.example" },
      password: "secret",
    }),
    env,
  );
  assert.equal(res.status, 403);
});

test("missing mayor fields and seed ids are rejected", async () => {
  const env = envWith({ DASHBOARD_PASSWORD: "secret" });
  await ensureDb(env);
  const missing = await worker.fetch(
    request("/api/settings/mayors", {
      method: "POST",
      body: { name_ar: "نورة" },
      password: "secret",
    }),
    env,
  );
  assert.equal(missing.status, 400);
  const payload = await missing.json();
  assert.equal(payload.error, "missing_fields");
  const seed = await worker.fetch(
    request("/api/settings/mayors", {
      method: "POST",
      body: sampleMayor({ id: "seoul" }),
      password: "secret",
    }),
    env,
  );
  assert.equal(seed.status, 400);
  assert.equal((await seed.json()).error, "seed_mayor");
});

test("an unauthenticated caller cannot add a mayor", async () => {
  const env = envWith({ DASHBOARD_PASSWORD: "secret" });
  await ensureDb(env);
  const res = await worker.fetch(
    request("/api/settings/mayors", {
      method: "POST",
      body: sampleMayor(),
    }),
    env,
  );
  assert.equal(res.status, 401);
});

test("a custom mayor without platforms is refused so the office is not empty", async () => {
  const env = envWith({ DASHBOARD_PASSWORD: "secret" });
  await ensureDb(env);
  const res = await worker.fetch(
    request("/api/settings/mayors", {
      method: "POST",
      body: sampleMayor(),
      password: "secret",
    }),
    env,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, "missing_platforms");
});

test("office platforms reject search engines and accept a dated rss poll", async () => {
  assert.equal(parseOfficePlatforms([{ url: "https://news.google.com/rss" }]).error, "registry_closed");
  assert.equal(parseOfficePlatforms([{ url: "https://www.bing.com/news" }]).error, "registry_closed");
  const parsed = parseOfficePlatforms(samplePlatforms());
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.platforms.length, 2);

  const env = envWith();
  await ensureDb(env);
  const created = await worker
    .fetch(
      request("/api/settings/mayors", {
        method: "POST",
        body: sampleMayor({
          id: "riyadh-noura",
          platforms: [
            {
              name: "بلدية",
              url: "https://www.alriyadh.gov.sa/rss.xml",
              platform: "official",
            },
          ],
        }),
      }),
      env,
    )
    .then((res) => res.json());
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("alriyadh.gov.sa")) {
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: async () => `<?xml version="1.0"?><rss><channel><item>
          <title>نورة العبدالله تفتتح حديقة</title>
          <link>https://www.alriyadh.gov.sa/news/park</link>
          <pubDate>${new Date(Date.now() - 36 * 60 * 60 * 1000).toUTCString()}</pubDate>
        </item></channel></rss>`,
      };
    }
    return { status: 404, ok: false, headers: { get: () => null }, text: async () => "missing" };
  };
  try {
    const scan = await runScan(env, { type: "manual", mayorId: created.mayor.id });
    const health = scan.sourceHealth.find((row) => row.id === "riyadh-noura:alriyadh.gov.sa");
    assert.equal(health.ok, true);
    assert.ok(Number(health.new_count || health.discovered) >= 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
