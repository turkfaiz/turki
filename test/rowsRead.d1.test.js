import test from "node:test";
import assert from "node:assert/strict";
import worker, { ensureDb } from "../src/worker.js";
import { translatePending } from "../src/translate.js";
import { MAYORS } from "../src/mayors.js";
import { D1Sqlite } from "./helpers/d1sqlite.js";

/**
 * Guards the D1 read-cost fixes against regression, on a real SQLite database
 * that runs the worker's actual SQL, indexes, and query plans (D1 is SQLite).
 * These are the reads that let a single search burn through the daily quota.
 */

const DASH = { DASHBOARD_USER: "mayorwatch", DASHBOARD_PASSWORD: "secret" };
const AUTH = {
  Authorization: `Basic ${Buffer.from(`${DASH.DASHBOARD_USER}:${DASH.DASHBOARD_PASSWORD}`).toString("base64")}`,
};

function makeEnv() {
  return {
    DB: new D1Sqlite(),
    GEMINI_API_KEY: "secret",
    GEMINI_MODEL: "gemini-test",
    AI_DAILY_LIMIT: "400",
    AI_MIN_INTERVAL_MS: "0",
    ...DASH,
    SCAN_QUEUE: { async send() {}, async sendBatch() {} },
    ASSETS: { fetch: async () => new Response("ok") },
  };
}

function seedItems(env, count) {
  const db = env.DB.db;
  db.exec("BEGIN");
  const stmt = db.prepare(
    `INSERT INTO items (
       id, mayor_id, source, title, title_normalized, url, published_at, snippet,
       language, confidence, status, fingerprint, publisher_domain, publisher_tier,
       article_text, source_documents, merged_sources, source_count,
       title_ar, snippet_ar, trans_engine, brief_attempts
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < count; i += 1) {
    const mayor = MAYORS[i % MAYORS.length];
    stmt.run(
      `item-${i}`,
      mayor.id,
      "approved_feed",
      `News ${i} about ${mayor.name_en}`,
      `news ${i}`,
      `https://example.com/${mayor.id}/${i}`,
      new Date(Date.now() - (i % 5) * 86400000).toISOString(),
      "snippet",
      mayor.native_lang,
      "raw",
      "inbox",
      `fp-${i}`,
      mayor.official_host,
      1,
      "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma. ".repeat(4),
      "[]",
      "[]",
      1,
      "بانتظار قراءة الذكاء الاصطناعي",
      "",
      "brief-pending",
      0,
    );
  }
  db.exec("COMMIT");
}

function stubGeminiFetch() {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    async json() {
      return {
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  headline_ar: "عنوان",
                  headline_evidence: "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma.",
                  facts: [{ fact_ar: "حقيقة", evidence: "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma." }],
                  topic_ar: "افتتاح",
                }),
              },
            ],
          },
        ],
      };
    },
  });
}

async function boot(env) {
  await worker.fetch(new Request("https://d/api/health"), env);
}

test("bootstrap creates the brief-claim index on a real SQLite database", async () => {
  const env = makeEnv();
  await boot(env);
  const idx = await env.DB
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_items_claim'`)
    .first();
  assert.equal(idx?.name, "idx_items_claim", "idx_items_claim must exist after bootstrap");
});

test("the brief-claim readback searches by index instead of scanning items", async () => {
  const env = makeEnv();
  await boot(env);
  seedItems(env, 800);
  stubGeminiFetch();

  const log = env.DB.startRecording();
  await translatePending(env, 3, "seoul");
  env.DB.stopRecording();

  const readback = log.find((entry) => /WHERE items\.brief_claim_id = \?/.test(entry.sql));
  assert.ok(readback, "the claim readback statement should have run");
  const plan = env.DB.db
    .prepare(`EXPLAIN QUERY PLAN ${readback.sql}`)
    .all()
    .map((row) => row.detail)
    .join(" | ");
  assert.match(plan, /idx_items_claim/, `expected an index search, got plan: ${plan}`);
  assert.doesNotMatch(plan, /SCAN items\b/, `claim readback must not full-scan items: ${plan}`);
});

test("a health check reads but never deletes existing desk data", async () => {
  const env = makeEnv();
  await boot(env);
  seedItems(env, 200);
  // Also seed the other tables the old reset path used to wipe.
  env.DB.exec(
    `INSERT INTO scans (id, type, started_at) VALUES ('scan-1', 'weekly', datetime('now'));
     INSERT INTO search_jobs (id, status) VALUES ('job-1', 'completed');
     INSERT INTO search_job_tasks (job_id, mayor_id, status) VALUES ('job-1', 'seoul', 'completed');`,
  );
  const before = env.DB._tableRowCount("items");

  await worker.fetch(new Request("https://d/api/health"), env);
  // A fresh isolate (new bootstrapped set) re-running ensureDb must not wipe data.
  await ensureDb({ ...env });

  assert.equal(env.DB._tableRowCount("items"), before, "items must be preserved");
  assert.equal(env.DB._tableRowCount("scans"), 1, "scans must be preserved");
  assert.equal(env.DB._tableRowCount("search_jobs"), 1, "search_jobs must be preserved");
  assert.equal(env.DB._tableRowCount("search_job_tasks"), 1, "search_job_tasks must be preserved");
});

test("GET /api/stats no longer runs redundant full-table scans of items", async () => {
  const env = makeEnv();
  await boot(env);
  seedItems(env, 500);

  const log = env.DB.startRecording();
  const res = await worker.fetch(new Request("https://d/api/stats", { headers: AUTH }), env);
  env.DB.stopRecording();
  assert.equal(res.status, 200);

  const report = env.DB.analyze(log);
  // Previously stats issued ~5 full item scans (row + byMayor + weekDup + weekFound + pending).
  // The derived-total and combined-window changes bring hot full scans to at most 3.
  assert.ok(
    report.fullItemScans <= 3,
    `stats should issue at most 3 full item scans, saw ${report.fullItemScans}`,
  );
});
