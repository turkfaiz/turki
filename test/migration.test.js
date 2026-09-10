import test from "node:test";
import assert from "node:assert/strict";
import { ensureDb } from "../src/worker.js";
import { createTestD1 } from "./helpers/d1.js";

function envWith(db, overrides = {}) {
  return {
    DB: db,
    GEMINI_MODEL: "gemini-test",
    AI_MIN_INTERVAL_MS: "0",
    AI_DAILY_LIMIT: "1000",
    ...overrides,
  };
}

function seedWorkingData(db) {
  db.exec(`
    INSERT INTO items (
      id, mayor_id, source, title, title_normalized, url, published_at, snippet,
      title_ar, snippet_ar, language, confidence, status, fingerprint, trans_engine,
      publisher_domain, publisher_tier, article_text, source_count, brief_attempts
    ) VALUES
    ('keep-approved', 'turin', 'approved_feed',
      'Lo Russo apre via Roma', 'lo russo apre via roma',
      'https://www.comune.torino.it/a', datetime('now','-2 days'), 'snippet',
      'ستيفانو لو روسو يفتتح شارع فيا روما', 'حقيقة معتمدة.', 'it', 'raw', 'approved',
      'fp-approved', 'brief-ai-gemini-v2:gemini-test', 'comune.torino.it', 0,
      'Stefano Lo Russo apre via Roma.', 1, 1),
    ('keep-inbox', 'seoul', 'approved_feed',
      'Oh Se-hoon opens a park', 'oh se-hoon opens a park',
      'https://www.yna.co.kr/b', datetime('now','-1 days'), 'snippet',
      'بانتظار قراءة الذكاء الاصطناعي — أوه سيه هون', '', 'ko', 'raw', 'inbox',
      'fp-inbox', 'brief-pending', 'yna.co.kr', 1, 'Oh Se-hoon opened a park.', 1, 0);

    INSERT INTO scans (id, type, query, mayor_id, started_at, found_count)
    VALUES ('scan-1', 'manual', '', 'turin', datetime('now','-1 days'), 2);

    INSERT INTO search_jobs (id, query, mayor_id, status)
    VALUES ('job-1', '', 'turin', 'completed');

    INSERT INTO search_job_tasks (job_id, mayor_id, status, stage, detail)
    VALUES ('job-1', 'turin', 'completed', 'completed', 'اكتمل');
  `);
}

test("an upgrade over a populated database never deletes working data", async () => {
  const db = createTestD1();
  await ensureDb(envWith(db));
  seedWorkingData(db);

  const before = {
    items: db.one(`SELECT COUNT(*) AS n FROM items`).n,
    scans: db.one(`SELECT COUNT(*) AS n FROM scans`).n,
    jobs: db.one(`SELECT COUNT(*) AS n FROM search_jobs`).n,
    tasks: db.one(`SELECT COUNT(*) AS n FROM search_job_tasks`).n,
  };
  assert.deepEqual(before, { items: 2, scans: 1, jobs: 1, tasks: 1 });

  // Replay an upgrade: an older stamp plus a fresh handle so bootstrap re-runs.
  db.exec(`UPDATE meta SET v = 'bootstrap-v1' WHERE k = 'bootstrap_version'`);
  db.exec(`DELETE FROM meta WHERE k IN ('brief_epoch','repair_epoch','attribution_epoch')`);
  await ensureDb(envWith(db.reopen()));

  assert.deepEqual(
    {
      items: db.one(`SELECT COUNT(*) AS n FROM items`).n,
      scans: db.one(`SELECT COUNT(*) AS n FROM scans`).n,
      jobs: db.one(`SELECT COUNT(*) AS n FROM search_jobs`).n,
      tasks: db.one(`SELECT COUNT(*) AS n FROM search_job_tasks`).n,
    },
    before,
    "no table may be emptied by an upgrade",
  );
});

test("a completed brief keeps its text through an upgrade", async () => {
  const db = createTestD1();
  await ensureDb(envWith(db));
  seedWorkingData(db);

  db.exec(`UPDATE meta SET v = 'bootstrap-v1' WHERE k = 'bootstrap_version'`);
  db.exec(`DELETE FROM meta WHERE k IN ('brief_epoch','repair_epoch','attribution_epoch')`);
  await ensureDb(envWith(db.reopen()));

  const row = db.one(`SELECT title_ar, snippet_ar, trans_engine FROM items WHERE id = 'keep-approved'`);
  assert.equal(row.title_ar, "ستيفانو لو روسو يفتتح شارع فيا روما");
  assert.equal(row.snippet_ar, "حقيقة معتمدة.");
  assert.equal(row.trans_engine, "brief-ai-gemini-v2:gemini-test");
});

test("bootstrap creates the registry and its health columns on a fresh database", async () => {
  const db = createTestD1();
  await ensureDb(envWith(db));
  const columns = new Set(db.query(`PRAGMA table_info(sources)`).map((c) => c.name));
  for (const column of ["verified", "curated_at", "last_ok_at", "consecutive_failures"]) {
    assert.ok(columns.has(column), `sources.${column} missing`);
  }
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM sources`).n, 36);
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM mayors`).n, 12);
});

test("registry columns are added to a table that already exists without them", async () => {
  const db = createTestD1();
  // The shape shipped before curation data existed.
  db.exec(`
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE sources (
      id TEXT PRIMARY KEY, mayor_id TEXT NOT NULL, domain TEXT NOT NULL,
      name TEXT NOT NULL, tier INTEGER NOT NULL, kind TEXT NOT NULL,
      url TEXT NOT NULL, rank INTEGER NOT NULL
    );
    INSERT INTO sources VALUES ('turin:comune.torino.it','turin','comune.torino.it','x',0,'feed','https://x',1);
  `);
  await ensureDb(envWith(db));
  const columns = new Set(db.query(`PRAGMA table_info(sources)`).map((c) => c.name));
  assert.ok(columns.has("verified"));
  assert.ok(columns.has("curated_at"));
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM sources`).n, 36);
});
