import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { ensureDb } from "../src/db/bootstrap.js";
import { clearPreview } from "../src/db/items.js";
import { persistDiscovered } from "../src/pipeline.js";
import { MAYORS } from "../src/mayors.js";
import { sourcesFor } from "../src/sources.js";
import { createTestD1 } from "./helpers/d1.js";

const URL_OLD = "https://www.comune.torino.it/news/2026/10/01/old-story";

async function desk() {
  const env = { DB: createTestD1(), GEMINI_MODEL: "t" };
  await ensureDb(env);
  env.DB.exec(`
    INSERT INTO items (id, mayor_id, scan_id, source, title, title_normalized, url, confidence, status, fingerprint, current_version_id) VALUES
      ('u1','turin','scan-1','approved_rss','undecided','undecided','${URL_OLD}','raw','inbox','fp-u1','v-u1'),
      ('u2','turin','scan-1','approved_rss','auto excluded','auto excluded','https://x.example/2','raw','excluded','fp-u2',NULL),
      ('a1','turin','scan-0','approved_rss','approved','approved','https://x.example/3','raw','approved','fp-a1','v-a1'),
      ('d1','turin','scan-0','approved_rss','decided but inbox','decided but inbox','https://x.example/4','raw','inbox','fp-d1','v-d1');
    INSERT INTO brief_versions (id, item_id, source_hash, engine, title_ar, snippet_ar, evidence, verify_state) VALUES
      ('v-u1','u1','h','e','ع','ح','{}','pending'),
      ('v-a1','a1','h','e','ع','ح','{}','passed'),
      ('v-d1','d1','h','e','ع','ح','{}','passed');
    INSERT INTO approvals (id, item_id, version_id, decision, reviewer, decided_at, source_hash, title_ar, snippet_ar) VALUES
      ('ap1','a1','v-a1','approved','mayorwatch',datetime('now'),'h','ع','ح'),
      ('ap2','d1','v-d1','excluded','mayorwatch',datetime('now'),'h','ع','ح');
    INSERT INTO candidates (id, mayor_id, source_id, scan_id, url, title, published_at, discovered_at, discovery_type, stage, fetch_status, attempts) VALUES
      ('c1','turin','turin:comune.torino.it','scan-1','${URL_OLD}','old',datetime('now'),datetime('now'),'rss','ai_brief','fetched',1),
      ('c2','turin','turin:comune.torino.it','scan-1','https://x.example/5','p',datetime('now'),datetime('now'),'rss','candidate_discovered','pending',0);
    INSERT INTO scans (id, type, started_at) VALUES ('scan-1','manual',datetime('now'));
    INSERT INTO search_jobs (id, status) VALUES ('aaaa0001','completed');
    INSERT INTO search_job_tasks (job_id, mayor_id, status) VALUES ('aaaa0001','turin','completed');
    INSERT INTO scan_sources (scan_id, source_id, mayor_id, job_id, status) VALUES ('scan-1','turin:comune.torino.it','turin','aaaa0001','polled');
    INSERT INTO ai_provider_budget (day, provider, calls) VALUES (date('now'), 'gemini', 37);
  `);
  return env;
}

const post = (env, body) =>
  worker.fetch(
    new Request("https://mayor-watch.test/api/admin/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    env,
  );
const count = (env, table) => env.DB.one(`SELECT COUNT(*) AS n FROM ${table}`).n;

test("the preview says what would go and what would stay, without deleting anything", async () => {
  const env = await desk();
  assert.deepEqual(await clearPreview(env), { removable_items: 2, kept_items: 2, candidates: 2 });
  assert.equal(count(env, "items"), 4);
});

test("without the exact confirmation phrase nothing is deleted", async () => {
  const env = await desk();
  for (const confirm of [undefined, "", "yes", "احذف الأخبار"]) {
    const res = await post(env, { confirm });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "confirmation_required");
  }
  assert.equal(count(env, "items"), 4);
  assert.equal(count(env, "candidates"), 2);
});

test("clearing removes undecided news and the search trail, and keeps every decision", async () => {
  const env = await desk();
  const res = await post(env, { confirm: "احذف كل الأخبار" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.removedItems, 2);
  assert.equal(body.removedCandidates, 2);
  assert.equal(body.keptDecided, 2);

  // بقي المعتمد وما فيه قرار فقط
  assert.deepEqual(
    (await env.DB.prepare(`SELECT id FROM items ORDER BY id`).all()).results.map((row) => row.id),
    ["a1", "d1"],
  );
  assert.equal(count(env, "approvals"), 2);
  // أثر الرصد مُسح
  for (const table of ["candidates", "scans", "search_jobs", "search_job_tasks", "scan_sources"]) {
    assert.equal(count(env, table), 0, table);
  }
  // نسخة الخبر المحذوف عُلّمت متقادمة فلا تُدقَّق، ونسخ المقرَّر لم تُمس
  assert.ok(env.DB.one(`SELECT superseded_at FROM brief_versions WHERE id = 'v-u1'`).superseded_at);
  assert.equal(env.DB.one(`SELECT superseded_at FROM brief_versions WHERE id = 'v-a1'`).superseded_at, null);
  assert.equal(env.DB.one(`SELECT superseded_at FROM brief_versions WHERE id = 'v-d1'`).superseded_at, null);
  assert.equal(count(env, "brief_versions"), 3);
  // لا تُمس المكاتب ولا المواقع ولا حصص الذكاء
  assert.ok(count(env, "mayors") >= 12);
  assert.ok(count(env, "sources") >= 36);
  assert.equal(env.DB.one(`SELECT calls FROM ai_provider_budget WHERE provider = 'gemini'`).calls, 37);
  // يُسجَّل من فعل ذلك
  assert.equal(env.DB.one(`SELECT COUNT(*) AS n FROM settings_audit WHERE action = 'review_cleared'`).n, 1);
});

test("after clearing, the same link can be discovered again by a new search", async () => {
  const env = await desk();
  const mayor = MAYORS.find((row) => row.id === "turin");
  const source = sourcesFor("turin")[0];
  const row = { title: "Old story", url: URL_OLD, published_at: new Date().toISOString(), discovery_type: "rss" };

  const blocked = await persistDiscovered(env, { mayor, source, scanId: "scan-2", rows: [row] });
  assert.equal(blocked.inserted, 0, "الرابط معروف قبل المسح فيُتجاهل");

  await post(env, { confirm: "احذف كل الأخبار" });
  const fresh = await persistDiscovered(env, { mayor, source, scanId: "scan-3", rows: [row] });
  assert.equal(fresh.inserted, 1, "بعد المسح يُكتشف من جديد");
});
