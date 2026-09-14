import test from "node:test";
import assert from "node:assert/strict";
import { ensureDb } from "../src/worker.js";
import { translatePending, briefBacklog } from "../src/translate.js";
import { createTestD1 } from "./helpers/d1.js";

const ARTICLE =
  "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma. La festa è prevista sabato 12 settembre.";

function goodBrief() {
  return {
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
  };
}

async function deskWith(items, overrides = {}) {
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
  for (const id of items) {
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
    `);
  }
  return { db, env };
}

test("a pacing wait must not lock an article out for the error backoff", async () => {
  // تباعد طويل حتى يُؤجَّل النداء الثاني، وهو تأجيل جدولة لا عيب في الخبر.
  const { db, env } = await deskWith(["a", "b", "c"], { AI_MIN_INTERVAL_MS: "60000" });
  const fetcher = async () => goodBrief();

  const first = await translatePending(env, 3, null, fetcher);
  assert.equal(first.summarized, 1, "one brief fits inside the pacing window");
  assert.equal(first.deferred, 1, "the next call is deferred by pacing");

  const deferredRow = db.one(
    `SELECT trans_engine, brief_error, brief_attempts, brief_after
     FROM items WHERE trans_engine = 'brief-deferred'`,
  );
  assert.ok(deferredRow, "the deferred article keeps an explicit waiting state");
  assert.equal(deferredRow.brief_attempts, 0, "scheduling must not spend an attempt");
  assert.equal(
    deferredRow.brief_error,
    null,
    "a scheduling wait must not be recorded as an article error, or the fifteen minute backoff locks it out",
  );
  assert.ok(deferredRow.brief_after, "the article carries the time it may resume");

  // الوقت المحفوظ يجب أن يكون قريبًا من التباعد، لا ربع ساعة.
  const waitSeconds = db.one(
    `SELECT CAST((julianday(brief_after) - julianday('now')) * 86400 AS INTEGER) AS s
     FROM items WHERE trans_engine = 'brief-deferred'`,
  ).s;
  assert.ok(waitSeconds <= 120, `resume must be soon, got ${waitSeconds}s`);
});

test("the backlog separates what is waiting from what may run now", async () => {
  const { env } = await deskWith(["a", "b", "c"], { AI_MIN_INTERVAL_MS: "60000" });
  await translatePending(env, 3, null, async () => goodBrief());

  const backlog = await briefBacklog(env);
  assert.equal(backlog.pending, 2, "two articles still need a brief");
  assert.ok(
    backlog.eligible < backlog.pending,
    "an article waiting on pacing is not eligible right now",
  );
  assert.ok(backlog.nextAt, "the desk reports the earliest time work can resume");
});

test("claiming never exceeds the calls the budget can serve right now", async () => {
  const { env } = await deskWith(["a", "b", "c", "d"], { AI_DAILY_LIMIT: "2" });
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return goodBrief();
  };
  const summary = await translatePending(env, 4, null, fetcher);
  assert.equal(calls, 2, "only the remaining daily allowance is spent");
  assert.equal(summary.summarized, 2);
  assert.equal(summary.failed, 0, "running out of allowance is never an article failure");
});

test("a genuine content failure does spend an attempt and backs off", async () => {
  const { db, env } = await deskWith(["a"]);
  const fetcher = async () => ({
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
                  headline_ar: "ستيفانو لو روسو يعلن أمرًا غير موجود",
                  headline_evidence: "questa frase non esiste nella pagina",
                  facts: [{ fact_ar: "حقيقة.", evidence: "nemmeno questa" }],
                  topic_ar: "x",
                }),
              },
            ],
          },
        ],
      };
    },
  });
  const summary = await translatePending(env, 1, null, fetcher);
  assert.equal(summary.failed, 1);
  const row = db.one(`SELECT brief_error, brief_attempts FROM items WHERE id = 'a'`);
  assert.match(row.brief_error, /ai_ungrounded_headline/);
  assert.equal(row.brief_attempts, 1);
});
