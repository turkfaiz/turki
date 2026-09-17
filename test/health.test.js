import test from "node:test";
import assert from "node:assert/strict";
import worker, { ensureDb } from "../src/worker.js";
import { createTestD1 } from "./helpers/d1.js";

function envWith(overrides = {}) {
  return {
    DB: createTestD1(),
    GEMINI_MODEL: "gemini-test",
    DEEPSEEK_MODEL: "deepseek-flash",
    QWEN_MODEL: "qwen-flash",
    ...overrides,
  };
}

function request(path, { method = "GET", user = "mayorwatch", password } = {}) {
  const headers = { "content-type": "application/json" };
  if (password) headers.Authorization = `Basic ${btoa(`${user}:${password}`)}`;
  return new Request(`https://mayor-watch.test${path}`, { method, headers });
}

test("public health lists every AI slot without leaking secrets", async () => {
  const env = envWith({
    GEMINI_API_KEY: "gem-secret-value",
    DEEPSEEK_API_KEY: "deep-secret-value",
    QWEN_API_KEY: "qwen-secret-value",
    GEMINI_ENABLED: "1",
    DEEPSEEK_ENABLED: "1",
    QWEN_ENABLED: "1",
  });
  await ensureDb(env);
  const res = await worker.fetch(request("/api/health"), env);
  assert.equal(res.status, 200);
  const payload = await res.json();
  const ids = payload.ai.slots.map((slot) => slot.id);
  assert.deepEqual(ids, ["gemini", "deepseek", "qwen"]);
  for (const slot of payload.ai.slots) {
    assert.equal(slot.bound, true);
    assert.equal(slot.enabled, true);
    assert.equal(slot.blocked, false);
    assert.ok(slot.budget);
    assert.equal(slot.lastError, null);
    assert.equal(Object.hasOwn(slot, "hasKey"), false);
    assert.equal(Object.hasOwn(slot, "vars"), false);
  }
  assert.equal(payload.ai.configured, true);
  const usable = payload.ai.slots
    .filter((slot) => slot.bound && !slot.blocked)
    .reduce((sum, slot) => sum + slot.budget.remaining, 0);
  assert.equal(payload.ai.budget.remaining, usable);
  assert.equal(payload.ready, true);
  assert.equal(payload.writes.pressure, "idle");
  assert.equal(payload.writes.pendingArchive, 0);
  const raw = JSON.stringify(payload);
  assert.doesNotMatch(raw, /gem-secret-value|deep-secret-value|qwen-secret-value/);
  assert.doesNotMatch(raw, /GEMINI_API_KEY|DEEPSEEK_API_KEY|QWEN_API_KEY/);
});

test("a disabled or unbound slot stays visible as not bound", async () => {
  const env = envWith({
    GEMINI_API_KEY: "gem-secret-value",
    QWEN_API_KEY: "qwen-secret-value",
    QWEN_ENABLED: "0",
  });
  await ensureDb(env);
  const payload = await worker.fetch(request("/api/health"), env).then((res) => res.json());
  const byId = Object.fromEntries(payload.ai.slots.map((slot) => [slot.id, slot]));
  assert.equal(byId.gemini.bound, true);
  assert.equal(byId.deepseek.bound, false);
  assert.equal(byId.deepseek.enabled, true);
  assert.equal(byId.qwen.bound, false);
  assert.equal(byId.qwen.enabled, false);
  assert.equal(payload.ai.configured, true);
});

test("health stays live but not ready when archive candidates sit behind an idle AI queue", async () => {
  const env = envWith();
  await ensureDb(env);
  const sourceId = "turin:comune.torino.it";
  const rows = Array.from({ length: 40 }, (_, n) =>
    `('arch-h-${n}', 'turin', '${sourceId}', 'scan-arch', 'https://www.comune.torino.it/arch-${n}', 'Arch',
      NULL, datetime('now'), 'sitemap', 'candidate_discovered', 'pending', 0)`,
  ).join(",\n");
  env.DB.exec(`
    INSERT INTO candidates (
      id, mayor_id, source_id, scan_id, url, title, published_at, discovered_at,
      discovery_type, stage, fetch_status, attempts
    ) VALUES ${rows}
  `);
  const payload = await worker.fetch(request("/api/health"), env).then((res) => res.json());
  assert.equal(payload.ok, true, "liveness must not go down because of a backlog");
  assert.equal(payload.ready, false);
  assert.equal(payload.writes.ok, false);
  assert.equal(payload.writes.pressure, "archive_backlog");
  assert.equal(payload.writes.pendingArchive, 40);
  assert.equal(payload.writes.pendingFresh, 0);
  assert.equal(payload.ai.pending, 0);
  assert.match(payload.writes.detail, /أرشيف/);
});

test("diagnostics marks the database tool down when the archive pile is hidden from AI pending", async () => {
  const env = envWith({ DASHBOARD_PASSWORD: "desk-pass" });
  await ensureDb(env);
  env.DB.exec(`
    INSERT INTO candidates (
      id, mayor_id, source_id, scan_id, url, title, published_at, discovered_at,
      discovery_type, stage, fetch_status, attempts
    ) VALUES
    ('fresh-h', 'turin', 'turin:comune.torino.it', 'scan-new',
      'https://www.comune.torino.it/fresh-h', 'Fresh',
      datetime('now', '-1 days'), datetime('now'), 'rss', 'candidate_discovered', 'pending', 0),
    ('old-h', 'turin', 'turin:comune.torino.it', 'scan-old',
      'https://www.comune.torino.it/old-h', 'Old',
      NULL, datetime('now'), 'sitemap', 'candidate_discovered', 'pending', 0)
  `);
  const payload = await worker
    .fetch(request("/api/diagnostics", { password: "desk-pass" }), env)
    .then((res) => res.json());
  const database = payload.tools.find((tool) => tool.id === "database");
  assert.equal(payload.writes.pendingArchive, 1);
  assert.equal(payload.writes.pendingFresh, 1);
  assert.equal(payload.writes.pressure, "archive_backlog");
  assert.equal(database.ok, false);
  assert.match(database.detail, /أرشيف معلّق/);
});

test("diagnostics exposes one tool chip per AI slot and requires auth when keys exist", async () => {
  const env = envWith({
    GEMINI_API_KEY: "gem-secret-value",
    DEEPSEEK_API_KEY: "deep-secret-value",
    QWEN_API_KEY: "qwen-secret-value",
    DASHBOARD_PASSWORD: "desk-pass",
  });
  await ensureDb(env);
  const denied = await worker.fetch(request("/api/diagnostics"), env);
  assert.equal(denied.status, 401);

  const res = await worker.fetch(request("/api/diagnostics", { password: "desk-pass" }), env);
  assert.equal(res.status, 200);
  const payload = await res.json();
  const ids = payload.tools.map((tool) => tool.id);
  assert.ok(ids.includes("ai-gemini"));
  assert.ok(ids.includes("ai-deepseek"));
  assert.ok(ids.includes("ai-qwen"));
  assert.equal(ids.includes("ai"), false);
  assert.equal(payload.tools.find((tool) => tool.id === "merge")?.ok, true);
  assert.equal(payload.ai.slots.length, 3);
  const byId = Object.fromEntries(payload.ai.slots.map((slot) => [slot.id, slot]));
  assert.equal(byId.gemini.bound, true);
  assert.equal(byId.deepseek.bound, true);
  assert.equal(byId.qwen.hasKey, true);
  assert.equal(byId.qwen.bound, false);
  assert.equal(byId.qwen.enabled, false);
});
