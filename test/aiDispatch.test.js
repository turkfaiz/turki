import test from "node:test";
import assert from "node:assert/strict";
import { ensureDb } from "../src/worker.js";
import { assignPendingLanes, boundSlotWaitMs, providerLaneSnapshot, slotRuntimeStatuses } from "../src/aiDispatch.js";
import { briefBacklog, translatePending } from "../src/translate.js";
import { noteAiFailure } from "../src/aiBudget.js";
import { createTestD1 } from "./helpers/d1.js";

const ARTICLE =
  "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma. La festa è prevista sabato 12 settembre.";

const FACTS = {
  headline_ar: "ستيفانو لو روسو يفتتح شارع فيا روما للمشاة",
  headline_evidence: "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma.",
  facts: [
    {
      fact_ar: "موعد الاحتفال السبت 12 سبتمبر.",
      evidence: "La festa è prevista sabato 12 settembre.",
    },
  ],
  topic_ar: "افتتاح شارع",
};

function insertPending(db, id) {
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

function threeSlotEnv(db) {
  return {
    DB: db,
    GEMINI_API_KEY: "gem",
    GEMINI_MODEL: "gemini-test",
    AI_DAILY_LIMIT: "1000",
    AI_MIN_INTERVAL_MS: "0",
    DEEPSEEK_API_KEY: "deep",
    DEEPSEEK_MODEL: "deepseek-flash",
    DEEPSEEK_MIN_INTERVAL_MS: "0",
    DEEPSEEK_DAILY_LIMIT: "2000",
    QWEN_API_KEY: "qwen",
    QWEN_MODEL: "qwen-flash",
    QWEN_MIN_INTERVAL_MS: "0",
    QWEN_DAILY_LIMIT: "2000",
  };
}

async function desk() {
  const db = createTestD1();
  const env = threeSlotEnv(db);
  await ensureDb(env);
  return { db, env };
}

function geminiShape(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(payload) }] }],
      };
    },
  };
}

function openaiShape(payload) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content: JSON.stringify(payload) } }] };
    },
  };
}

function ungrounded() {
  return {
    headline_ar: "ستيفانو لو روسو يعلن أمرًا غير موجود",
    headline_evidence: "questa frase non esiste nella pagina",
    facts: [{ fact_ar: "حقيقة.", evidence: "nemmeno questa" }],
    topic_ar: "x",
  };
}

test("unread pages are split across bound slots instead of copied onto every card", async () => {
  const { db, env } = await desk();
  for (const id of ["a", "b", "c", "d", "e", "f"]) insertPending(db, id);

  const result = await assignPendingLanes(env);
  assert.equal(result.assigned, 6);

  const loads = Object.fromEntries(
    db.query(`SELECT brief_provider AS id, COUNT(*) AS n FROM items GROUP BY brief_provider`)
      .map((row) => [row.id, row.n]),
  );
  assert.equal(loads.gemini, 2);
  assert.equal(loads.deepseek, 2);
  assert.equal(loads.qwen, 2);

  const snap = await providerLaneSnapshot(env, await briefBacklog(env));
  assert.equal(snap.queued, 6);
  assert.equal(snap.unassigned, 0);
  for (const lane of snap.lanes.filter((row) => row.bound)) {
    assert.equal(lane.queued, 2, `${lane.id} must show its own queue, not the global backlog`);
    assert.notEqual(lane.queued, snap.queued);
  }
});

test("a rejected Gemini day moves unread work onto the slots that still have quota", async () => {
  const { db, env } = await desk();
  await noteAiFailure(env, { status: 429, quotaScope: "day" }, "gemini");
  insertPending(db, "a");
  insertPending(db, "b");
  insertPending(db, "c");

  await assignPendingLanes(env);
  const providers = db.query(`SELECT brief_provider AS id FROM items`).map((row) => row.id);
  assert.equal(providers.includes("gemini"), false);
  assert.ok(providers.every((id) => id === "deepseek" || id === "qwen"));
});

test("a Worker subrequest cap defers the article without burning an attempt", async () => {
  const { db, env } = await desk();
  insertPending(db, "a");
  db.exec(`UPDATE items SET brief_provider = 'gemini' WHERE id = 'a'`);

  const summary = await translatePending(env, 3, null, async () => {
    throw new Error("Too many subrequests by single Worker invocation");
  });
  assert.equal(summary.failed, 0);
  assert.equal(summary.deferred, 1);

  const row = db.one(`SELECT brief_attempts, brief_error, trans_engine FROM items WHERE id = 'a'`);
  assert.equal(row.brief_attempts, 0);
  assert.equal(row.brief_error, null);
  assert.equal(row.trans_engine, "brief-deferred");
});

test("an ungrounded Gemini read is handed to the next bound slot", async () => {
  const { db, env } = await desk();
  insertPending(db, "a");
  db.exec(`UPDATE items SET brief_provider = 'gemini' WHERE id = 'a'`);

  const fetcher = async (url) => {
    if (String(url).includes("chat/completions")) return openaiShape(FACTS);
    return geminiShape(ungrounded());
  };

  const first = await translatePending(env, 3, null, fetcher);
  assert.equal(first.summarized, 0);
  assert.equal(first.failed, 1);
  const mid = db.one(
    `SELECT brief_provider, trans_engine, brief_attempts FROM items WHERE id = 'a'`,
  );
  assert.equal(mid.brief_provider, "deepseek");
  assert.equal(mid.trans_engine, "brief-pending");
  assert.equal(mid.brief_attempts, 1);

  const second = await translatePending(env, 3, null, fetcher);
  assert.equal(second.summarized, 1);
  assert.match(db.one(`SELECT trans_engine FROM items WHERE id = 'a'`).trans_engine, /deepseek/);
});

test("three bound slots read three assigned pages in one round", async () => {
  const { db, env } = await desk();
  insertPending(db, "a");
  insertPending(db, "b");
  insertPending(db, "c");

  const seen = new Set();
  const fetcher = async (url) => {
    seen.add(String(url).includes("chat/completions") ? "openai" : "gemini");
    if (String(url).includes("chat/completions")) return openaiShape(FACTS);
    return geminiShape(FACTS);
  };

  const summary = await translatePending(env, 3, null, fetcher);
  assert.equal(summary.summarized, 3);
  assert.equal(summary.pending, 0);
  assert.ok(seen.has("gemini"));
  assert.ok(seen.has("openai"));

  const engines = db.query(`SELECT trans_engine FROM items`).map((row) => row.trans_engine);
  assert.equal(engines.filter((engine) => engine.startsWith("brief-ai-gemini-")).length, 1);
  assert.equal(engines.filter((engine) => engine.startsWith("brief-ai-deepseek-")).length, 1);
  assert.equal(engines.filter((engine) => engine.startsWith("brief-ai-qwen-")).length, 1);
});

test("a 402 from DeepSeek defers the page so Gemini can still read it", async () => {
  const { db, env } = await desk();
  insertPending(db, "a");
  db.exec(`UPDATE items SET brief_provider = 'deepseek' WHERE id = 'a'`);

  const fetcher = async (url, options) => {
    if (String(url).includes("chat/completions")) {
      const body = JSON.parse(options.body);
      if (body.model === "deepseek-flash") {
        return {
          ok: false,
          status: 402,
          headers: { get: () => null },
          async json() {
            return { error: { type: "invalid_request_error", message: "Insufficient Balance" } };
          },
        };
      }
      return openaiShape(FACTS);
    }
    return geminiShape(FACTS);
  };

  const first = await translatePending(env, 3, null, fetcher);
  assert.equal(first.failed, 0, "a slot billing fault must not fail the article");
  assert.ok(first.deferred >= 1);
  const mid = db.one(`SELECT brief_attempts, trans_engine, brief_error FROM items WHERE id = 'a'`);
  assert.equal(mid.brief_attempts, 0);
  assert.equal(mid.brief_error, null);
  assert.equal(mid.trans_engine, "brief-deferred");

  const second = await translatePending(env, 3, null, fetcher);
  assert.equal(second.summarized, 1);
  assert.match(db.one(`SELECT trans_engine FROM items WHERE id = 'a'`).trans_engine, /gemini|qwen/);
});

test("drain wait follows the fastest bound slot, not Gemini alone", () => {
  assert.equal(
    boundSlotWaitMs({
      GEMINI_API_KEY: "g",
      DEEPSEEK_API_KEY: "d",
      QWEN_API_KEY: "q",
      AI_MIN_INTERVAL_MS: "4500",
      DEEPSEEK_MIN_INTERVAL_MS: "800",
      QWEN_MIN_INTERVAL_MS: "800",
    }),
    1000,
  );
  assert.equal(
    boundSlotWaitMs({
      GEMINI_API_KEY: "g",
      AI_MIN_INTERVAL_MS: "4500",
    }),
    4500,
  );
});

test("terminal slot errors stay on the failed provider, not the rotated pending one", async () => {
  const { db, env } = await desk();
  insertPending(db, "dead");
  insertPending(db, "rotated");
  db.exec(`
    UPDATE items
       SET trans_engine = 'brief-ai-error',
           brief_provider = 'gemini',
           brief_error = 'ai_http_402:invalid_request_error',
           brief_attempted_at = datetime('now')
     WHERE id = 'dead';
    UPDATE items
       SET trans_engine = 'brief-pending',
           brief_provider = 'deepseek',
           brief_error = 'ai_ungrounded_headline',
           brief_attempted_at = datetime('now')
     WHERE id = 'rotated';
  `);

  const slots = await slotRuntimeStatuses(env);
  const byId = Object.fromEntries(slots.map((slot) => [slot.id, slot]));
  assert.equal(byId.gemini.lastError?.code, "ai_http_402:invalid_request_error");
  assert.equal(byId.deepseek.lastError, null);
  assert.equal(byId.qwen.lastError, null);

  const snap = await providerLaneSnapshot(env, await briefBacklog(env));
  assert.equal(snap.lanes.find((lane) => lane.id === "gemini")?.lastError?.code, "ai_http_402:invalid_request_error");
  assert.equal(snap.lanes.find((lane) => lane.id === "deepseek")?.lastError, null);
});
