/**
 * Measures D1 `rows_read` for the hot operations behind the monitoring desk,
 * using a real SQLite database that runs the worker's actual SQL and indexes.
 *
 * It boots the real worker (which creates the schema and seeds the registry),
 * seeds a realistic backlog of items, then records and costs the statements
 * issued by the brief-claim path and the dashboard endpoints. The session
 * total models one manual "search all offices" while the operator watches the
 * progress page, which is when the row reads explode.
 *
 * Run: node scripts/measure-rows-read.mjs [itemCount]
 */
import worker from "../src/worker.js";
import { translatePending } from "../src/translate.js";
import { MAYORS } from "../src/mayors.js";
import { D1Sqlite } from "../test/helpers/d1sqlite.js";

const ITEM_COUNT = Number(process.argv[2]) || 3000;

const DASH_USER = "mayorwatch";
const DASH_PASS = "secret";
const AUTH = { Authorization: `Basic ${Buffer.from(`${DASH_USER}:${DASH_PASS}`).toString("base64")}` };

function makeEnv() {
  const sent = [];
  return {
    DB: new D1Sqlite(),
    GEMINI_API_KEY: "secret",
    GEMINI_MODEL: "gemini-test",
    AI_DAILY_LIMIT: "400",
    AI_MIN_INTERVAL_MS: "0",
    DASHBOARD_USER: DASH_USER,
    DASHBOARD_PASSWORD: DASH_PASS,
    SCAN_QUEUE: { async send() {}, async sendBatch() {} },
    ASSETS: { fetch: async () => new Response("ok") },
    __sent: sent,
  };
}

function authed(path) {
  return new Request(`https://d${path}`, { headers: AUTH });
}

async function boot(env) {
  // Health hits ensureDb, which creates every table/index and seeds the registry.
  await worker.fetch(new Request("https://d/api/health"), env);
}

function printPlan(env, label, matcher) {
  const log = env.DB.startRecording();
  env.DB.stopRecording();
  return log;
}

/** Print EXPLAIN QUERY PLAN for a captured statement so the cost driver is visible. */
function explain(env, sql) {
  try {
    const rows = env.DB.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all();
    return rows.map((r) => `    ${r.detail}`).join("\n");
  } catch (error) {
    return `    (could not explain: ${error.message})`;
  }
}

function seedItems(env, count) {
  const db = env.DB.db;
  db.exec("BEGIN");
  const stmt = db.prepare(
    `INSERT INTO items (
       id, mayor_id, scan_id, source, title, title_normalized, url, published_at,
       snippet, language, confidence, status, fingerprint, publisher_domain,
       publisher_tier, article_text, source_documents, merged_sources, source_count,
       title_ar, snippet_ar, trans_engine, brief_attempts
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (let i = 0; i < count; i += 1) {
    const mayor = MAYORS[i % MAYORS.length];
    const body =
      "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma. " +
      "La festa e prevista sabato 12 settembre. ".repeat(6);
    stmt.run(
      `item-${i}`,
      mayor.id,
      null,
      "approved_feed",
      `News ${i} about ${mayor.name_en}`,
      `news ${i} about ${mayor.name_en}`.toLowerCase(),
      `https://example.com/${mayor.id}/${i}`,
      new Date(Date.now() - (i % 6) * 86400000).toISOString(),
      "snippet",
      mayor.native_lang,
      "raw",
      "inbox",
      `fp-${i}`,
      `${mayor.official_host}`,
      1,
      body,
      "[]",
      "[]",
      1,
      "بانتظار قراءة الذكاء الاصطناعي",
      "",
      "brief-pending",
      0,
    );
  }
  db.exec("COMMIT");
}

function stubFetch() {
  globalThis.fetch = async () => ({
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
                  headline_ar: "عنوان",
                  headline_evidence: "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma.",
                  facts: [
                    { fact_ar: "حقيقة", evidence: "La festa e prevista sabato 12 settembre." },
                  ],
                  topic_ar: "افتتاح",
                }),
              },
            ],
          },
        ],
      };
    },
  });
}

async function measureOp(env, label, fn) {
  const log = env.DB.startRecording();
  await fn();
  env.DB.stopRecording();
  const report = env.DB.analyze(log);
  return { label, ...report };
}

function fmt(n) {
  return new Intl.NumberFormat("en-US").format(Math.round(n));
}

async function main() {
  const env = makeEnv();
  await boot(env);
  seedItems(env, ITEM_COUNT);
  stubFetch();

  const itemsRows = env.DB._tableRowCount("items");
  console.log(`\n=== D1 rows_read model — ${fmt(itemsRows)} items seeded ===\n`);

  const ops = [];
  const claimLog = env.DB.startRecording();
  await translatePending(env, 3, null);
  env.DB.stopRecording();
  ops.push({ label: "brief claim + summarize batch (all offices)", ...env.DB.analyze(claimLog) });

  // Capture the exact hot SQL the claim path issued, for plan inspection.
  const claimUpdate = claimLog.find((e) => /SET brief_claim_id = \?, brief_claimed_at/.test(e.sql))?.sql;
  const claimRead = claimLog.find((e) => /WHERE items\.brief_claim_id = \?/.test(e.sql))?.sql;
  const pendingCount = claimLog.find((e) => /COUNT\(\*\) AS pending/.test(e.sql))?.sql;

  // reset claims so the mayor-scoped claim can select rows again
  env.DB.exec("UPDATE items SET trans_engine='brief-pending', brief_claim_id=NULL, brief_attempts=0, brief_error=NULL");
  ops.push(
    await measureOp(env, "brief claim + summarize batch (one office)", async () => {
      await translatePending(env, 3, "seoul");
    }),
  );
  ops.push(
    await measureOp(env, "GET /api/stats", async () => {
      await worker.fetch(authed("/api/stats"), env);
    }),
  );
  ops.push(
    await measureOp(env, "GET /api/diagnostics", async () => {
      await worker.fetch(authed("/api/diagnostics"), env);
    }),
  );
  ops.push(
    await measureOp(env, "GET /api/health", async () => {
      await worker.fetch(new Request("https://d/api/health"), env);
    }),
  );

  console.log("=== EXPLAIN QUERY PLAN of the hot brief-claim statements ===\n");
  if (claimUpdate) {
    console.log("brief-claim selection (UPDATE ... WHERE id IN (SELECT ... ORDER BY ...)):");
    console.log(explain(env, claimUpdate) + "\n");
  }
  if (claimRead) {
    console.log("brief-claim readback (SELECT ... WHERE brief_claim_id = ?):");
    console.log(explain(env, claimRead) + "\n");
  }
  if (pendingCount) {
    console.log("pending brief count (SELECT COUNT(*) ...):");
    console.log(explain(env, pendingCount) + "\n");
  }

  const width = Math.max(...ops.map((o) => o.label.length));
  console.log(
    `${"operation".padEnd(width)}  ${"stmts".padStart(6)}  ${"rows_read".padStart(11)}  ${"itemScans".padStart(9)}  ${"correlated".padStart(10)}`,
  );
  for (const op of ops) {
    console.log(
      `${op.label.padEnd(width)}  ${String(op.statements).padStart(6)}  ${fmt(op.rowsRead).padStart(11)}  ${String(op.fullItemScans).padStart(9)}  ${String(op.correlatedSubqueries).padStart(10)}`,
    );
  }

  // Model one "search all offices" session while the operator watches progress
  // for ~3 minutes, comparing the old and new dashboard polling behaviour.
  const byLabel = Object.fromEntries(ops.map((o) => [o.label, o.rowsRead]));
  const perOffice = byLabel["brief claim + summarize batch (one office)"];
  const stats = byLabel["GET /api/stats"];
  const diag = byLabel["GET /api/diagnostics"];
  const offices = MAYORS.length;
  const journey = perOffice * offices;

  // Before: refreshAll every ~6s → 30 refreshes, each hitting stats + diagnostics.
  const oldPolling = 30 * (stats + diag);
  // After: refreshAll every ~30s → 6 refreshes, and diagnostics is not requested
  // unless its panel is open (default closed), so only stats runs.
  const newPolling = 6 * stats;

  console.log("\n--- modeled 'search all offices' session (~3 min watch) ---");
  console.log(`journey (12 offices × per-office claim/summarize): ${fmt(journey)} rows_read`);
  console.log(`OLD polling (30 refreshes × [stats+diagnostics]): ${fmt(oldPolling)} rows_read`);
  console.log(`NEW polling (6 refreshes × [stats only, diagnostics closed]): ${fmt(newPolling)} rows_read`);
  console.log(`OLD session total: ${fmt(journey + oldPolling)} rows_read`);
  console.log(`NEW session total: ${fmt(journey + newPolling)} rows_read`);
  console.log(
    `polling reduction: ${(100 * (1 - newPolling / (oldPolling || 1))).toFixed(1)}% ` +
      `(session ${(100 * (1 - (journey + newPolling) / (journey + oldPolling))).toFixed(1)}% lower)`,
  );
  console.log(`(D1 free daily limit is 5,000,000 rows_read)\n`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
