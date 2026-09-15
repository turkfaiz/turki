import test from "node:test";
import assert from "node:assert/strict";
import worker, { ensureDb } from "../src/worker.js";
import { createTestD1 } from "./helpers/d1.js";

function envWith(overrides = {}) {
  return {
    DB: createTestD1(),
    GEMINI_MODEL: "gemini-test",
    ...overrides,
  };
}

function request(path) {
  return new Request(`https://mayor-watch.test${path}`, {
    headers: { "content-type": "application/json" },
  });
}

function seedLanes(db) {
  db.exec(`
    INSERT INTO items (
      id, mayor_id, source, title, title_normalized, url, published_at, snippet,
      title_ar, snippet_ar, language, confidence, status, fingerprint, trans_engine,
      publisher_domain, publisher_tier, article_text, source_count, brief_attempts
    ) VALUES
    ('ready-1', 'turin', 'approved_feed',
      'Lo Russo apre via Roma', 'lo russo apre via roma',
      'https://www.comune.torino.it/ready', datetime('now','-1 days'), 'snippet',
      'ستيفانو لو روسو يفتتح شارع فيا روما للمشاة', 'موعد الاحتفال السبت 12 سبتمبر.',
      'it', 'raw', 'inbox', 'fp-ready', 'brief-ai-gemini-v2:gemini-test',
      'comune.torino.it', 0, 'Stefano Lo Russo apre via Roma.', 1, 1),
    ('wait-1', 'turin', 'approved_feed',
      'Lo Russo visita le scuole', 'lo russo visita le scuole',
      'https://www.comune.torino.it/wait', datetime('now','-1 days'), 'snippet',
      'بانتظار قراءة الذكاء الاصطناعي — ستيفانو لو روسو', '',
      'it', 'raw', 'inbox', 'fp-wait', 'brief-pending',
      'comune.torino.it', 0, 'Stefano Lo Russo visita le scuole.', 1, 0);
  `);
}

test("inbox lists only completed briefs and waiting lists what is still being read", async () => {
  const env = envWith();
  await ensureDb(env);
  seedLanes(env.DB);

  const inbox = await worker.fetch(request("/api/items?status=inbox"), env).then((res) => res.json());
  assert.deepEqual(
    inbox.items.map((row) => row.id),
    ["ready-1"],
  );

  const waiting = await worker
    .fetch(request("/api/items?status=waiting"), env)
    .then((res) => res.json());
  assert.deepEqual(
    waiting.items.map((row) => row.id),
    ["wait-1"],
  );

  const stats = await worker.fetch(request("/api/stats"), env).then((res) => res.json());
  assert.equal(stats.inbox, 1);
  assert.equal(stats.waiting, 1);
});
