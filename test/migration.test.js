import test from "node:test";
import assert from "node:assert/strict";
import { ensureDb } from "../src/worker.js";
import { createTestD1 } from "./helpers/d1.js";
import { seedPopulatedDesk, snapshotProtected } from "./helpers/populatedDesk.js";

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

test("a stamped database missing a new table is repaired instead of failing", async () => {
  const db = createTestD1();
  await ensureDb(envWith(db));
  // مخطط جديد أُضيف دون رفع الختم: الحالة التي تنكسر في الإنتاج وحدها.
  db.exec(`DROP TABLE brief_versions; DROP TABLE approvals;`);
  await ensureDb(envWith(db.reopen()));
  const tables = new Set(
    db.query(`SELECT name FROM sqlite_master WHERE type = 'table'`).map((r) => r.name),
  );
  assert.ok(tables.has("brief_versions"), "the missing table is recreated");
  assert.ok(tables.has("approvals"));
});

test("an upgrade over a full legacy desk keeps decisions, versions, evidence, sources, and custom mayors", async () => {
  const db = createTestD1();
  await ensureDb(envWith(db));
  seedPopulatedDesk(db);
  const before = snapshotProtected(db);
  assert.equal(before.approvals, 1);
  assert.equal(before.passed_versions, 3);
  assert.equal(before.approved_versions, 1);
  assert.ok(before.evidence_versions >= 5);
  assert.equal(before.custom_mayors, 1);
  assert.equal(before.custom_sources, 1);
  assert.equal(before.ai_calls, 42);

  db.exec(`UPDATE meta SET v = 'bootstrap-v1' WHERE k = 'bootstrap_version'`);
  await ensureDb(envWith(db.reopen()));

  const after = snapshotProtected(db);
  assert.deepEqual(after, before, "bootstrap must not drop protected production rows");
  assert.equal(db.one(`SELECT title_ar FROM approvals WHERE id = 'appr-1'`).title_ar, "ستيفانو لو روسو يعتمد مشروعًا");
  assert.equal(
    db.one(`SELECT evidence FROM brief_versions WHERE id = 'ver-approved'`).evidence.includes("La festa"),
    true,
  );
  assert.ok(db.one(`SELECT id FROM items WHERE id = 'item-approved'`), "a decided article is never deleted");
  assert.ok(db.one(`SELECT id FROM items WHERE id = 'item-stale-ready'`), "old verified news is moved, not deleted");
  assert.equal(db.one(`SELECT name_ar FROM mayors WHERE id = 'riyadh-noura'`).name_ar, "نورة العبدالله");
  assert.equal(
    db.one(`SELECT domain FROM sources WHERE id = 'riyadh-noura:alriyadh.gov.sa'`).domain,
    "alriyadh.gov.sa",
  );
  assert.equal(db.one(`SELECT desk_lane FROM items WHERE id = 'item-ready'`).desk_lane, "decision_ready");
  assert.equal(db.one(`SELECT desk_lane FROM items WHERE id = 'item-reading'`).desk_lane, "reading");
});

test("desk_lane columns are added to a pre-lane items table without wiping it", async () => {
  const db = createTestD1();
  db.exec(`
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE mayors (
      id TEXT PRIMARY KEY, country_ar TEXT NOT NULL, city_ar TEXT NOT NULL, city_en TEXT NOT NULL,
      title_ar TEXT NOT NULL, title_en TEXT NOT NULL, name_en TEXT NOT NULL, name_native TEXT NOT NULL,
      name_ar TEXT NOT NULL, native_lang TEXT NOT NULL, native_lang_ar TEXT NOT NULL,
      country_code TEXT NOT NULL, gn_hl TEXT NOT NULL, gn_gl TEXT NOT NULL, official_host TEXT
    );
    INSERT INTO mayors VALUES (
      'turin', 'إيطاليا', 'تورينو', 'Turin', 'عمدة تورينو', 'Mayor of Turin',
      'Stefano Lo Russo', 'Stefano Lo Russo', 'ستيفانو لو روسو', 'it', 'الإيطالية',
      'IT', 'it', 'IT', 'comune.torino.it'
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY, mayor_id TEXT NOT NULL, scan_id TEXT, source TEXT NOT NULL,
      title TEXT NOT NULL, title_normalized TEXT NOT NULL, url TEXT NOT NULL, published_at TEXT,
      snippet TEXT, title_ar TEXT, snippet_ar TEXT, language TEXT, confidence TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'inbox', exclude_reason TEXT, fingerprint TEXT NOT NULL,
      trans_engine TEXT, publisher_domain TEXT, publisher_tier INTEGER,
      article_text TEXT, brief_provider TEXT, created_at TEXT
    );
    INSERT INTO items (
      id, mayor_id, source, title, title_normalized, url, published_at, snippet,
      title_ar, snippet_ar, language, confidence, status, fingerprint, trans_engine,
      publisher_domain, publisher_tier, created_at
    ) VALUES (
      'keep-decided', 'turin', 'approved_feed', 'Lo Russo', 'lo russo',
      'https://www.comune.torino.it/old', datetime('now','-2 days'), 'snippet',
      'عنوان معتمد', 'حقيقة معتمدة.', 'it', 'raw', 'approved', 'fp-old-decided',
      'brief-ai-gemini-v2:gemini-test', 'comune.torino.it', 0, datetime('now')
    );
    CREATE TABLE brief_versions (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL, source_hash TEXT NOT NULL, engine TEXT NOT NULL,
      title_ar TEXT NOT NULL, snippet_ar TEXT NOT NULL, evidence TEXT NOT NULL,
      sent_excerpts TEXT, sent_source_ids TEXT,
      verify_state TEXT NOT NULL DEFAULT 'pending', verify_detail TEXT,
      verify_attempts INTEGER NOT NULL DEFAULT 0, verify_after TEXT, superseded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO brief_versions (
      id, item_id, source_hash, engine, title_ar, snippet_ar, evidence, verify_state, verify_attempts
    ) VALUES (
      'ver-old', 'keep-decided', 'hash-old', 'brief-ai-gemini-v2:gemini-test',
      'عنوان معتمد', 'حقيقة معتمدة.', '{"quote":"Via Roma"}', 'passed', 1
    );
    CREATE TABLE approvals (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL, version_id TEXT NOT NULL, decision TEXT NOT NULL,
      reviewer TEXT NOT NULL, reviewer_known INTEGER NOT NULL DEFAULT 1, decided_at TEXT NOT NULL,
      source_hash TEXT NOT NULL, title_ar TEXT NOT NULL, snippet_ar TEXT NOT NULL, evidence TEXT
    );
    INSERT INTO approvals (
      id, item_id, version_id, decision, reviewer, reviewer_known, decided_at,
      source_hash, title_ar, snippet_ar, evidence
    ) VALUES (
      'appr-old', 'keep-decided', 'ver-old', 'approved', 'mayorwatch', 1, datetime('now'),
      'hash-old', 'عنوان معتمد', 'حقيقة معتمدة.', '{"quote":"Via Roma"}'
    );
  `);

  await ensureDb(envWith(db));
  const columns = new Set(db.query(`PRAGMA table_info(items)`).map((c) => c.name));
  assert.ok(columns.has("desk_lane"));
  assert.ok(columns.has("desk_attention_reason"));
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM items`).n, 1);
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM approvals`).n, 1);
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM brief_versions`).n, 1);
  assert.equal(db.one(`SELECT title_ar FROM approvals WHERE id = 'appr-old'`).title_ar, "عنوان معتمد");
  assert.match(db.one(`SELECT evidence FROM brief_versions WHERE id = 'ver-old'`).evidence, /Via Roma/);
});

test("verify claim columns are added to existing brief_versions without deleting rows", async () => {
  const db = createTestD1();
  await ensureDb(envWith(db));
  seedPopulatedDesk(db);
  const before = snapshotProtected(db);
  db.exec(`UPDATE meta SET v = 'bootstrap-v18' WHERE k = 'bootstrap_version'`);
  await ensureDb(envWith(db.reopen()));
  const columns = new Set(db.query(`PRAGMA table_info(brief_versions)`).map((c) => c.name));
  assert.ok(columns.has("verify_claim_id"));
  assert.ok(columns.has("verify_claimed_at"));
  assert.deepEqual(snapshotProtected(db), before);
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM brief_versions WHERE id = 'ver-passed'`).n, 1);
});

test("reopening a populated desk keeps lease columns and protected rows", async () => {
  const db = createTestD1();
  await ensureDb(envWith(db));
  seedPopulatedDesk(db);
  const before = snapshotProtected(db);
  db.exec(`UPDATE meta SET v = 'bootstrap-v19' WHERE k = 'bootstrap_version'`);
  await ensureDb(envWith(db.reopen()));
  const scanCols = new Set(db.query(`PRAGMA table_info(scan_sources)`).map((c) => c.name));
  const candCols = new Set(db.query(`PRAGMA table_info(candidates)`).map((c) => c.name));
  assert.ok(scanCols.has("claim_id"));
  assert.ok(scanCols.has("next_attempt_at"));
  assert.ok(candCols.has("fetch_claim_id"));
  assert.ok(candCols.has("fetch_after"));
  assert.deepEqual(snapshotProtected(db), before);
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM candidates WHERE id = 'cand-1'`).n, 1);
});
