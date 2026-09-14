import test from "node:test";
import assert from "node:assert/strict";
import { ensureDb } from "../src/worker.js";
import { MAX_BRIEF_ATTEMPTS, translatePending } from "../src/translate.js";
import { createTestD1 } from "./helpers/d1.js";

/**
 * These paths are SQL, so they run against a real engine. The previous
 * hand-written double never parsed a statement, which is how an ordering clause
 * and a fifteen minute lockout both passed review.
 */
const ARTICLE =
  "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma. La festa è prevista sabato 12 settembre.";

function insertPending(db, id, extra = "") {
  db.exec(`
    INSERT INTO items (
      id, mayor_id, source, title, title_normalized, url, published_at, snippet,
      title_ar, snippet_ar, language, confidence, status, fingerprint, trans_engine,
      publisher_domain, publisher_tier, article_text, source_count, brief_attempts
    ) VALUES (
      '${id}', 'turin', 'approved_feed',
      'Lo Russo inaugura via Roma', 'lo russo inaugura via roma',
      'https://www.comune.torino.it/${id}', datetime('now','-1 days'), 'snippet',
      'بانتظار قراءة الذكاء الاصطناعي — ستيفانو لو روسو', '', 'it', 'raw', 'inbox',
      'fp-${id}', 'brief-pending', 'comune.torino.it', 0,
      '${ARTICLE}', 1, 0
    );
    ${extra}
  `);
}

async function desk(overrides = {}) {
  const db = createTestD1();
  const env = {
    DB: db,
    GEMINI_API_KEY: "test",
    GEMINI_MODEL: "gemini-test",
    AI_DAILY_LIMIT: "1000",
    AI_MIN_INTERVAL_MS: "0",
    ...overrides,
  };
  await ensureDb(env);
  return { db, env };
}

const grounded = async () => ({
  ok: true,
  status: 200,
  async json() {
    return {
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                headline_ar: "ستيفانو لو روسو يفتتح شارع فيا روما للمشاة",
                headline_evidence:
                  "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma.",
                facts: [
                  {
                    fact_ar: "موعد الاحتفال السبت 12 سبتمبر.",
                    evidence: "La festa è prevista sabato 12 settembre.",
                  },
                ],
                topic_ar: "افتتاح شارع",
              }),
            },
          ],
        },
      ],
    };
  },
});

test("a grounded answer becomes a stored Arabic brief with nothing left pending", async () => {
  const { db, env } = await desk();
  insertPending(db, "a");

  const summary = await translatePending(env, 1, null, grounded);
  assert.equal(summary.summarized, 1);
  assert.equal(summary.failed, 0);
  assert.equal(summary.deferred, 0);
  assert.equal(summary.pending, 0);

  const row = db.one(`SELECT * FROM items WHERE id = 'a'`);
  assert.equal(row.trans_engine, "brief-ai-gemini-v2:gemini-test");
  assert.match(row.title_ar, /ستيفانو لو روسو يفتتح/);
  assert.match(row.snippet_ar, /12 سبتمبر/);
  assert.equal(row.brief_error, null);
  assert.equal(row.brief_after, null, "a delivered brief carries no resume time");
  assert.equal(row.brief_claim_id, null, "the claim is released");
});

test("an exhausted daily allowance leaves articles waiting, not failed", async () => {
  const { db, env } = await desk({ AI_DAILY_LIMIT: "1" });
  insertPending(db, "a");
  insertPending(db, "b");

  const first = await translatePending(env, 2, null, grounded);
  assert.equal(first.summarized, 1);
  const second = await translatePending(env, 2, null, grounded);
  assert.equal(second.summarized, 0);
  assert.equal(second.failed, 0, "no allowance is never an article failure");
  assert.equal(second.pending, 1);

  const waiting = db.one(`SELECT * FROM items WHERE trans_engine <> 'brief-ai-gemini-v2:gemini-test'`);
  assert.equal(waiting.brief_attempts, 0, "an attempt is not spent on scheduling");
  assert.equal(waiting.brief_error, null);
});

test("only a single mayor is claimed when the desk is scoped to one office", async () => {
  const { db, env } = await desk();
  insertPending(db, "turin-1");
  db.exec(`
    INSERT INTO items (
      id, mayor_id, source, title, title_normalized, url, published_at, snippet,
      title_ar, snippet_ar, language, confidence, status, fingerprint, trans_engine,
      publisher_domain, publisher_tier, article_text, source_count, brief_attempts
    ) VALUES (
      'seoul-1', 'seoul', 'approved_feed', 'Oh Se-hoon opens a park',
      'oh se-hoon opens a park', 'https://www.yna.co.kr/x', datetime('now','-1 days'),
      'snippet', 'بانتظار', '', 'ko', 'raw', 'inbox', 'fp-seoul-1', 'brief-pending',
      'yna.co.kr', 1, 'Oh Se-hoon opened a park in Seoul today.', 1, 0
    );
  `);

  const summary = await translatePending(env, 5, "turin", grounded);
  assert.equal(summary.summarized, 1, "the scoped office is summarised");
  assert.equal(
    db.one(`SELECT trans_engine FROM items WHERE id = 'seoul-1'`).trans_engine,
    "brief-pending",
    "another office is untouched by a scoped run",
  );
});

test("an article stops being retried once it spends every attempt", async () => {
  const { db, env } = await desk();
  insertPending(
    db,
    "a",
    `UPDATE items SET brief_attempts = ${MAX_BRIEF_ATTEMPTS}, brief_error = 'ai_invalid_json',
       trans_engine = 'brief-ai-error' WHERE id = 'a';`,
  );
  const summary = await translatePending(env, 5, null, grounded);
  assert.equal(summary.summarized, 0);
  assert.equal(summary.pending, 0, "an exhausted article is no longer counted as waiting work");
});
