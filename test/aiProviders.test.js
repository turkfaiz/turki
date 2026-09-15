import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_SLOTS,
  aiBriefEnabled,
  allSlotBindings,
  boundSlots,
  chatCompletionsUrl,
  engineForSlot,
  providerIdFromEngine,
  slotBound,
  slotById,
} from "../src/aiProviders.js";
import { availableAiCalls, noteAiFailure, reserveAiCall } from "../src/aiBudget.js";
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

test("slots are a closed Cloudflare-bound registry", () => {
  assert.deepEqual(
    AI_SLOTS.map((slot) => slot.id),
    ["gemini", "deepseek", "qwen"],
  );
  assert.equal(slotById("deepseek").keyVar, "DEEPSEEK_API_KEY");
  assert.equal(slotById("qwen").modelVar, "QWEN_MODEL");
});

test("a slot is bound only with a secret and an enabled flag", () => {
  assert.equal(aiBriefEnabled({}), false);
  assert.equal(aiBriefEnabled({ GEMINI_API_KEY: "k" }), true);
  assert.equal(aiBriefEnabled({ GEMINI_API_KEY: "k", GEMINI_ENABLED: "0" }), false);
  assert.equal(aiBriefEnabled({ DEEPSEEK_API_KEY: "k" }), true);
  assert.equal(aiBriefEnabled({ QWEN_API_KEY: "k", QWEN_ENABLED: "false" }), false);
  assert.equal(
    boundSlots({ GEMINI_API_KEY: "g", DEEPSEEK_API_KEY: "d", DEEPSEEK_ENABLED: "0" }).map((s) => s.id).join(),
    "gemini",
  );
});

test("the live model id comes from Cloudflare vars, not from the slot default", () => {
  const slot = slotById("deepseek");
  const env = { DEEPSEEK_API_KEY: "k", DEEPSEEK_MODEL: "deepseek-custom-test" };
  assert.equal(engineForSlot(env, slot), "brief-ai-deepseek-v2:deepseek-custom-test");
  assert.equal(providerIdFromEngine(engineForSlot(env, slot)), "deepseek");
  const snap = allSlotBindings(env).find((row) => row.id === "deepseek");
  assert.equal(snap.bound, true);
  assert.equal(snap.model, "deepseek-custom-test");
  assert.equal(snap.hasKey, true);
  assert.equal(JSON.stringify(snap).includes('"k"'), false);
});

test("disabling a bound slot from Cloudflare unbinds it without deleting the secret name", () => {
  const env = { DEEPSEEK_API_KEY: "k", DEEPSEEK_ENABLED: "0" };
  assert.equal(slotBound(env, slotById("deepseek")), false);
  const snap = allSlotBindings(env).find((row) => row.id === "deepseek");
  assert.equal(snap.hasKey, true);
  assert.equal(snap.enabled, false);
  assert.equal(snap.bound, false);
});

test("chat completions urls follow the bound base without hardcoding a vendor path", () => {
  assert.equal(
    chatCompletionsUrl("https://api.deepseek.com/v1"),
    "https://api.deepseek.com/v1/chat/completions",
  );
  assert.equal(
    chatCompletionsUrl("https://api.deerapi.com/v1"),
    "https://api.deerapi.com/v1/chat/completions",
  );
});

test("a rejected Gemini day does not spend DeepSeek's budget", async () => {
  const env = aiEnv({
    DEEPSEEK_API_KEY: "deep",
    GEMINI_API_KEY: "gem",
    AI_DAILY_LIMIT: "1",
    DEEPSEEK_DAILY_LIMIT: "50",
    AI_MIN_INTERVAL_MS: "0",
    DEEPSEEK_MIN_INTERVAL_MS: "0",
  });
  await noteAiFailure(env, { status: 429, quotaScope: "day" }, "gemini");
  assert.equal((await reserveAiCall(env, "brief", "gemini")).ok, false);
  assert.equal((await reserveAiCall(env, "brief", "deepseek")).ok, true);
  assert.ok((await availableAiCalls(env, "brief", "deepseek")) > 0);
});

test("a DeepSeek-bound desk reads through the OpenAI-compatible endpoint", async () => {
  const store = { row: null };
  const env = aiEnv({
    DB: fakeBudgetDb(store),
    GEMINI_API_KEY: "",
    GEMINI_ENABLED: "0",
    DEEPSEEK_API_KEY: "deep",
    DEEPSEEK_MODEL: "deepseek-flash",
    DEEPSEEK_MIN_INTERVAL_MS: "0",
  });
  let url = "";
  const fetcher = async (target, options) => {
    url = target;
    const body = JSON.parse(options.body);
    assert.equal(body.model, "deepseek-flash");
    assert.equal(body.thinking.type, "disabled");
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
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
            },
          ],
        };
      },
    };
  };
  const brief = await summarizeWithGemini(env, article, turin, fetcher);
  assert.match(url, /chat\/completions/);
  assert.match(brief.engine, /brief-ai-deepseek-v2:deepseek-flash/);
  assert.match(brief.title_ar, /ستيفانو لو روسو/);
});

test("a Qwen-bound desk disables thinking so DashScope accepts a non-streaming JSON call", async () => {
  const store = { row: null };
  const env = aiEnv({
    DB: fakeBudgetDb(store),
    GEMINI_API_KEY: "",
    GEMINI_ENABLED: "0",
    DEEPSEEK_API_KEY: "",
    QWEN_API_KEY: "qwen",
    QWEN_MODEL: "qwen-flash",
    QWEN_MIN_INTERVAL_MS: "0",
  });
  let url = "";
  const fetcher = async (target, options) => {
    url = target;
    const body = JSON.parse(options.body);
    assert.equal(body.model, "qwen-flash");
    assert.equal(body.enable_thinking, false);
    assert.equal(body.stream, false);
    assert.equal(body.thinking, undefined);
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          choices: [
            {
              message: {
                content: JSON.stringify({
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
            },
          ],
        };
      },
    };
  };
  const brief = await summarizeWithGemini(env, article, turin, fetcher);
  assert.match(url, /chat\/completions/);
  assert.match(brief.engine, /brief-ai-qwen-v2:qwen-flash/);
});
