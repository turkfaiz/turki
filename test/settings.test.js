import test from "node:test";
import assert from "node:assert/strict";
import worker, { authorized, ensureDb } from "../src/worker.js";
import { createTestD1 } from "./helpers/d1.js";
import { MAYORS, parseMayorInput, slugifyMayorId } from "../src/mayors.js";
import { APPROVED_SOURCES } from "../src/sources.js";

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

function sampleMayor(overrides = {}) {
  return {
    name_ar: "نورة العبدالله",
    name_en: "Noura Alabdullah",
    name_native: "نورة العبدالله",
    city_ar: "الرياض",
    city_en: "Riyadh",
    country_ar: "السعودية",
    country_code: "SA",
    native_lang: "ar",
    title_ar: "عمدة الرياض",
    title_en: "Mayor of Riyadh",
    official_url: "https://www.alriyadh.gov.sa/news",
    official_name: "أمانة الرياض",
    local_url: "https://www.alriyadh.com",
    local_name: "جريدة الرياض",
    national_url: "https://www.spa.gov.sa",
    national_name: "واس",
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
    assert.equal(office.native_lang_ar, mayor.native_lang_ar);
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
  assert.equal(parsed.mayor.name_native, "نورة العبدالله");
  assert.equal(parsed.mayor.native_lang_ar, "العربية");
  assert.equal(parsed.mayor.gn_hl, "ar");
  assert.equal(parsed.mayor.gn_gl, "SA");
  assert.equal(parsed.mayor.origin, "custom");
});

test("native-language names stay distinct from English monitoring names", () => {
  const parsed = parseMayorInput({
    name_ar: "أوه سيه هون",
    name_en: "Oh Se-hoon",
    name_native: "오세훈",
    city_ar: "سيئول",
    city_en: "Seoul",
    country_ar: "كوريا الجنوبية",
    country_code: "KR",
    native_lang: "ko",
    title_ar: "عمدة سيئول",
    title_en: "Mayor of Seoul",
  });
  assert.equal(parsed.mayor.name_en, "Oh Se-hoon");
  assert.equal(parsed.mayor.name_native, "오세훈");
  assert.equal(parsed.mayor.name_ar, "أوه سيه هون");
  const missingNative = parseMayorInput({
    name_ar: "أوه سيه هون",
    name_en: "Oh Se-hoon",
    city_ar: "سيئول",
    city_en: "Seoul",
    country_ar: "كوريا الجنوبية",
    country_code: "KR",
    native_lang: "ko",
  });
  assert.equal(missingNative.error, "missing_fields");
  assert.ok(missingNative.detail.includes("name_native"));
});

test("english offices may reuse the English name as the native monitoring name", () => {
  const parsed = parseMayorInput({
    name_ar: "كيم ماكغينيس",
    name_en: "Kim McGuinness",
    city_ar: "نيوكاسل",
    city_en: "Newcastle",
    country_ar: "المملكة المتحدة",
    country_code: "GB",
    native_lang: "en",
    title_ar: "عمدة نيوكاسل",
    title_en: "Mayor of Newcastle",
  });
  assert.equal(parsed.mayor.name_native, "Kim McGuinness");
  assert.equal(parsed.mayor.native_lang_ar, "الإنجليزية");
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
  assert.equal(parseMayorInput(sampleMayor({ native_lang: "xx" })).error, "bad_native_lang");
});

test("an authorized user can add a custom mayor from settings", async () => {
  const env = envWith({ DASHBOARD_PASSWORD: "secret", DASHBOARD_USER: "mayorwatch" });
  await ensureDb(env);
  const auth = { password: "secret" };
  const created = await worker.fetch(
    request("/api/settings/mayors", {
      method: "POST",
      body: sampleMayor({ official_host: "https://alriyadh.gov.sa/news" }),
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
  assert.equal(office.platforms.length, 3);
  assert.deepEqual(
    office.platforms.map((row) => row.platform),
    ["official", "newspaper", "agency"],
  );
  assert.equal(office.name_native, "نورة العبدالله");
  assert.equal(office.native_lang_ar, "العربية");

  const listed = await worker.fetch(request("/api/settings/offices", auth), env).then((r) => r.json());
  assert.ok(listed.offices.some((row) => row.id === payload.mayor.id && row.origin === "custom"));
  const mayors = await worker.fetch(request("/api/mayors", auth), env).then((r) => r.json());
  assert.ok(mayors.mayors.some((row) => row.id === payload.mayor.id && row.name_ar === "نورة العبدالله"));
  const sources = env.DB.query(`SELECT domain, rank, platform FROM sources WHERE mayor_id = ? ORDER BY rank`, payload.mayor.id);
  assert.deepEqual(
    sources.map((row) => row.domain),
    ["alriyadh.gov.sa", "alriyadh.com", "spa.gov.sa"],
  );
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

test("a custom mayor with three platforms is queued for those sources", async () => {
  const queue = fakeQueue();
  const env = envWith({ SCAN_QUEUE: queue });
  await ensureDb(env);
  const created = await worker
    .fetch(
      request("/api/settings/mayors", {
        method: "POST",
        body: sampleMayor({ id: "riyadh-noura" }),
      }),
      env,
    )
    .then((res) => res.json());
  assert.equal(created.platforms.length, 3);

  const queued = await worker.fetch(
    request("/api/search", {
      method: "POST",
      body: { mayor_id: created.mayor.id },
    }),
    env,
  );
  assert.equal(queued.status, 202);
  const job = await queued.json();
  assert.equal(job.queued, 3);
  assert.equal(queue.messages.length, 3);
  assert.ok(queue.messages.every((message) => message.body.type === "source_poll"));
  assert.ok(queue.messages.every((message) => message.body.mayorId === created.mayor.id));
});

test("custom platforms stay in the live registry after a worker restart", async () => {
  const db = createTestD1();
  const env = envWith({ DB: db });
  await ensureDb(env);
  const created = await worker
    .fetch(
      request("/api/settings/mayors", {
        method: "POST",
        body: sampleMayor({ id: "riyadh-noura" }),
      }),
      env,
    )
    .then((res) => res.json());
  const queue = fakeQueue();
  const restarted = envWith({ DB: db.reopen(), SCAN_QUEUE: queue });
  await ensureDb(restarted);
  const queued = await worker.fetch(
    request("/api/search", {
      method: "POST",
      body: { mayor_id: created.mayor.id },
    }),
    restarted,
  );
  assert.equal(queued.status, 202);
  assert.equal((await queued.json()).queued, 3);
  assert.equal(queue.messages.length, 3);
});

test("the three platforms reject search engines and require three distinct hosts", async () => {
  const env = envWith();
  await ensureDb(env);
  const google = await worker.fetch(
    request("/api/settings/mayors", {
      method: "POST",
      body: sampleMayor({ official_url: "https://news.google.com" }),
    }),
    env,
  );
  assert.equal(google.status, 400);
  assert.equal((await google.json()).error, "blocked_host");

  const missing = await worker.fetch(
    request("/api/settings/mayors", {
      method: "POST",
      body: {
        name_ar: "نورة العبدالله",
        name_en: "Noura Alabdullah",
        name_native: "نورة العبدالله",
        city_ar: "الرياض",
        city_en: "Riyadh",
        country_ar: "السعودية",
        country_code: "SA",
        native_lang: "ar",
      },
    }),
    env,
  );
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error, "missing_platforms");

  const duplicate = await worker.fetch(
    request("/api/settings/mayors", {
      method: "POST",
      body: sampleMayor({
        local_url: "https://www.alriyadh.gov.sa/media",
      }),
    }),
    env,
  );
  assert.equal(duplicate.status, 400);
  assert.equal((await duplicate.json()).error, "duplicate_platform");
});

test("a bootstrap replay does not delete custom office platforms", async () => {
  const db = createTestD1();
  const env = envWith({ DB: db });
  await ensureDb(env);
  const created = await worker
    .fetch(
      request("/api/settings/mayors", {
        method: "POST",
        body: sampleMayor({ id: "riyadh-noura" }),
      }),
      env,
    )
    .then((res) => res.json());
  db.exec(`UPDATE meta SET v = 'bootstrap-v1' WHERE k = 'bootstrap_version'`);
  await ensureDb(envWith({ DB: db.reopen() }));
  assert.equal(
    db.query(`SELECT domain FROM sources WHERE mayor_id = ? ORDER BY rank`, created.mayor.id).length,
    3,
  );
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM sources`).n, APPROVED_SOURCES.length + 3);
  assert.ok(db.one(`SELECT id FROM mayors WHERE id = ?`, created.mayor.id));
});
