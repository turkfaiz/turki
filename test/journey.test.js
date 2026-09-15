import test from "node:test";
import assert from "node:assert/strict";
import { completeMayorDesk, ensureDb } from "../src/worker.js";
import { noteAiFailure } from "../src/aiBudget.js";
import { assessMayorJourney } from "../src/journey.js";
import { createTestD1 } from "./helpers/d1.js";
import { snapshotProtected } from "./helpers/populatedDesk.js";

const ARTICLE =
  "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma. La festa è prevista sabato 12 settembre.";

function envWith(db, overrides = {}) {
  return {
    DB: db,
    GEMINI_API_KEY: "gem",
    GEMINI_MODEL: "gemini-test",
    DEEPSEEK_API_KEY: "deep",
    DEEPSEEK_MODEL: "deepseek-flash",
    QWEN_API_KEY: "qwen",
    QWEN_ENABLED: "0",
    AI_DAILY_LIMIT: "1000",
    AI_MIN_INTERVAL_MS: "0",
    DEEPSEEK_DAILY_LIMIT: "2000",
    DEEPSEEK_MIN_INTERVAL_MS: "0",
    ...overrides,
  };
}

function seedJob(db) {
  db.exec(`
    INSERT INTO scans (id, type, query, mayor_id, started_at, found_count)
    VALUES ('scan-j', 'manual', '', 'turin', datetime('now'), 1);
    INSERT INTO search_jobs (id, query, mayor_id, status)
    VALUES ('job-j', '', 'turin', 'running');
    INSERT INTO search_job_tasks (job_id, mayor_id, status, stage, detail, result_json)
    VALUES ('job-j', 'turin', 'running', 'article_fetch', 'يفتح المقالات', '{"scanId":"scan-j"}');
  `);
}

function insertItem(
  db,
  {
    id,
    scanId = "scan-j",
    engine = "brief-pending",
    versionId = null,
    status = "inbox",
    title = "Lo Russo inaugura via Roma",
  },
) {
  const normalized = title.toLowerCase();
  db.exec(`
    INSERT INTO items (
      id, mayor_id, scan_id, source, title, title_normalized, url, published_at, snippet,
      title_ar, snippet_ar, language, confidence, status, fingerprint, trans_engine,
      publisher_domain, publisher_tier, article_text, source_count, brief_attempts,
      current_version_id
    ) VALUES (
      '${id}', 'turin', '${scanId}', 'approved_feed',
      '${title}', '${normalized}',
      'https://www.comune.torino.it/${id}', datetime('now','-1 days'), 'snippet',
      'بانتظار قراءة الذكاء الاصطناعي — ستيفانو لو روسو', '', 'it', 'raw', '${status}',
      'fp-${id}', '${engine}', 'comune.torino.it', 0,
      '${ARTICLE}', 1, ${engine.startsWith("brief-ai-") ? 1 : 0},
      ${versionId ? `'${versionId}'` : "NULL"}
    );
  `);
}

function insertVersion(db, { id, itemId, state }) {
  db.exec(`
    INSERT INTO brief_versions (
      id, item_id, source_hash, engine, title_ar, snippet_ar, evidence,
      verify_state, verify_attempts
    ) VALUES (
      '${id}', '${itemId}', 'hash-${id}', 'brief-ai-gemini-v2:gemini-test',
      'ستيفانو لو روسو يفتتح شارع فيا روما', 'موعد الاحتفال السبت.', '[]',
      '${state}', ${state === "pending" ? 0 : 1}
    );
  `);
}

async function desk() {
  const db = createTestD1();
  const env = envWith(db);
  await ensureDb(env);
  seedJob(db);
  return { db, env };
}

test("a search task is not completed while scan items are still reading", async () => {
  const { db, env } = await desk();
  insertItem(db, { id: "item-read" });
  const before = snapshotProtected(db);
  await completeMayorDesk(env, { mayorId: "turin", jobId: "job-j", scanId: "scan-j" });
  const task = db.one(`SELECT status, stage FROM search_job_tasks WHERE job_id = 'job-j'`);
  const job = db.one(`SELECT status FROM search_jobs WHERE id = 'job-j'`);
  assert.notEqual(task.status, "completed");
  assert.equal(task.stage, "ai_reading");
  assert.equal(job.status, "running");
  assert.deepEqual(snapshotProtected(db), before);
});

test("a search task is not completed while scan items are still verifying", async () => {
  const { db, env } = await desk();
  insertItem(db, {
    id: "item-ver",
    engine: "brief-ai-gemini-v2:gemini-test",
    versionId: "ver-j",
  });
  insertVersion(db, { id: "ver-j", itemId: "item-ver", state: "pending" });
  await completeMayorDesk(env, { mayorId: "turin", jobId: "job-j", scanId: "scan-j" });
  const task = db.one(`SELECT status, stage FROM search_job_tasks WHERE job_id = 'job-j'`);
  assert.notEqual(task.status, "completed");
  assert.equal(task.stage, "verifying");
});

test("a search task completes only when every scan item is settled", async () => {
  const { db, env } = await desk();
  insertItem(db, {
    id: "item-ready",
    engine: "brief-ai-gemini-v2:gemini-test",
    versionId: "ver-ready",
    title: "Lo Russo apre il parco",
  });
  insertVersion(db, { id: "ver-ready", itemId: "item-ready", state: "passed" });
  insertItem(db, { id: "item-old-reading", scanId: "scan-old", title: "Lo Russo in visita ai quartieri" });
  await completeMayorDesk(env, { mayorId: "turin", jobId: "job-j", scanId: "scan-j" });
  const task = db.one(`SELECT status, stage FROM search_job_tasks WHERE job_id = 'job-j'`);
  assert.equal(task.status, "completed");
  assert.equal(task.stage, "completed");
});

test("an excluded or attention-required scan item counts as settled", async () => {
  const { db, env } = await desk();
  insertItem(db, { id: "item-ex", status: "excluded", title: "Lo Russo exclude duplicate event" });
  insertItem(db, {
    id: "item-fail",
    engine: "brief-ai-gemini-v2:gemini-test",
    versionId: "ver-fail",
    title: "Lo Russo failed briefing",
  });
  insertVersion(db, { id: "ver-fail", itemId: "item-fail", state: "failed" });
  const assessment = await assessMayorJourney(env, { mayorId: "turin", scanId: "scan-j" });
  assert.equal(assessment.status, "completed");
});

test("when both bound models are down the job waits instead of completing", async () => {
  const { db, env } = await desk();
  insertItem(db, { id: "item-read" });
  await noteAiFailure(env, { status: 429, quotaScope: "day" }, "gemini");
  await noteAiFailure(env, { status: 429, quotaScope: "day" }, "deepseek");
  await completeMayorDesk(env, { mayorId: "turin", jobId: "job-j", scanId: "scan-j" });
  const task = db.one(`SELECT status, stage, detail FROM search_job_tasks WHERE job_id = 'job-j'`);
  const job = db.one(`SELECT status FROM search_jobs WHERE id = 'job-j'`);
  assert.notEqual(task.status, "completed");
  assert.ok(["waiting", "retrying"].includes(task.status));
  assert.ok(["waiting", "retrying"].includes(task.stage));
  assert.match(task.detail, /استئناف|توقفت/);
  assert.equal(job.status, "running");
});
