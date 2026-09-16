import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureDb, enqueueManualSearch, maybeFinishMayor, processSourcePollMessage } from "../src/worker.js";
import {
  fetchCandidate,
  pendingCandidateBacklog,
  pendingCandidateCount,
  pendingFetchIds,
  persistDiscovered,
} from "../src/pipeline.js";
import {
  CANDIDATE_FETCH_LEASE_MINUTES,
  LEASE_MIGRATION_STATEMENTS,
  MAX_CANDIDATE_FETCH_ATTEMPTS,
  MAX_SOURCE_POLL_ATTEMPTS,
  SOURCE_POLL_LEASE_MINUTES,
  applyLeaseMigration,
  claimCandidateFetch,
  claimSourcePoll,
  completeCandidateFetch,
} from "../src/leases.js";
import { createPairedTestD1, createTestD1 } from "./helpers/d1.js";
import { seedPopulatedDesk, snapshotProtected } from "./helpers/populatedDesk.js";
import { MAYORS } from "../src/mayors.js";
import { sourcesFor } from "../src/sources.js";

const SOURCE_ID = "turin:comune.torino.it";
const ARTICLE_HTML = `<html><head>
  <meta property="og:title" content="Stefano Lo Russo inaugura via Roma">
  <meta property="article:published_time" content="2026-09-13T10:00:00Z">
  <link rel="canonical" href="https://www.comune.torino.it/via-roma">
</head><body>
  <p>Stefano Lo Russo inaugura la nuova via pedonale di Via Roma con una festa sabato nel centro di Torino.</p>
  <p>Il sindaco ha spiegato i dettagli del progetto e il calendario dei lavori conclusi questa settimana.</p>
</body></html>`;

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        const hit = Object.entries(headers).find(
          ([key]) => key.toLowerCase() === name.toLowerCase(),
        );
        return hit ? String(hit[1]) : null;
      },
    },
    async text() {
      return body;
    },
  };
}

function rssOk() {
  return response(
    200,
    `<?xml version="1.0"?><rss><channel><item>
      <title>Lo Russo inaugura via Roma</title>
      <link>https://www.comune.torino.it/via-roma</link>
      <pubDate>Sun, 13 Sep 2026 10:00:00 GMT</pubDate>
    </item></channel></rss>`,
  );
}

function fakeQueue() {
  const messages = [];
  return {
    messages,
    async sendBatch(batch) {
      messages.push(...(batch || []));
    },
    async send(message) {
      messages.push(message);
    },
  };
}

function pollMessage(scanId, sourceId = SOURCE_ID) {
  const events = { ack: 0, retries: [] };
  return {
    events,
    message: {
      body: {
        type: "source_poll",
        mayorId: "turin",
        sourceId,
        scanId,
        query: "",
      },
      attempts: 1,
      ack() {
        events.ack += 1;
      },
      retry(opts) {
        events.retries.push(opts || {});
      },
    },
  };
}

function leaseEnv(db, overrides = {}) {
  return {
    DB: db,
    GEMINI_MODEL: "gemini-test",
    QWEN_ENABLED: "0",
    SCAN_QUEUE: fakeQueue(),
    ...overrides,
  };
}

async function seedQueuedSource(env, scanId = "scan-lease") {
  env.DB.exec(`
    INSERT INTO scans (id, type, query, mayor_id, started_at, found_count)
    VALUES ('${scanId}', 'manual', '', 'turin', datetime('now'), 0);
    INSERT INTO scan_sources (scan_id, source_id, mayor_id, status, detail, attempts)
    VALUES ('${scanId}', '${SOURCE_ID}', 'turin', 'queued', 'بانتظار فحص المصدر', 0);
  `);
  return scanId;
}

async function insertPendingCandidate(env, id = "cand-lease") {
  const mayor = MAYORS.find((row) => row.id === "turin");
  const source = sourcesFor("turin")[0];
  const persisted = await persistDiscovered(env, {
    mayor,
    source,
    scanId: "scan-cand",
    rows: [
      {
        url: "https://www.comune.torino.it/via-roma",
        title: "Via Roma",
        discovery_type: "rss",
      },
    ],
  });
  if (id !== persisted.newIds[0]) {
    env.DB.exec(`UPDATE candidates SET id = '${id}' WHERE id = '${persisted.newIds[0]}'`);
  }
  return env.DB.one(`SELECT * FROM candidates WHERE url LIKE '%via-roma'`);
}

test("two independent D1 consumers can claim one source only once and fetch once", async () => {
  const pair = createPairedTestD1();
  try {
    const envA = leaseEnv(pair.dbA);
    const envB = leaseEnv(pair.dbB);
    await ensureDb(envA);
    await ensureDb(envB);
    const scanId = await seedQueuedSource(envA);
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      await new Promise((resolve) => setTimeout(resolve, 40));
      return rssOk();
    };
    const first = pollMessage(scanId);
    const second = pollMessage(scanId);
    const [a, b] = await Promise.all([
      processSourcePollMessage(envA, first.message, { fetch: fetchImpl }),
      processSourcePollMessage(envB, second.message, { fetch: fetchImpl }),
    ]);
    const kinds = [a.kind, b.kind].sort();
    assert.deepEqual(kinds, ["polled", "retry_later"]);
    assert.equal(calls.length, 1, "exactly one external listing request");
    const row = pair.dbA.one(`SELECT status, claim_id FROM scan_sources WHERE scan_id = ?`, scanId);
    assert.equal(row.status, "polled");
    assert.ok(row.claim_id);
    assert.equal(first.events.ack + second.events.ack, 1);
  } finally {
    pair.close();
  }
});

test("a duplicate source_poll after success is a no-op without a second fetch", async () => {
  const db = createTestD1();
  const env = leaseEnv(db);
  await ensureDb(env);
  const scanId = await seedQueuedSource(env);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return rssOk();
  };
  const first = pollMessage(scanId);
  const second = pollMessage(scanId);
  const once = await processSourcePollMessage(env, first.message, { fetch: fetchImpl });
  const again = await processSourcePollMessage(env, second.message, { fetch: fetchImpl });
  assert.equal(once.kind, "polled");
  assert.equal(again.kind, "noop");
  assert.equal(again.status, "polled");
  assert.equal(calls.length, 1);
  assert.equal(second.events.ack, 1);
  assert.equal(second.events.retries.length, 0);
  const row = db.one(`SELECT status, last_error FROM scan_sources WHERE scan_id = ?`, scanId);
  assert.equal(row.status, "polled");
});

test("a dead source worker keeps the lease until it expires, then another worker finishes", async () => {
  const pair = createPairedTestD1();
  try {
    const envA = leaseEnv(pair.dbA);
    const envB = leaseEnv(pair.dbB);
    await ensureDb(envA);
    await ensureDb(envB);
    const scanId = await seedQueuedSource(envA);
    const claimed = await claimSourcePoll(envA, { scanId, sourceId: SOURCE_ID, mayorId: "turin" });
    assert.equal(claimed.status, "polling");
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return rssOk();
    };
    const blocked = pollMessage(scanId);
    const duringLease = await processSourcePollMessage(envB, blocked.message, { fetch: fetchImpl });
    assert.equal(duringLease.kind, "retry_later");
    assert.equal(calls.length, 0, "live lease must not start a second fetch");
    pair.dbA.exec(
      `UPDATE scan_sources
          SET claimed_at = datetime('now', '-${SOURCE_POLL_LEASE_MINUTES + 1} minutes')
        WHERE scan_id = '${scanId}'`,
    );
    const recovered = pollMessage(scanId);
    const after = await processSourcePollMessage(envB, recovered.message, { fetch: fetchImpl });
    assert.equal(after.kind, "polled");
    assert.equal(calls.length, 1);
    const row = pair.dbA.one(`SELECT status, claim_id FROM scan_sources WHERE scan_id = ?`, scanId);
    assert.equal(row.status, "polled");
    assert.notEqual(row.claim_id, claimed.claim_id);
  } finally {
    pair.close();
  }
});

test("an expired candidate lease is reclaimed and completed by a new worker", async () => {
  const pair = createPairedTestD1();
  try {
    const envA = leaseEnv(pair.dbA);
    const envB = leaseEnv(pair.dbB);
    await ensureDb(envA);
    await ensureDb(envB);
    const candidate = await insertPendingCandidate(envA);
    const stale = await claimCandidateFetch(envA, candidate.id);
    assert.equal(stale.fetch_status, "working");
    assert.ok(stale.fetch_claim_id);
    pair.dbA.exec(
      `UPDATE candidates
          SET fetch_claimed_at = datetime('now', '-${CANDIDATE_FETCH_LEASE_MINUTES + 1} minutes')
        WHERE id = '${candidate.id}'`,
    );
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      return response(200, ARTICLE_HTML);
    };
    const result = await fetchCandidate(envB, candidate, { fetch: fetchImpl });
    assert.equal(result.kind, "found");
    assert.equal(calls.length, 1);
    const row = pair.dbA.one(
      `SELECT fetch_status, fetch_claim_id, last_error FROM candidates WHERE id = ?`,
      candidate.id,
    );
    assert.equal(row.fetch_status, "fetched");
    const staleWrite = await completeCandidateFetch(envA, stale, {
      fetch_status: "failed",
      skip_reason: "stale_owner",
      last_error: "should_not_write",
    });
    assert.equal(staleWrite, false);
    const after = pair.dbA.one(`SELECT fetch_status, last_error FROM candidates WHERE id = ?`, candidate.id);
    assert.equal(after.fetch_status, "fetched");
    assert.notEqual(after.last_error, "should_not_write");
  } finally {
    pair.close();
  }
});

test("an exception after a candidate becomes working retries with fetch_after", async () => {
  const db = createTestD1();
  const env = leaseEnv(db);
  await ensureDb(env);
  const candidate = await insertPendingCandidate(env);
  const result = await fetchCandidate(env, candidate, {
    fetch: async () => response(200, ARTICLE_HTML),
    afterClaim: async () => {
      throw new Error("worker_crash");
    },
  });
  assert.equal(result.kind, "retry");
  const row = db.one(
    `SELECT fetch_status, fetch_after, last_error, fetch_claim_id FROM candidates WHERE id = ?`,
    candidate.id,
  );
  assert.equal(row.fetch_status, "retry");
  assert.ok(row.fetch_after, "retry must carry a future fetch_after");
  assert.match(row.last_error, /worker_crash/);
  assert.equal(row.fetch_claim_id, null);
  const wait = db.one(
    `SELECT CAST((julianday(fetch_after) - julianday('now')) * 86400 AS INTEGER) AS s
     FROM candidates WHERE id = ?`,
    candidate.id,
  ).s;
  assert.ok(wait > 0, `fetch_after must be in the future, got ${wait}s`);
});

test("exhausted candidate exceptions become terminal failed with last_error", async () => {
  const db = createTestD1();
  const env = leaseEnv(db);
  await ensureDb(env);
  const candidate = await insertPendingCandidate(env);
  db.exec(
    `UPDATE candidates SET attempts = ${MAX_CANDIDATE_FETCH_ATTEMPTS - 1} WHERE id = '${candidate.id}'`,
  );
  const result = await fetchCandidate(env, candidate, {
    fetch: async () => response(200, ARTICLE_HTML),
    afterClaim: async () => {
      throw new Error("disk_full");
    },
  });
  assert.equal(result.kind, "failed");
  const row = db.one(
    `SELECT fetch_status, last_error, fetch_after FROM candidates WHERE id = ?`,
    candidate.id,
  );
  assert.equal(row.fetch_status, "failed");
  assert.match(row.last_error, /disk_full/);
  db.exec(`
    INSERT INTO scans (id, type, query, mayor_id, started_at, found_count)
    VALUES ('scan-cand', 'manual', '', 'turin', datetime('now'), 0);
    INSERT INTO scan_sources (scan_id, source_id, mayor_id, status, detail)
    VALUES ('scan-cand', '${SOURCE_ID}', 'turin', 'polled', 'ok');
  `);
  const finish = await maybeFinishMayor(env, {
    mayorId: "turin",
    jobId: null,
    scanId: "scan-cand",
  });
  assert.equal(finish.done, true, "terminal failed candidates must not block scan close");
});

test("pending count and fetch ids stay aligned, with next_at when deferred", async () => {
  const db = createTestD1();
  const env = leaseEnv(db);
  await ensureDb(env);
  const candidate = await insertPendingCandidate(env);
  assert.equal(await pendingCandidateCount(env, "turin", "scan-cand"), 1);
  assert.deepEqual(await pendingFetchIds(env, { mayorId: "turin", scanId: "scan-cand" }), [
    candidate.id,
  ]);

  await claimCandidateFetch(env, candidate.id);
  const live = await pendingCandidateBacklog(env, "turin", "scan-cand");
  assert.equal(live.pending, 1);
  assert.deepEqual(live.ids, []);
  assert.ok(live.nextAt, "a live working lease must expose a future next_at");

  db.exec(
    `UPDATE candidates
        SET fetch_status = 'retry',
            fetch_claim_id = NULL,
            fetch_claimed_at = NULL,
            fetch_after = datetime('now', '+15 minutes')
      WHERE id = '${candidate.id}'`,
  );
  const deferred = await pendingCandidateBacklog(env, "turin", "scan-cand");
  assert.equal(deferred.pending, 1);
  assert.deepEqual(deferred.ids, []);
  assert.ok(deferred.nextAt);
});

test("a temporary source failure retries instead of acking success, then fails terminally", async () => {
  const db = createTestD1();
  const env = leaseEnv(db);
  await ensureDb(env);
  const scanId = await seedQueuedSource(env);
  const failing = async () => response(503, "unavailable");
  const first = pollMessage(scanId);
  const once = await processSourcePollMessage(env, first.message, { fetch: failing });
  assert.equal(once.kind, "retrying");
  assert.equal(first.events.ack, 0);
  assert.ok(first.events.retries.length >= 1);
  const retrying = db.one(`SELECT status, next_attempt_at, last_error, attempts FROM scan_sources WHERE scan_id = ?`, scanId);
  assert.equal(retrying.status, "retrying");
  assert.ok(retrying.next_attempt_at);
  assert.ok(retrying.last_error);

  const notDone = await maybeFinishMayor(env, { mayorId: "turin", jobId: null, scanId });
  assert.equal(notDone.done, false, "retrying must not close the scan");

  db.exec(
    `UPDATE scan_sources
        SET attempts = ${MAX_SOURCE_POLL_ATTEMPTS - 1},
            status = 'queued',
            next_attempt_at = NULL
      WHERE scan_id = '${scanId}'`,
  );
  const last = pollMessage(scanId);
  const terminal = await processSourcePollMessage(env, last.message, { fetch: failing });
  assert.equal(terminal.kind, "failed");
  const failed = db.one(`SELECT status, last_error FROM scan_sources WHERE scan_id = ?`, scanId);
  assert.equal(failed.status, "failed");
  assert.ok(failed.last_error);
  const done = await maybeFinishMayor(env, { mayorId: "turin", jobId: null, scanId });
  assert.equal(done.done, true, "terminal failed sources must not hang closure");
});

test("a stale candidate claim id cannot overwrite a newer claim", async () => {
  const db = createTestD1();
  const env = leaseEnv(db);
  await ensureDb(env);
  const candidate = await insertPendingCandidate(env);
  const first = await claimCandidateFetch(env, candidate.id);
  db.exec(
    `UPDATE candidates
        SET fetch_claimed_at = datetime('now', '-${CANDIDATE_FETCH_LEASE_MINUTES + 1} minutes')
      WHERE id = '${candidate.id}'`,
  );
  const second = await claimCandidateFetch(env, candidate.id);
  assert.ok(second.fetch_claim_id);
  assert.notEqual(second.fetch_claim_id, first.fetch_claim_id);
  const wrote = await completeCandidateFetch(env, first, {
    fetch_status: "fetched",
    skip_reason: "stale",
    last_error: "old-owner",
  });
  assert.equal(wrote, false);
  const row = db.one(`SELECT fetch_status, fetch_claim_id, last_error FROM candidates WHERE id = ?`, candidate.id);
  assert.equal(row.fetch_status, "working");
  assert.equal(row.fetch_claim_id, second.fetch_claim_id);
  assert.notEqual(row.last_error, "old-owner");
});

test("two independent D1 consumers fetch one candidate only once", async () => {
  const pair = createPairedTestD1();
  try {
    const envA = leaseEnv(pair.dbA);
    const envB = leaseEnv(pair.dbB);
    await ensureDb(envA);
    await ensureDb(envB);
    const candidate = await insertPendingCandidate(envA);
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      await new Promise((resolve) => setTimeout(resolve, 40));
      return response(200, ARTICLE_HTML);
    };
    const [first, second] = await Promise.all([
      fetchCandidate(envA, candidate, { fetch: fetchImpl }),
      fetchCandidate(envB, candidate, { fetch: fetchImpl }),
    ]);
    const kinds = [first.kind, second.kind].sort();
    assert.ok(kinds.includes("found"));
    assert.ok(kinds.includes("skipped_claimed"));
    assert.equal(calls.length, 1, "exactly one article fetch");
    assert.equal(pair.dbA.one(`SELECT COUNT(*) AS n FROM items`).n, 1);
  } finally {
    pair.close();
  }
});

test("pressing search twice while a desk run is active reuses the run without a second poll", async () => {
  const db = createTestD1();
  const queue = fakeQueue();
  const env = leaseEnv(db, { SCAN_QUEUE: queue });
  await ensureDb(env);
  const first = await enqueueManualSearch(env, { mayorId: "turin" });
  assert.ok(first.jobId);
  assert.ok(first.queued > 0);
  const queued = queue.messages.length;
  const second = await enqueueManualSearch(env, { mayorId: "turin" });
  assert.equal(second.reused, true);
  assert.equal(second.jobId, first.jobId);
  assert.equal(second.queued, 0);
  assert.equal(queue.messages.length, queued, "no extra source_poll messages");
});

test("lease migration is additive, re-runnable, and does not delete protected rows", async () => {
  const db = createTestD1();
  const env = leaseEnv(db);
  await ensureDb(env);
  seedPopulatedDesk(db);
  const before = snapshotProtected(db);
  await applyLeaseMigration(env);
  await applyLeaseMigration(env);
  assert.deepEqual(snapshotProtected(db), before);
  const scanCols = new Set(db.query(`PRAGMA table_info(scan_sources)`).map((c) => c.name));
  const candCols = new Set(db.query(`PRAGMA table_info(candidates)`).map((c) => c.name));
  for (const column of ["claim_id", "claimed_at", "attempts", "next_attempt_at", "last_error"]) {
    assert.ok(scanCols.has(column), `scan_sources.${column}`);
  }
  for (const column of ["fetch_claim_id", "fetch_claimed_at", "fetch_after", "last_error"]) {
    assert.ok(candCols.has(column), `candidates.${column}`);
  }
  const sql = readFileSync(new URL("../migrations/0020_source_and_candidate_leases.sql", import.meta.url), "utf8");
  assert.equal(/DELETE\s+FROM/i.test(sql), false);
  assert.equal(/DROP\s+TABLE/i.test(sql), false);
  for (const statement of LEASE_MIGRATION_STATEMENTS) {
    assert.ok(sql.includes(statement), statement);
  }
});

test("QWEN stays disabled in this change", async () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /QWEN_ENABLED\s*=\s*"0"/);
});
