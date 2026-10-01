import test from "node:test";
import assert from "node:assert/strict";
import { ensureDb, completeMayorDesk } from "../src/worker.js";
import { persistDiscovered, fetchCandidateBatch } from "../src/pipeline.js";
import { translatePending, verifyPending } from "../src/translate.js";
import { sourcesFor } from "../src/sources.js";
import { mayorById } from "../src/mayors.js";
import { D1Sqlite } from "./helpers/d1sqlite.js";

/**
 * Proves the search journey is read- and write-light on a real SQLite database:
 * discovery, article ingest, inbox review, summarize, verify, and job-journey
 * persistence for one office cost a few hundred reads/writes and never full-scan
 * the items table. This guards against reintroducing heavy internal work — the
 * D1 rows_read blow-up came from dashboard aggregate polling, not the journey.
 */

const FRESH = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

function makeEnv() {
  return {
    DB: new D1Sqlite(),
    GEMINI_API_KEY: "secret",
    GEMINI_MODEL: "gemini-test",
    AI_DAILY_LIMIT: "1000",
    AI_MIN_INTERVAL_MS: "0",
    SCAN_QUEUE: { async send() {}, async sendBatch() {} },
  };
}

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, async text() { return body; } };
}

function articleFetch(url) {
  return response(
    200,
    `<html><head>
      <meta property="og:title" content="Stefano Lo Russo inaugura via">
      <meta property="article:published_time" content="${FRESH}">
      <link rel="canonical" href="${url}">
    </head><body>
      <p>Stefano Lo Russo inaugura la nuova via pedonale di Via Roma con una festa questa settimana a Torino.</p>
      <p>Il sindaco ha spiegato i dettagli del progetto e il calendario dei lavori conclusi in questi giorni.</p>
    </body></html>`,
  );
}

function briefResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
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
                  headline_evidence: "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma",
                  facts: [{ fact_ar: "افتتاح هذا الأسبوع.", evidence: "festa questa settimana a Torino" }],
                  topic_ar: "افتتاح",
                }),
              },
            ],
          },
        ],
      };
    },
  };
}

function verdictResponse() {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    async json() {
      return {
        steps: [
          { type: "model_output", content: [{ type: "text", text: JSON.stringify({ headline_supported: true, facts: [{ index: 0, supported: true }] }) }] },
        ],
      };
    },
  };
}

test("a full single-office search journey stays read- and write-light", async () => {
  const env = makeEnv();
  await ensureDb(env);
  const mayorId = "turin";
  const mayor = mayorById(mayorId);
  const sources = sourcesFor(mayorId);
  const jobId = "job-cost";
  const scanId = "scan-cost";
  await env.DB.prepare(`INSERT INTO search_jobs (id, status) VALUES (?, 'running')`).bind(jobId).run();
  await env.DB
    .prepare(`INSERT INTO search_job_tasks (job_id, mayor_id, status, stage) VALUES (?, ?, 'running', 'article_fetch')`)
    .bind(jobId, mayorId)
    .run();
  await env.DB
    .prepare(`INSERT INTO scans (id, type, mayor_id, started_at) VALUES (?, 'manual', ?, ?)`)
    .bind(scanId, mayorId, new Date().toISOString())
    .run();

  const log = env.DB.startRecording();
  for (const source of sources) {
    const rows = Array.from({ length: 6 }, (_, n) => ({
      url: `https://${source.domain}/news/cost-${n}`,
      title: `Stefano Lo Russo story ${n}`,
      published_at: FRESH,
      discovery_type: "rss",
    }));
    await persistDiscovered(env, { mayor, source, scanId, rows });
  }
  const { results: candidates } = await env.DB
    .prepare(`SELECT id FROM candidates WHERE mayor_id = ? AND fetch_status = 'pending'`)
    .bind(mayorId)
    .all();
  await fetchCandidateBatch(env, {
    ids: candidates.map((row) => row.id),
    mayorId,
    limit: 32,
    fetch: async (url) => articleFetch(String(url)),
  });
  await completeMayorDesk(env, { mayorId, jobId, scanId });
  for (let i = 0; i < 20; i += 1) {
    const s = await translatePending(env, 6, mayorId, async () => briefResponse());
    if (s.pending === 0 || (!s.summarized && !s.failed && !s.deferred)) break;
  }
  for (let i = 0; i < 20; i += 1) {
    const v = await verifyPending(env, 6, async () => verdictResponse());
    if (v.pending === 0 || (!v.verified && !v.rejected && !v.deferred)) break;
  }
  env.DB.stopRecording();

  const report = env.DB.analyze(log);
  const items = env.DB._tableRowCount("items");
  assert.ok(items > 0, "the journey must actually ingest items");
  assert.equal(report.fullItemScans, 0, "the journey must not full-scan the items table");
  assert.ok(
    report.rowsRead < 3000,
    `journey rows_read should stay small, saw ${report.rowsRead}`,
  );
  assert.ok(
    report.rowsWritten < 1500,
    `journey rows_written should stay small, saw ${report.rowsWritten}`,
  );
});
