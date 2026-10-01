/**
 * Measures the real D1 cost of one search journey end-to-end — reads AND writes
 * — on a real SQLite database running the worker's actual SQL. It exercises the
 * genuine write paths (candidate discovery, article ingest, inbox review + merge,
 * summarize, verify, and search-job journey persistence) so we can see whether
 * reads or writes dominate, and where the heavy internal work is.
 *
 * Run: node scripts/measure-journey.mjs [newArticlesPerSource]
 *
 * D1 free daily limits: 5,000,000 rows_read, 100,000 rows_written.
 */
import { ensureDb } from "../src/db/bootstrap.js";
import { completeMayorDesk } from "../src/jobs/desk.js";
import { persistDiscovered, fetchCandidateBatch } from "../src/pipeline.js";
import { translatePending, verifyPending } from "../src/translate.js";
import { sourcesFor } from "../src/sources.js";
import { mayorById, MAYORS } from "../src/mayors.js";
import { D1Sqlite } from "../test/helpers/d1sqlite.js";

const PER_SOURCE = Number(process.argv[2]) || 6;
const FRESH = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

function makeEnv() {
  return {
    DB: new D1Sqlite(),
    GEMINI_API_KEY: "secret",
    GEMINI_MODEL: "gemini-test",
    AI_DAILY_LIMIT: "1000",
    AI_MIN_INTERVAL_MS: "0",
    DASHBOARD_USER: "mayorwatch",
    DASHBOARD_PASSWORD: "secret",
    SCAN_QUEUE: { async send() {}, async sendBatch() {} },
    ASSETS: { fetch: async () => new Response("ok") },
  };
}

function articleHtml(url) {
  return `<html><head>
    <meta property="og:title" content="Stefano Lo Russo inaugura via">
    <meta property="article:published_time" content="${FRESH}">
    <link rel="canonical" href="${url}">
  </head><body>
    <p>Stefano Lo Russo inaugura la nuova via pedonale di Via Roma con una festa questa settimana nel centro di Torino.</p>
    <p>Il sindaco ha spiegato i dettagli del progetto e il calendario dei lavori conclusi in questi giorni a Torino.</p>
  </body></html>`;
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    async text() { return body; },
    async json() { return JSON.parse(body); },
  };
}

const articleFetch = async (url) => response(200, articleHtml(String(url)));

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
                  facts: [{ fact_ar: "افتتاح هذا الأسبوع.", evidence: "festa questa settimana nel centro di Torino" }],
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
          {
            type: "model_output",
            content: [{ type: "text", text: JSON.stringify({ headline_supported: true, facts: [{ index: 0, supported: true }] }) }],
          },
        ],
      };
    },
  };
}

async function record(env, fn) {
  const log = env.DB.startRecording();
  await fn();
  env.DB.stopRecording();
  return env.DB.analyze(log);
}

function fmt(n) {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

// Set up a realistic search job + tasks + scan row for one mayor.
async function seedJob(env, mayorId, jobId, scanId) {
  await env.DB.prepare(`INSERT INTO search_jobs (id, status) VALUES (?, 'running')`).bind(jobId).run();
  await env.DB.prepare(
    `INSERT INTO search_job_tasks (job_id, mayor_id, status, stage) VALUES (?, ?, 'running', 'article_fetch')`,
  ).bind(jobId, mayorId).run();
  await env.DB.prepare(
    `INSERT INTO scans (id, type, mayor_id, started_at, found_count, duplicate_count, excluded_count, error_count)
     VALUES (?, 'manual', ?, ?, 0, 0, 0, 0)`,
  ).bind(scanId, mayorId, new Date().toISOString()).run();
}

async function runMayorJourney(env, mayorId, urlTag, runTag) {
  const mayor = mayorById(mayorId);
  const sources = sourcesFor(mayorId);
  const jobId = `job-${mayorId}-${runTag}`;
  const scanId = `scan-${mayorId}-${runTag}`;
  await seedJob(env, mayorId, jobId, scanId);

  const phases = {};

  phases.discover = await record(env, async () => {
    for (const source of sources) {
      const rows = Array.from({ length: PER_SOURCE }, (_, n) => ({
        url: `https://${source.domain}/news/${urlTag}-${n}`,
        title: `Stefano Lo Russo story ${urlTag}-${n}`,
        published_at: FRESH,
        discovery_type: "rss",
      }));
      await persistDiscovered(env, { mayor, source, scanId, rows });
    }
  });

  const { results: candidates } = await env.DB
    .prepare(`SELECT id FROM candidates WHERE mayor_id = ? AND fetch_status = 'pending'`)
    .bind(mayorId)
    .all();
  const ids = candidates.map((row) => row.id);

  phases.fetch = await record(env, async () => {
    for (let i = 0; i < ids.length; i += 6) {
      await fetchCandidateBatch(env, { ids: ids.slice(i, i + 6), mayorId, limit: 6, fetch: articleFetch });
    }
  });

  phases.review = await record(env, async () => {
    await completeMayorDesk(env, { mayorId, jobId, scanId });
  });

  phases.summarize = await record(env, async () => {
    for (let i = 0; i < 20; i += 1) {
      const s = await translatePending(env, 6, mayorId, async () => briefResponse());
      if (!s.summarized && !s.failed && !s.deferred) break;
      if (s.pending === 0) break;
    }
  });

  phases.verify = await record(env, async () => {
    for (let i = 0; i < 20; i += 1) {
      const v = await verifyPending(env, 6, async () => verdictResponse());
      if (v.pending === 0) break;
      if (!v.verified && !v.rejected && !v.deferred) break;
    }
  });

  return phases;
}

function sumPhases(phases) {
  return Object.values(phases).reduce(
    (acc, p) => {
      acc.statements += p.statements;
      acc.rowsRead += p.rowsRead;
      acc.rowsWritten += p.rowsWritten;
      acc.writeStatements += p.writeStatements;
      acc.fullItemScans += p.fullItemScans;
      return acc;
    },
    { statements: 0, rowsRead: 0, rowsWritten: 0, writeStatements: 0, fullItemScans: 0 },
  );
}

function printPhases(title, phases) {
  console.log(`\n=== ${title} ===`);
  const w = 12;
  console.log(`${"phase".padEnd(w)}  ${"stmts".padStart(6)}  ${"rows_read".padStart(10)}  ${"rows_written".padStart(12)}  ${"writeStmts".padStart(10)}  ${"itemScans".padStart(9)}`);
  for (const [name, p] of Object.entries(phases)) {
    console.log(`${name.padEnd(w)}  ${String(p.statements).padStart(6)}  ${fmt(p.rowsRead).padStart(10)}  ${fmt(p.rowsWritten).padStart(12)}  ${String(p.writeStatements).padStart(10)}  ${String(p.fullItemScans).padStart(9)}`);
  }
  const total = sumPhases(phases);
  console.log(`${"TOTAL".padEnd(w)}  ${String(total.statements).padStart(6)}  ${fmt(total.rowsRead).padStart(10)}  ${fmt(total.rowsWritten).padStart(12)}  ${String(total.writeStatements).padStart(10)}  ${String(total.fullItemScans).padStart(9)}`);
  return total;
}

async function main() {
  const env = makeEnv();
  await ensureDb(env);
  console.log(`Journey cost per mayor — ${PER_SOURCE} fresh articles/source, ${sourcesFor("turin").length} sources`);

  const first = await runMayorJourney(env, "turin", "wk1", "r1");
  const firstTotal = printPhases("FIRST search (fresh articles ingested)", first);

  // A second search with the same URLs: no new candidates, but the desk still
  // re-reviews the whole inbox and re-persists the journey.
  const second = await runMayorJourney(env, "turin", "wk1", "r2");
  const secondTotal = printPhases("SECOND search (same URLs, steady state)", second);

  const offices = MAYORS.length;
  console.log("\n=== modeled full manual search of all 12 offices (first run) ===");
  console.log(`rows_read   ≈ ${fmt(firstTotal.rowsRead * offices)}`);
  console.log(`rows_written≈ ${fmt(firstTotal.rowsWritten * offices)}   (free daily write limit: 100,000)`);
  console.log(`statements  ≈ ${fmt(firstTotal.statements * offices)}`);
  console.log(`\n(one office, steady-state repeat: ${fmt(secondTotal.rowsRead)} read / ${fmt(secondTotal.rowsWritten)} written)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
