import test from "node:test";
import assert from "node:assert/strict";
import { MAX_BRIEF_ATTEMPTS, translatePending } from "../src/translate.js";
import { fakeBudgetDb } from "./helpers/aiEnv.js";

/**
 * Recognises the statements translate.js issues against the items table and
 * applies their intent to an in-memory list, so brief bookkeeping can be
 * asserted without a live D1 instance.
 */
function fakeItemsDb(rows, budgetStore = { row: null }) {
  const budget = fakeBudgetDb(budgetStore);
  const eligible = (row, engine) =>
    row.trans_engine !== engine && (row.brief_attempts || 0) < MAX_BRIEF_ATTEMPTS;

  return {
    __rows: rows,
    __budget: budgetStore,
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return [];
    },
    prepare(sql) {
      if (/ai_budget/.test(sql)) return budget.prepare(sql);
      return {
        bind(...binds) {
          return {
            async run() {
              if (/SET brief_claim_id = \?, brief_claimed_at/.test(sql)) {
                const [claimId, engine] = binds;
                const limit = Number(binds.at(-1));
                rows
                  .filter((row) => eligible(row, engine) && !row.brief_claim_id)
                  .slice(0, limit)
                  .forEach((row) => {
                    row.brief_claim_id = claimId;
                  });
                return { meta: { changes: 1 } };
              }
              if (/brief_evidence = \?, brief_error = NULL/.test(sql)) {
                const [titleAr, snippetAr, engine, evidence, id] = binds;
                const row = rows.find((entry) => entry.id === id);
                Object.assign(row, {
                  title_ar: titleAr,
                  snippet_ar: snippetAr,
                  trans_engine: engine,
                  brief_evidence: evidence,
                  brief_error: null,
                  brief_attempts: (row.brief_attempts || 0) + 1,
                  brief_claim_id: null,
                });
                return { meta: { changes: 1 } };
              }
              if (/brief_evidence = NULL, brief_error = \?/.test(sql)) {
                const [titleAr, snippetAr, engine, note, increment, id] = binds;
                const row = rows.find((entry) => entry.id === id);
                Object.assign(row, {
                  title_ar: titleAr,
                  snippet_ar: snippetAr,
                  trans_engine: engine,
                  brief_error: note,
                  brief_attempts: (row.brief_attempts || 0) + Number(increment),
                  brief_claim_id: null,
                });
                return { meta: { changes: 1 } };
              }
              if (/SET brief_claim_id = NULL, brief_claimed_at = NULL WHERE id = \?/.test(sql)) {
                const row = rows.find((entry) => entry.id === binds[0]);
                if (row) row.brief_claim_id = null;
                return { meta: { changes: 1 } };
              }
              throw new Error(`unexpected sql: ${sql}`);
            },
            async first() {
              if (/COUNT\(\*\) AS pending/.test(sql)) {
                return { pending: rows.filter((row) => eligible(row, binds[0])).length };
              }
              throw new Error(`unexpected sql: ${sql}`);
            },
            async all() {
              if (/WHERE items\.brief_claim_id = \?/.test(sql)) {
                return { results: rows.filter((row) => row.brief_claim_id === binds[0]) };
              }
              throw new Error(`unexpected sql: ${sql}`);
            },
          };
        },
      };
    },
  };
}

function articleRow(id) {
  return {
    id,
    title: "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma",
    snippet: "La festa è prevista sabato 12 settembre.",
    article_text:
      "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma. La festa è prevista sabato 12 settembre.",
    name_ar: "ستيفانو لو روسو",
    name_en: "Stefano Lo Russo",
    name_native: "Stefano Lo Russo",
    title_ar: "",
    city_ar: "تورينو",
    city_en: "Turin",
    brief_attempts: 0,
    trans_engine: "brief-pending",
    brief_claim_id: null,
  };
}

test("an exhausted AI budget defers articles without spending their retries", async () => {
  const rows = [articleRow("a"), articleRow("b")];
  const db = fakeItemsDb(rows);
  const env = {
    GEMINI_API_KEY: "secret",
    GEMINI_MODEL: "gemini-test",
    AI_DAILY_LIMIT: "1",
    AI_MIN_INTERVAL_MS: "0",
    DB: db,
  };
  // استهلاك الحصة الوحيدة قبل بدء الدفعة.
  await env.DB.prepare(
    `INSERT INTO ai_budget (day, calls, last_call_at) VALUES (?, 1, datetime('now'))
     ON CONFLICT(day) DO UPDATE SET calls = ai_budget.calls + 1, last_call_at = datetime('now')`,
  )
    .bind("2026-09-10", 1, "-0.000 seconds")
    .run();

  const summary = await translatePending(env, 2, null);
  assert.equal(summary.summarized, 0);
  assert.equal(summary.failed, 0);
  assert.equal(summary.deferred, 1);
  assert.equal(summary.pending, 2);
  assert.equal(rows[0].trans_engine, "brief-deferred");
  assert.equal(rows[0].brief_attempts, 0, "الحصة ليست خطأ في الخبر");
  assert.equal(rows[0].snippet_ar, "", "لا يُختلق أي محتوى أثناء الانتظار");
  assert.equal(rows[1].brief_claim_id, null, "بقية الصفوف تُحرَّر لتشغيل لاحق");
  assert.equal(rows[1].brief_attempts, 0);
});

test("a genuinely ungrounded answer counts as an attempt and ends in a failed state", async () => {
  const rows = [articleRow("a")];
  const db = fakeItemsDb(rows);
  const env = {
    GEMINI_API_KEY: "secret",
    GEMINI_MODEL: "gemini-test",
    AI_DAILY_LIMIT: "50",
    AI_MIN_INTERVAL_MS: "0",
    DB: db,
  };
  globalThis.fetch = async () => ({
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
                  headline_ar: "ستيفانو لو روسو يعلن مشروعًا لم يُذكر",
                  headline_evidence: "This sentence is absent from the page.",
                  facts: [{ fact_ar: "حقيقة مختلقة.", evidence: "also absent" }],
                  topic_ar: "مشروع",
                }),
              },
            ],
          },
        ],
      };
    },
  });

  const summary = await translatePending(env, 1, null);
  assert.equal(summary.failed, 1);
  assert.equal(summary.deferred, 0);
  assert.equal(rows[0].trans_engine, "brief-ai-error");
  assert.equal(rows[0].brief_attempts, 1);
  assert.match(rows[0].brief_error, /ai_ungrounded_headline/);
});
