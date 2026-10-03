import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { ensureDb } from "../src/db/bootstrap.js";
import { createTestD1 } from "./helpers/d1.js";
import { recordHeartbeat, testTool, toolsOverview } from "../src/api/tools.js";

const request = (path, method = "GET") => new Request(`https://mayor-watch.test${path}`, { method });
const queue = { async send() {}, async sendBatch() {} };

async function envWith(overrides = {}) {
  const env = { DB: createTestD1(), GEMINI_MODEL: "g", SCAN_QUEUE: queue, ...overrides };
  await ensureDb(env);
  return env;
}
const byId = (view, id) => view.tools.find((tool) => tool.id === id);

test("tools report security, queue, scheduler, AI slots, sources and reader with a worst-state summary", async () => {
  const env = await envWith({ GEMINI_API_KEY: "k", DASHBOARD_PASSWORD: "p" });
  const view = await (await worker.fetch(
    new Request("https://mayor-watch.test/api/settings/tools", { headers: { Authorization: `Basic ${btoa("mayorwatch:p")}` } }),
    env,
  )).json();
  assert.equal(byId(view, "security").state, "ok");
  assert.equal(byId(view, "database").state, "ok");
  assert.equal(byId(view, "queue").state, "ok");
  assert.equal(byId(view, "scheduler").state, "idle");
  assert.equal(byId(view, "ai:gemini").state, "ok");
  assert.equal(byId(view, "ai:qwen").state, "idle");
  assert.ok(byId(view, "sources"));
  assert.ok(byId(view, "reader"));
  assert.ok(["ok", "warn", "bad"].includes(view.state));
});

test("missing protections surface as warnings and a missing queue as a failure", async () => {
  const env = await envWith({ SCAN_QUEUE: undefined });
  const view = await toolsOverview(env);
  assert.equal(byId(view, "security").state, "warn");
  assert.match(byId(view, "security").detail, /DASHBOARD_PASSWORD/);
  assert.equal(byId(view, "queue").state, "bad");
  assert.equal(view.state, "bad");
  assert.ok(view.needs_attention >= 2);
});

test("the scheduler is healthy only while its heartbeat is recent", async () => {
  const env = await envWith();
  await recordHeartbeat(env, "*/10 * * * *");
  assert.equal(byId(await toolsOverview(env), "scheduler").state, "ok");
  const later = Date.now() + 40 * 60 * 1000;
  assert.equal(byId(await toolsOverview(env, later), "scheduler").state, "warn");
  assert.equal(byId(await toolsOverview(env, Date.now() + 3 * 3600 * 1000), "scheduler").state, "bad");
});

test("a scheduled run writes the heartbeat the tools page reads", async () => {
  const env = await envWith();
  const pending = [];
  await worker.scheduled({ cron: "*/10 * * * *" }, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  const beat = JSON.parse(env.DB.one(`SELECT v FROM meta WHERE k = 'last_cron'`).v);
  assert.equal(beat.cron, "*/10 * * * *");
  assert.equal(byId(await toolsOverview(env), "scheduler").state, "ok");
});

test("live tests: database and queue answer; an unknown tool is a 404", async () => {
  const env = await envWith();
  assert.equal((await testTool(env, "database")).ok, true);
  assert.equal((await testTool(env, "queue")).ok, true);
  assert.equal((await testTool({ ...env, SCAN_QUEUE: undefined }, "queue")).ok, false);
  assert.equal((await worker.fetch(request("/api/settings/tools/nothing/test", "POST"), env)).status, 404);
  assert.equal((await worker.fetch(request("/api/settings/tools/database/test", "POST"), env)).status, 200);
});

test("the AI live test sends one real call with the slot's own key and reports the outcome", async () => {
  const env = await envWith({ GEMINI_API_KEY: "secret-key" });
  const seen = [];
  const ok = await testTool(env, "ai:gemini", {
    fetcher: async (url, init) => {
      seen.push({ url, key: init.headers["x-goog-api-key"] });
      return { ok: true, status: 200, async json() { return { steps: [{ type: "model_output", content: [{ type: "text", text: '{"pong": true}' }] }], outputs: [{ type: "text", text: '{"pong": true}' }], candidates: [{ content: { parts: [{ text: '{"pong": true}' }] } }] }; } };
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].key, "secret-key");
  assert.equal(ok.ok, true, JSON.stringify(ok));

  const rejected = await testTool(env, "ai:gemini", {
    fetcher: async () => ({ ok: false, status: 403, headers: { get: () => null }, async json() { return { error: { message: "API key not valid" } }; } }),
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.detail, /ai_http_403|ai_deferred/);
  assert.equal((await testTool(await envWith(), "ai:gemini")).ok, false);
});

test("a failed AI test never puts the model into cooldown, so it cannot disturb real searches", async () => {
  const env = await envWith({ GEMINI_API_KEY: "k" });
  const rejected = await testTool(env, "ai:gemini", {
    fetcher: async () => ({ ok: false, status: 403, headers: { get: () => null }, async json() { return { error: { message: "bad" } }; } }),
  });
  assert.equal(rejected.ok, false);
  const row = env.DB.one(`SELECT calls, blocked_until FROM ai_provider_budget WHERE provider = 'gemini'`);
  assert.equal(row.calls, 1, "the test still counts as one call from the daily quota");
  assert.equal(row.blocked_until, null, "no cooldown after a manual test");
  // وبعد الاختبار الفاشل يبقى النموذج متاحًا للرصد الحقيقي
  const view = await toolsOverview(env);
  assert.equal(byId(view, "ai:gemini").state, "ok");
});

test("the HTTP route accepts an AI tool id exactly as the browser sends it, encoded or raw", async () => {
  const env = await envWith({ GEMINI_API_KEY: "k", DASHBOARD_PASSWORD: "p" });
  const post = (path) => worker.fetch(new Request(`https://mayor-watch.test${path}`, { method: "POST", headers: { Authorization: `Basic ${btoa("mayorwatch:p")}` } }), env);
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { outputs: [{ type: "text", text: '{"pong": true}' }], candidates: [{ content: { parts: [{ text: '{"pong": true}' }] } }] };
    },
  });
  try {
    for (const id of ["ai%3Agemini", "ai:gemini"]) {
      const res = await post(`/api/settings/tools/${id}/test`);
      assert.equal(res.status, 200, id);
      const body = await res.json();
      assert.notEqual(body.error, "not_found", id);
      assert.equal(typeof body.ok, "boolean", id);
    }
    const unknown = await post("/api/settings/tools/ai%3Anothing/test");
    assert.equal(unknown.status, 200);
    assert.equal((await unknown.json()).ok, false);
  } finally {
    globalThis.fetch = real;
  }
});
