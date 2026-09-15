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
  const geminiChip = payload.tools.find((tool) => tool.id === "ai-gemini");
  assert.equal(geminiChip.name, "جيميني");
  assert.match(geminiChip.detail, /gemini-test/);
  assert.doesNotMatch(geminiChip.name, /الذكاء الاصطناعي —/);
});
