import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { ensureDb } from "../src/db/bootstrap.js";
import { createTestD1 } from "./helpers/d1.js";

const request = (path) => new Request(`https://mayor-watch.test${path}`);

async function seededJob() {
  const env = { DB: createTestD1(), GEMINI_MODEL: "t" };
  await ensureDb(env);
  const db = env.DB;
  db.exec(`
    INSERT INTO search_jobs (id, query, mayor_id, status, created_at) VALUES ('aaaa0001', '', NULL, 'running', datetime('now', '-5 minutes'));
    INSERT INTO search_job_tasks (job_id, mayor_id, status, stage, detail, started_at, result_json) VALUES
      ('aaaa0001', 'turin', 'running', 'ai_reading', 'يقرأ النماذج', datetime('now', '-4 minutes'),
       '{"scanId":"scan-turin","journey":{"stage":"ai_reading","total":3,"settled":1,"reading":1,"verifying":1},"errors":["turin:comune.torino.it: http_403"]}'),
      ('aaaa0001', 'seoul', 'queued', 'queued', NULL, NULL, NULL);
    INSERT INTO scan_sources (scan_id, source_id, mayor_id, job_id, status, detail) VALUES
      ('scan-turin', 'turin:comune.torino.it', 'turin', 'aaaa0001', 'failed', 'http_403'),
      ('scan-turin', 'turin:torinoclick.it', 'turin', 'aaaa0001', 'polled', 'ok'),
      ('scan-seoul', 'seoul:seoul.go.kr', 'seoul', 'aaaa0001', 'queued', NULL);
    INSERT INTO candidates (id, mayor_id, source_id, scan_id, url, title, published_at, discovered_at, discovery_type, stage, fetch_status, skip_reason, attempts) VALUES
      ('c1','turin','turin:torinoclick.it','scan-turin','https://www.torinoclick.it/1','a',datetime('now'),datetime('now'),'rss','candidate_discovered','pending',NULL,0),
      ('c2','turin','turin:torinoclick.it','scan-turin','https://www.torinoclick.it/2','b',datetime('now'),datetime('now'),'rss','candidate_discovered','pending',NULL,0),
      ('c3','turin','turin:torinoclick.it','scan-turin','https://www.torinoclick.it/3','c',datetime('now'),datetime('now'),'rss','ai_brief','fetched',NULL,1),
      ('c4','turin','turin:torinoclick.it','scan-turin','https://www.torinoclick.it/4','d',datetime('now'),datetime('now'),'rss','deduplication','fetched','duplicate',1),
      ('c5','turin','turin:torinoclick.it','scan-turin','https://www.torinoclick.it/5','e',datetime('now'),datetime('now'),'rss','relevance_check','skipped','unrelated',1),
      ('c6','turin','turin:torinoclick.it','scan-turin','https://www.torinoclick.it/6','f',datetime('now'),datetime('now'),'rss','relevance_check','skipped','unrelated',1),
      ('c7','turin','turin:torinoclick.it','scan-turin','https://www.torinoclick.it/7','g',datetime('now'),datetime('now'),'rss','article_fetch','failed','unverified',1);
    INSERT INTO items (id, mayor_id, scan_id, source, title, title_normalized, url, confidence, status, fingerprint) VALUES
      ('i1','turin','scan-turin','approved_rss','t1','t1','https://www.torinoclick.it/3','raw','inbox','fp-1'),
      ('i2','turin','scan-turin','approved_rss','t2','t2','https://www.torinoclick.it/x','raw','excluded','fp-2'),
      ('i3','turin','scan-turin','approved_rss','t3','t3','https://www.torinoclick.it/y','raw','approved','fp-3');
  `);
  return env;
}

test("the latest job snapshot carries per-office journey digests without the heavy parts", async () => {
  const env = await seededJob();
  const { job } = await (await worker.fetch(request("/api/search-jobs/latest"), env)).json();
  assert.equal(job.id, "aaaa0001");
  assert.equal(job.status, "running");
  assert.ok(job.created_at);
  assert.equal(job.sources, undefined);
  assert.equal(job.funnel, undefined);
  const turin = job.tasks.find((task) => task.mayor_id === "turin");
  assert.equal(turin.scan_id, "scan-turin");
  assert.equal(turin.journey.reading, 1);
  assert.equal(turin.journey.settled, 1);
  assert.deepEqual(turin.source_errors, ["turin:comune.torino.it: http_403"]);
});

test("detail=1 adds each source with its live status and the funnel counts", async () => {
  const env = await seededJob();
  const { job } = await (await worker.fetch(request("/api/search-jobs/aaaa0001?detail=1"), env)).json();
  const states = Object.fromEntries(job.sources.map((row) => [row.source_id, row.status]));
  assert.deepEqual(states, {
    "turin:comune.torino.it": "failed",
    "turin:torinoclick.it": "polled",
    "seoul:seoul.go.kr": "queued",
  });
  assert.equal(job.sources.find((row) => row.source_id === "turin:torinoclick.it").domain, "torinoclick.it");

  const c = job.funnel.candidates;
  assert.equal(c.total, 7);
  assert.equal(c.waiting, 2);
  assert.equal(c.read, 4);
  assert.equal(c.failed, 1);
  assert.equal(c.duplicates, 1);
  assert.deepEqual(c.dropped, { unrelated: 2 });

  const items = job.funnel.items;
  assert.equal(items.total, 3);
  assert.equal(items.excluded, 1);
  assert.equal(items.approved, 1);
  assert.equal(items.reading, 1);
});

test("the recent jobs list is light, newest first and capped", async () => {
  const env = await seededJob();
  env.DB.exec(`INSERT INTO search_jobs (id, query, mayor_id, status, created_at) VALUES ('aaaa0000', 'مياه', 'turin', 'completed', datetime('now', '-2 days'))`);
  const { jobs } = await (await worker.fetch(request("/api/search-jobs?limit=5"), env)).json();
  assert.deepEqual(jobs.map((job) => job.id), ["aaaa0001", "aaaa0000"]);
  assert.equal(jobs[0].offices, 2);
  assert.equal(jobs[0].tasks, undefined);
  assert.equal(jobs[1].query, "مياه");
  const capped = await (await worker.fetch(request("/api/search-jobs?limit=1"), env)).json();
  assert.equal(capped.jobs.length, 1);
});

test("an unknown job and an empty history answer cleanly", async () => {
  const env = { DB: createTestD1(), GEMINI_MODEL: "t" };
  await ensureDb(env);
  assert.deepEqual(await (await worker.fetch(request("/api/search-jobs/latest"), env)).json(), { job: null });
  assert.equal((await worker.fetch(request("/api/search-jobs/deadbeef"), env)).status, 404);
  assert.deepEqual((await (await worker.fetch(request("/api/search-jobs"), env)).json()).jobs, []);
});

test("the weekly run is recorded as a visible job with one task per office", async () => {
  const sent = [];
  const env = {
    DB: createTestD1(),
    GEMINI_MODEL: "t",
    SCAN_QUEUE: { async send(m) { sent.push(m); }, async sendBatch(batch) { sent.push(...batch); } },
  };
  await ensureDb(env);
  const pending = [];
  await worker.scheduled({ cron: "0 3 * * SUN" }, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
  const job = env.DB.one(`SELECT id, kind, mayor_id FROM search_jobs`);
  assert.equal(job.kind, "weekly");
  assert.equal(job.mayor_id, null);
  const tasks = env.DB.one(`SELECT COUNT(*) AS n FROM search_job_tasks WHERE job_id = ?`, job.id).n;
  assert.ok(tasks >= 12);
  assert.ok(sent.every((m) => (m.body || m).jobId === job.id || (m.body || m).type === "brief"));
  const { job: view } = await (await worker.fetch(request("/api/search-jobs/latest"), env)).json();
  assert.equal(view.kind, "weekly");
});
