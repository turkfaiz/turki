import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ensureDb, enqueueAllOffices, enqueueManualSearch, maybeFinishMayor, processArticleFetchMessage, processSourcePollMessage } from "../src/worker.js";
import {
  fetchCandidate,
  pendingCandidateBacklog,
  pendingCandidateCount,
  pendingFetchIds,
  persistDiscovered,
} from "../src/pipeline.js";
import {
  CANDIDATE_FETCH_LEASE_MINUTES,
  LEASE_MIGRATION_ID,
  LEASE_MIGRATION_STATEMENTS,
  MAX_CANDIDATE_FETCH_ATTEMPTS,
  MAX_SOURCE_POLL_ATTEMPTS,
  SOURCE_POLL_LEASE_MINUTES,
  applyOfficialD1Migration,
  claimCandidateFetch,
  claimSourcePoll,
  completeCandidateFetch,
  sqlStatementsFrom,
} from "../src/leases.js";
import { createPairedTestD1, createTestD1 } from "./helpers/d1.js";
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

async function insertPendingCandidate(env, id = "cand-lease", url = "https://www.comune.torino.it/via-roma") {
  const mayor = MAYORS.find((row) => row.id === "turin");
  const source = sourcesFor("turin")[0];
  const persisted = await persistDiscovered(env, {
    mayor,
    source,
    scanId: "scan-cand",
    rows: [
      {
        url,
        title: "Via Roma",
        discovery_type: "rss",
      },
    ],
  });
  if (id !== persisted.newIds[0]) {
    env.DB.exec(`UPDATE candidates SET id = '${id}' WHERE id = '${persisted.newIds[0]}'`);
  }
  return env.DB.one(`SELECT * FROM candidates WHERE id = ?`, id);
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
    const row = pair.dbA.one(`SELECT status, claim_id, claimed_at FROM scan_sources WHERE scan_id = ?`, scanId);
    assert.equal(row.status, "polled");
    assert.equal(row.claim_id, null);
    assert.equal(row.claimed_at, null);
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
  const row = db.one(`SELECT status, last_error, claim_id, claimed_at FROM scan_sources WHERE scan_id = ?`, scanId);
  assert.equal(row.status, "polled");
  assert.equal(row.claim_id, null);
  assert.equal(row.claimed_at, null);
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
    const row = pair.dbA.one(`SELECT status, claim_id, claimed_at FROM scan_sources WHERE scan_id = ?`, scanId);
    assert.equal(row.status, "polled");
    assert.equal(row.claim_id, null);
    assert.equal(row.claimed_at, null);
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
      `SELECT fetch_status, fetch_claim_id, fetch_claimed_at, last_error FROM candidates WHERE id = ?`,
      candidate.id,
    );
    assert.equal(row.fetch_status, "fetched");
    assert.equal(row.fetch_claim_id, null);
    assert.equal(row.fetch_claimed_at, null);
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
    `SELECT fetch_status, last_error, fetch_after, fetch_claim_id, fetch_claimed_at FROM candidates WHERE id = ?`,
    candidate.id,
  );
  assert.equal(row.fetch_status, "failed");
  assert.equal(row.fetch_claim_id, null);
  assert.equal(row.fetch_claimed_at, null);
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
  const failed = db.one(`SELECT status, last_error, claim_id, claimed_at FROM scan_sources WHERE scan_id = ?`, scanId);
  assert.equal(failed.status, "failed");
  assert.ok(failed.last_error);
  assert.equal(failed.claim_id, null);
  assert.equal(failed.claimed_at, null);
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

function counts(db) {
  return {
    jobs: db.one(`SELECT COUNT(*) AS n FROM search_jobs`).n,
    tasks: db.one(`SELECT COUNT(*) AS n FROM search_job_tasks`).n,
    scans: db.one(`SELECT COUNT(*) AS n FROM scans`).n,
    scanSources: db.one(`SELECT COUNT(DISTINCT scan_id) AS n FROM scan_sources`).n,
  };
}

test("a stale candidate worker after a new claim cannot add items or bump counters", async () => {
  const pair = createPairedTestD1();
  try {
    const envA = leaseEnv(pair.dbA);
    const envB = leaseEnv(pair.dbB);
    await ensureDb(envA);
    await ensureDb(envB);
    const candidate = await insertPendingCandidate(envA);
    const before = pair.dbA.one(
      `SELECT IFNULL(read_count, 0) AS read_count, IFNULL(relevant_count, 0) AS relevant_count
       FROM sources WHERE id = ?`,
      SOURCE_ID,
    );
    let stolen = null;
    const result = await fetchCandidate(envA, candidate, {
      fetch: async () => response(200, ARTICLE_HTML),
      afterClaim: async () => {
        pair.dbA.exec(
          `UPDATE candidates
              SET fetch_claimed_at = datetime('now', '-${CANDIDATE_FETCH_LEASE_MINUTES + 1} minutes')
            WHERE id = '${candidate.id}'`,
        );
        stolen = await claimCandidateFetch(envB, candidate.id);
        assert.ok(stolen.fetch_claim_id);
      },
    });
    assert.equal(result.kind, "stale_claim");
    assert.equal(result.wrote, false);
    assert.equal(pair.dbA.one(`SELECT COUNT(*) AS n FROM items`).n, 0);
    const row = pair.dbA.one(
      `SELECT fetch_status, fetch_claim_id, last_error FROM candidates WHERE id = ?`,
      candidate.id,
    );
    assert.equal(row.fetch_status, "working");
    assert.equal(row.fetch_claim_id, stolen.fetch_claim_id);
    const after = pair.dbA.one(
      `SELECT IFNULL(read_count, 0) AS read_count, IFNULL(relevant_count, 0) AS relevant_count
       FROM sources WHERE id = ?`,
      SOURCE_ID,
    );
    assert.equal(after.read_count, before.read_count);
    assert.equal(after.relevant_count, before.relevant_count);
  } finally {
    pair.close();
  }
});

test("a stale source worker after a new claim cannot add candidates, health, or article_fetch", async () => {
  const pair = createPairedTestD1();
  try {
    const envA = leaseEnv(pair.dbA);
    const envB = leaseEnv(pair.dbB);
    await ensureDb(envA);
    await ensureDb(envB);
    const scanId = await seedQueuedSource(envA);
    const healthBefore = pair.dbA.one(
      `SELECT last_checked_at, last_status, IFNULL(discovered_count, 0) AS discovered_count
       FROM sources WHERE id = ?`,
      SOURCE_ID,
    );
    let stolen = null;
    const first = pollMessage(scanId);
    const result = await processSourcePollMessage(envA, first.message, {
      fetch: async () => rssOk(),
      afterClaim: async () => {
        pair.dbA.exec(
          `UPDATE scan_sources
              SET claimed_at = datetime('now', '-${SOURCE_POLL_LEASE_MINUTES + 1} minutes')
            WHERE scan_id = '${scanId}'`,
        );
        stolen = await claimSourcePoll(envB, { scanId, sourceId: SOURCE_ID, mayorId: "turin" });
        assert.ok(stolen?.claim_id);
      },
    });
    assert.equal(result.kind, "stale_claim");
    assert.equal(result.wrote, false);
    assert.equal(pair.dbA.one(`SELECT COUNT(*) AS n FROM candidates`).n, 0);
    const row = pair.dbA.one(`SELECT status, claim_id FROM scan_sources WHERE scan_id = ?`, scanId);
    assert.equal(row.status, "polling");
    assert.equal(row.claim_id, stolen.claim_id);
    const healthAfter = pair.dbA.one(
      `SELECT last_checked_at, last_status, IFNULL(discovered_count, 0) AS discovered_count
       FROM sources WHERE id = ?`,
      SOURCE_ID,
    );
    assert.equal(healthAfter.last_checked_at, healthBefore.last_checked_at);
    assert.equal(healthAfter.last_status, healthBefore.last_status);
    assert.equal(healthAfter.discovered_count, healthBefore.discovered_count);
    assert.equal(
      envA.SCAN_QUEUE.messages.filter((item) => (item.body || item).type === "article_fetch").length,
      0,
    );
  } finally {
    pair.close();
  }
});

test("two independent D1 connections cannot create two manual jobs for one office", async () => {
  const pair = createPairedTestD1();
  try {
    const queueA = fakeQueue();
    const queueB = fakeQueue();
    const envA = leaseEnv(pair.dbA, { SCAN_QUEUE: queueA });
    const envB = leaseEnv(pair.dbB, { SCAN_QUEUE: queueB });
    await ensureDb(envA);
    await ensureDb(envB);
    const [first, second] = await Promise.all([
      enqueueManualSearch(envA, { mayorId: "turin" }),
      enqueueManualSearch(envB, { mayorId: "turin" }),
    ]);
    const reused = [first, second].filter((row) => row.reused);
    const started = [first, second].filter((row) => !row.reused);
    assert.equal(started.length, 1);
    assert.equal(reused.length, 1);
    assert.equal(reused[0].jobId, started[0].jobId);
    assert.equal(reused[0].queued, 0);
    assert.ok(started[0].queued > 0);
    const tally = counts(pair.dbA);
    assert.equal(tally.jobs, 1);
    assert.equal(tally.scans, 1);
    assert.equal(tally.scanSources, 1);
    assert.equal(tally.tasks, 1);
    assert.equal(queueA.messages.length + queueB.messages.length, started[0].queued);
  } finally {
    pair.close();
  }
});

test("concurrent manual and weekly for the same office reuse one run", async () => {
  const pair = createPairedTestD1();
  try {
    const queueA = fakeQueue();
    const queueB = fakeQueue();
    const envA = leaseEnv(pair.dbA, { SCAN_QUEUE: queueA });
    const envB = leaseEnv(pair.dbB, { SCAN_QUEUE: queueB });
    await ensureDb(envA);
    await ensureDb(envB);
    const [manual, weekly] = await Promise.all([
      enqueueManualSearch(envA, { mayorId: "turin" }),
      enqueueAllOffices(envB, "weekly"),
    ]);
    const tally = counts(pair.dbA);
    assert.equal(tally.scans, 1, "overlapping weekly/manual must not create a second scan");
    assert.equal(tally.scanSources, 1);
    const winners = [manual, weekly].filter((row) => !row.reused);
    const losers = [manual, weekly].filter((row) => row.reused);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);
    assert.equal(losers[0].queued, 0);
    if (winners[0].jobId) {
      assert.equal(tally.jobs, 1);
      assert.equal(tally.tasks, 1);
    } else {
      assert.equal(tally.jobs, 0);
      assert.equal(tally.tasks, 0);
    }
    assert.equal(
      pair.dbA.one(`SELECT COUNT(*) AS n FROM search_jobs`).n,
      tally.jobs,
      "no orphan search_jobs",
    );
  } finally {
    pair.close();
  }
});

test("two concurrent all-offices searches create one scan and no orphan jobs", async () => {
  const pair = createPairedTestD1();
  try {
    const queueA = fakeQueue();
    const queueB = fakeQueue();
    const envA = leaseEnv(pair.dbA, { SCAN_QUEUE: queueA });
    const envB = leaseEnv(pair.dbB, { SCAN_QUEUE: queueB });
    await ensureDb(envA);
    await ensureDb(envB);
    const [first, second] = await Promise.all([
      enqueueAllOffices(envA, "weekly"),
      enqueueAllOffices(envB, "weekly"),
    ]);
    const reused = [first, second].filter((row) => row.reused);
    const started = [first, second].filter((row) => !row.reused);
    assert.equal(started.length, 1);
    assert.equal(reused.length, 1);
    assert.equal(reused[0].queued, 0);
    const tally = counts(pair.dbA);
    assert.equal(tally.scans, 1);
    assert.equal(tally.jobs, 0);
    assert.equal(tally.tasks, 0);
    assert.equal(tally.scanSources, 1);
  } finally {
    pair.close();
  }
});

test("candidate exception schedules a delayed continuation that closes the original run", async () => {
  const db = createTestD1();
  const queue = fakeQueue();
  const env = leaseEnv(db, { SCAN_QUEUE: queue });
  await ensureDb(env);
  const jobId = "job-retry-cont";
  const scanId = "scan-retry-cont";
  db.exec(`
    INSERT INTO scans (id, type, query, mayor_id, started_at, found_count)
    VALUES ('${scanId}', 'manual', '', 'turin', datetime('now'), 0);
    INSERT INTO search_jobs (id, query, mayor_id, status)
    VALUES ('${jobId}', '', 'turin', 'running');
    INSERT INTO search_job_tasks (job_id, mayor_id, status, stage, detail)
    VALUES ('${jobId}', 'turin', 'running', 'article_fetch', 'يفتح المقالات');
    INSERT INTO scan_sources (scan_id, source_id, mayor_id, job_id, status, detail, attempts)
    VALUES ('${scanId}', '${SOURCE_ID}', 'turin', '${jobId}', 'polled', 'ok', 1);
  `);
  const candidate = await insertPendingCandidate(env);
  db.exec(`UPDATE candidates SET id = 'cand-retry', scan_id = '${scanId}' WHERE id = '${candidate.id}'`);
  const events = { ack: 0, retries: [] };
  const message = {
    body: {
      type: "article_fetch",
      mayorId: "turin",
      scanId,
      jobId,
      candidateIds: ["cand-retry"],
    },
    attempts: 1,
    ack() {
      events.ack += 1;
    },
    retry(opts) {
      events.retries.push(opts || {});
    },
  };
  await processArticleFetchMessage(env, message, {
    fetch: async () => response(200, ARTICLE_HTML),
    afterClaim: async () => {
      throw new Error("worker_crash");
    },
  });
  assert.equal(events.ack, 1);
  assert.equal(events.retries.length, 0);
  const deferred = db.one(
    `SELECT fetch_status, fetch_after, fetch_claim_id FROM candidates WHERE id = 'cand-retry'`,
  );
  assert.equal(deferred.fetch_status, "retry");
  assert.ok(deferred.fetch_after);
  const delayed = queue.messages.filter((item) => (item.body || item).type === "article_fetch");
  assert.equal(delayed.length, 1);
  assert.ok(Number(delayed[0].delaySeconds) >= 10, `expected delayed retry, got ${delayed[0].delaySeconds}`);
  assert.equal(delayed[0].body.jobId, jobId);
  assert.equal(delayed[0].body.scanId, scanId);
  assert.equal(delayed[0].body.mayorId, "turin");

  db.exec(`UPDATE candidates SET fetch_after = datetime('now') WHERE id = 'cand-retry'`);
  const contEvents = { ack: 0, retries: [] };
  await processArticleFetchMessage(
    env,
    {
      ...delayed[0],
      attempts: 1,
      ack() {
        contEvents.ack += 1;
      },
      retry(opts) {
        contEvents.retries.push(opts || {});
      },
    },
    { fetch: async () => response(200, ARTICLE_HTML) },
  );
  assert.equal(contEvents.ack, 1);
  const fetched = db.one(`SELECT fetch_status, fetch_claim_id FROM candidates WHERE id = 'cand-retry'`);
  assert.equal(fetched.fetch_status, "fetched");
  assert.equal(fetched.fetch_claim_id, null);
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM items`).n, 1);
  const finish = await maybeFinishMayor(env, { mayorId: "turin", jobId, scanId });
  assert.equal(finish.done, true);
  const task = db.one(`SELECT job_id, status FROM search_job_tasks WHERE job_id = ?`, jobId);
  assert.equal(task.job_id, jobId);
  assert.notEqual(task.status, "queued");
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM search_jobs`).n, 1);

  await processArticleFetchMessage(
    env,
    {
      body: delayed[0].body,
      attempts: 1,
      ack() {},
      retry() {},
    },
    { fetch: async () => response(200, ARTICLE_HTML) },
  );
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM items`).n, 1, "completed items must not reopen");
  assert.equal(db.one(`SELECT fetch_status FROM candidates WHERE id = 'cand-retry'`).fetch_status, "fetched");
});

test("terminal source and candidate states clear ownership columns", async () => {
  const db = createTestD1();
  const env = leaseEnv(db);
  await ensureDb(env);
  const scanId = await seedQueuedSource(env);
  const polledMsg = pollMessage(scanId);
  await processSourcePollMessage(env, polledMsg.message, { fetch: async () => rssOk() });
  const polled = db.one(`SELECT status, claim_id, claimed_at FROM scan_sources WHERE scan_id = ?`, scanId);
  assert.equal(polled.status, "polled");
  assert.equal(polled.claim_id, null);
  assert.equal(polled.claimed_at, null);

  const failScan = await seedQueuedSource(env, "scan-fail-term");
  db.exec(`UPDATE scan_sources SET attempts = ${MAX_SOURCE_POLL_ATTEMPTS - 1} WHERE scan_id = '${failScan}'`);
  await processSourcePollMessage(env, pollMessage(failScan).message, {
    fetch: async () => response(503, "unavailable"),
  });
  const failed = db.one(`SELECT status, claim_id, claimed_at FROM scan_sources WHERE scan_id = ?`, failScan);
  assert.equal(failed.status, "failed");
  assert.equal(failed.claim_id, null);

  const fetchedCand = await insertPendingCandidate(env, "cand-term-fetched", "https://www.comune.torino.it/fetched");
  await fetchCandidate(env, fetchedCand, { fetch: async () => response(200, ARTICLE_HTML) });
  const fetched = db.one(
    `SELECT fetch_status, fetch_claim_id, fetch_claimed_at FROM candidates WHERE id = ?`,
    fetchedCand.id,
  );
  assert.equal(fetched.fetch_status, "fetched");
  assert.equal(fetched.fetch_claim_id, null);
  assert.equal(fetched.fetch_claimed_at, null);

  const skippedCand = await insertPendingCandidate(env, "cand-term-skipped", "https://www.comune.torino.it/skipped");
  db.exec(`UPDATE candidates SET url = 'https://www.comune.torino.it/not-modified' WHERE id = '${skippedCand.id}'`);
  const skippedClaim = await claimCandidateFetch(env, skippedCand.id);
  await completeCandidateFetch(env, skippedClaim, {
    fetch_status: "skipped",
    skip_reason: "not_modified",
  });
  const skipped = db.one(
    `SELECT fetch_status, fetch_claim_id, fetch_claimed_at FROM candidates WHERE id = ?`,
    skippedCand.id,
  );
  assert.equal(skipped.fetch_status, "skipped");
  assert.equal(skipped.fetch_claim_id, null);
  assert.equal(skipped.fetch_claimed_at, null);

  const failedCand = await insertPendingCandidate(env, "cand-term-failed", "https://www.comune.torino.it/failed");
  const failedClaim = await claimCandidateFetch(env, failedCand.id);
  await completeCandidateFetch(env, failedClaim, {
    fetch_status: "failed",
    skip_reason: "exception",
    last_error: "boom",
  });
  const failedRow = db.one(
    `SELECT fetch_status, fetch_claim_id, fetch_claimed_at FROM candidates WHERE id = ?`,
    failedCand.id,
  );
  assert.equal(failedRow.fetch_status, "failed");
  assert.equal(failedRow.fetch_claim_id, null);
  assert.equal(failedRow.fetch_claimed_at, null);
});

test("official 0020 upgrades a legacy schema via the wrangler ledger", async () => {
  const db = createTestD1();
  const env = leaseEnv(db);
  db.exec(`
    CREATE TABLE scan_sources (
      scan_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      mayor_id TEXT NOT NULL,
      job_id TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      detail TEXT,
      PRIMARY KEY (scan_id, source_id)
    );
    CREATE TABLE candidates (
      id TEXT PRIMARY KEY,
      mayor_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      scan_id TEXT,
      url TEXT NOT NULL,
      title TEXT,
      snippet TEXT,
      published_at TEXT,
      discovered_at TEXT NOT NULL,
      discovery_type TEXT,
      stage TEXT NOT NULL DEFAULT 'candidate_discovered',
      fetch_status TEXT NOT NULL DEFAULT 'pending',
      http_status INTEGER,
      skip_reason TEXT,
      etag TEXT,
      last_modified TEXT,
      fetched_at TEXT,
      attempts INTEGER DEFAULT 0
    );
    INSERT INTO scan_sources (scan_id, source_id, mayor_id, status, detail)
    VALUES ('scan-legacy', 'turin:comune.torino.it', 'turin', 'queued', 'keep-me');
    INSERT INTO candidates (
      id, mayor_id, source_id, scan_id, url, title, discovered_at, stage, fetch_status, attempts
    ) VALUES (
      'cand-legacy', 'turin', 'turin:comune.torino.it', 'scan-legacy',
      'https://www.comune.torino.it/legacy', 'Legacy', datetime('now'),
      'candidate_discovered', 'pending', 0
    );
  `);
  const sql = readFileSync(new URL("../migrations/0020_source_and_candidate_leases.sql", import.meta.url), "utf8");
  const first = await applyOfficialD1Migration(env, { id: LEASE_MIGRATION_ID, sql });
  assert.equal(first.applied, true);
  assert.equal(first.skipped, false);
  const scanCols = new Set(db.query(`PRAGMA table_info(scan_sources)`).map((c) => c.name));
  const candCols = new Set(db.query(`PRAGMA table_info(candidates)`).map((c) => c.name));
  for (const column of ["claim_id", "claimed_at", "attempts", "next_attempt_at", "last_error"]) {
    assert.ok(scanCols.has(column), `scan_sources.${column}`);
  }
  for (const column of ["fetch_claim_id", "fetch_claimed_at", "fetch_after", "last_error"]) {
    assert.ok(candCols.has(column), `candidates.${column}`);
  }
  assert.ok(db.query(`SELECT name FROM sqlite_master WHERE name = 'desk_run_locks'`).length);
  assert.equal(db.one(`SELECT detail FROM scan_sources WHERE scan_id = 'scan-legacy'`).detail, "keep-me");
  assert.equal(db.one(`SELECT title FROM candidates WHERE id = 'cand-legacy'`).title, "Legacy");
  const again = await applyOfficialD1Migration(env, { id: LEASE_MIGRATION_ID, sql });
  assert.equal(again.applied, false);
  assert.equal(again.skipped, true);
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM d1_migrations WHERE name = ?`, LEASE_MIGRATION_ID).n, 1);

  const raw = createTestD1();
  raw.exec(`
    CREATE TABLE scan_sources (
      scan_id TEXT NOT NULL, source_id TEXT NOT NULL, mayor_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', PRIMARY KEY (scan_id, source_id)
    );
    CREATE TABLE candidates (
      id TEXT PRIMARY KEY, mayor_id TEXT NOT NULL, source_id TEXT NOT NULL,
      url TEXT NOT NULL, discovered_at TEXT NOT NULL, stage TEXT NOT NULL,
      fetch_status TEXT NOT NULL
    );
  `);
  for (const statement of sqlStatementsFrom(sql)) {
    raw.exec(statement);
  }
  assert.throws(() => {
    for (const statement of sqlStatementsFrom(sql)) {
      raw.exec(statement);
    }
  }, /duplicate column|already exists/i);

  const empty = createTestD1();
  await assert.rejects(
    applyOfficialD1Migration(leaseEnv(empty), { id: LEASE_MIGRATION_ID, sql }),
    /no such table/i,
  );

  const workerSrc = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  assert.equal(workerSrc.includes("applyLeaseMigration"), false);
  assert.equal(workerSrc.includes("ALTER TABLE scan_sources ADD COLUMN"), false);
  assert.ok(sql.includes("does NOT bootstrap an empty database"));
  assert.equal(/DELETE\s+FROM/i.test(sql), false);
  assert.equal(/DROP\s+TABLE/i.test(sql), false);
  for (const statement of LEASE_MIGRATION_STATEMENTS.filter((item) => item.startsWith("ALTER") || item.startsWith("CREATE INDEX"))) {
    assert.ok(sql.includes(statement), statement);
  }
});

test("QWEN stays disabled in this change", async () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  assert.match(toml, /QWEN_ENABLED\s*=\s*"0"/);
});
