import test from "node:test";
import assert from "node:assert/strict";
import worker, { authorized, ensureDb } from "../src/worker.js";
import { createTestD1 } from "./helpers/d1.js";
import { MAYORS } from "../src/mayors.js";
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
