import test from "node:test";
import assert from "node:assert/strict";
import {
  budgetState,
  isDeferredAiError,
  noteAiFailure,
  purposeLimit,
  reserveAiCall,
  secondsUntilUtcMidnight,
} from "../src/aiBudget.js";
import { summarizeWithGemini } from "../src/aiBrief.js";
import { MAYORS } from "../src/mayors.js";
import { aiEnv, fakeBudgetDb } from "./helpers/aiEnv.js";

const turin = MAYORS.find((mayor) => mayor.id === "turin");
const article = {
  title: "Via Roma: inaugurazione della nuova via pedonale",
  snippet: "Stefano Lo Russo presenta la riqualificazione.",
  article_text:
    "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma. La festa è prevista sabato 12 settembre.",
  publisher_domain: "comune.torino.it",
  published_at: "2026-09-08T12:00:00Z",
};

test("merging never spends more than a small share of the daily AI budget", () => {
  assert.equal(purposeLimit(400, "brief"), 400);
  assert.equal(purposeLimit(400, "merge"), 120);
  assert.ok(purposeLimit(400, "merge") < purposeLimit(400, "brief"));
});

test("the daily ceiling stops further calls and reports when the day resets", async () => {
  const env = aiEnv({ AI_DAILY_LIMIT: "2" });
  assert.equal((await reserveAiCall(env, "brief")).ok, true);
  assert.equal((await reserveAiCall(env, "brief")).ok, true);
  const blocked = await reserveAiCall(env, "brief");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "daily_limit");
  assert.ok(blocked.retryAfterSeconds > 0);
  assert.ok(blocked.retryAfterSeconds <= secondsUntilUtcMidnight() + 5);
});

test("pacing spaces calls apart instead of hammering the provider", async () => {
  const env = aiEnv({ AI_MIN_INTERVAL_MS: "60000" });
  assert.equal((await reserveAiCall(env, "brief")).ok, true);
  const paced = await reserveAiCall(env, "brief");
  assert.equal(paced.ok, false);
  assert.equal(paced.reason, "rate_pacing");
  assert.equal(paced.retryAfterSeconds, 60);
});

test("a per-day quota rejection pauses the whole desk, not one article", async () => {
  const env = aiEnv();
  await noteAiFailure(env, { status: 429, quotaScope: "day" });
  const state = await budgetState(env);
  assert.equal(state.blocked, true);
  assert.equal(state.blockReason, "daily_limit");
  assert.ok(state.resumesInSeconds > 600);
  const blocked = await reserveAiCall(env, "brief");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "daily_limit");
});

test("a per-minute rejection pauses only briefly", async () => {
  const env = aiEnv();
  await noteAiFailure(env, { status: 429, quotaScope: "minute", retryAfterSeconds: 30 });
  const state = await budgetState(env);
  assert.equal(state.blocked, true);
  assert.ok(state.resumesInSeconds <= 30);
});

test("an exhausted budget defers the brief without ever calling the provider", async () => {
  const env = aiEnv({ AI_DAILY_LIMIT: "1" });
  await reserveAiCall(env, "brief");
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    throw new Error("network should not be reached");
  };
  await assert.rejects(
    summarizeWithGemini(env, article, turin, fetcher),
    (error) => isDeferredAiError(error) && /ai_deferred/.test(error.message),
  );
  assert.equal(calls, 0);
});

test("a grounded brief costs exactly one AI call by default", async () => {
  const store = { row: null };
  const env = aiEnv({ DB: fakeBudgetDb(store) });
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
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
                    topic_ar: "افتتاح شارع للمشاة",
                  }),
                },
              ],
            },
          ],
        };
      },
    };
  };
  const brief = await summarizeWithGemini(env, article, turin, fetcher);
  assert.match(brief.title_ar, /ستيفانو لو روسو/);
  assert.equal(calls, 1);
  assert.equal(store.row.calls, 1);
});
