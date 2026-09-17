import test from "node:test";
import assert from "node:assert/strict";
import { ensureDb } from "../src/worker.js";
import { createTestD1 } from "./helpers/d1.js";
import {
  fetchCandidateBatch,
  isFreshDiscoveryRow,
  pendingCandidateCount,
  pendingFetchIds,
  persistDiscovered,
  runScan,
} from "../src/pipeline.js";
import { MAYORS } from "../src/mayors.js";
import {
  MAX_CANDIDATES_PER_SOURCE_POLL,
  MAX_PENDING_CANDIDATES_PER_SOURCE,
  sourcesFor,
} from "../src/sources.js";

function envWith(overrides = {}) {
  const db = createTestD1();
  return { db, env: { DB: db, GEMINI_MODEL: "gemini-test", ...overrides } };
}

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

const THIS_WEEK = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();

function freshRow(overrides = {}) {
  return {
    url: "https://www.comune.torino.it/via-roma",
    title: "Via Roma",
    published_at: THIS_WEEK,
    discovery_type: "rss",
    ...overrides,
  };
}

const ARTICLE_HTML = `<html><head>
  <meta property="og:title" content="Stefano Lo Russo inaugura via Roma">
  <meta property="article:published_time" content="2026-09-13T10:00:00Z">
  <link rel="canonical" href="https://www.comune.torino.it/via-roma">
</head><body>
  <p>Stefano Lo Russo inaugura la nuova via pedonale di Via Roma con una festa sabato nel centro di Torino.</p>
  <p>Il sindaco ha spiegato i dettagli del progetto e il calendario dei lavori conclusi questa settimana.</p>
</body></html>`;

test("discovered links are stored before the article is opened", async () => {
  const { db, env } = envWith();
  await ensureDb(env);
  const mayor = MAYORS.find((row) => row.id === "turin");
  const source = sourcesFor("turin")[0];
  const persisted = await persistDiscovered(env, {
    mayor,
    source,
    scanId: "scan-1",
    rows: [freshRow()],
  });
  assert.equal(persisted.inserted, 1);
  const candidate = db.one(`SELECT fetch_status, stage FROM candidates WHERE url LIKE '%via-roma'`);
  assert.equal(candidate.fetch_status, "pending");
  assert.equal(candidate.stage, "candidate_discovered");
});

test("old urls are not reopened", async () => {
  const { db, env } = envWith();
  await ensureDb(env);
  const mayor = MAYORS.find((row) => row.id === "turin");
  const source = sourcesFor("turin")[0];
  await persistDiscovered(env, {
    mayor,
    source,
    scanId: "scan-1",
    rows: [freshRow()],
  });
  db.exec(`UPDATE candidates SET fetch_status = 'fetched' WHERE url LIKE '%via-roma'`);
  const again = await persistDiscovered(env, {
    mayor,
    source,
    scanId: "scan-2",
    rows: [freshRow({ title: "Via Roma again" })],
  });
  assert.equal(again.inserted, 0);
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM candidates`).n, 1);
});

test("dated urls older than the week window are not queued again", async () => {
  const { db, env } = envWith();
  await ensureDb(env);
  const mayor = MAYORS.find((row) => row.id === "turin");
  const source = sourcesFor("turin")[0];
  const persisted = await persistDiscovered(env, {
    mayor,
    source,
    scanId: "scan-old",
    rows: [
      {
        url: "https://www.comune.torino.it/old-story",
        title: "Old",
        published_at: "2020-01-01T00:00:00Z",
        discovery_type: "rss",
      },
    ],
  });
  assert.equal(persisted.inserted, 0);
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM candidates`).n, 0);
});

test("article fetch runs on a claimed candidate and does not duplicate", async () => {
  const { db, env } = envWith();
  await ensureDb(env);
  const mayor = MAYORS.find((row) => row.id === "turin");
  const source = sourcesFor("turin")[0];
  const persisted = await persistDiscovered(env, {
    mayor,
    source,
    scanId: "scan-1",
    rows: [freshRow()],
  });
  const fetchImpl = async () => response(200, ARTICLE_HTML);
  const first = await fetchCandidateBatch(env, {
    ids: persisted.newIds,
    fetch: fetchImpl,
  });
  assert.equal(first.opened, 1);
  assert.equal(first.found, 1);
  const second = await fetchCandidateBatch(env, {
    ids: persisted.newIds,
    fetch: fetchImpl,
  });
  assert.equal(second.processed, 0);
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM items`).n, 1);
});

test("article fetches are split into independent batches", async () => {
  const { env } = envWith();
  await ensureDb(env);
  const mayor = MAYORS.find((row) => row.id === "turin");
  const source = sourcesFor("turin")[0];
  const rows = [1, 2, 3, 4].map((n) =>
    freshRow({
      url: `https://www.comune.torino.it/story-${n}`,
      title: `Stefano Lo Russo story ${n}`,
    }),
  );
  const persisted = await persistDiscovered(env, { mayor, source, scanId: "scan-1", rows });
  assert.equal(persisted.newIds.length, 4);
  const fetchImpl = async (url) =>
    response(
      200,
      ARTICLE_HTML.replace("via-roma", String(url).split("/").at(-1)).replace(
        "Via Roma",
        String(url).split("/").at(-1),
      ),
    );
  const first = await fetchCandidateBatch(env, {
    ids: persisted.newIds.slice(0, 3),
    limit: 3,
    fetch: fetchImpl,
  });
  assert.equal(first.processed, 3);
  const leftover = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM candidates WHERE fetch_status = 'pending'`,
  ).first();
  assert.equal(Number(leftover.n), 1);
});

test("a failing source does not stop the rest of the desk scan", async () => {
  const { env } = envWith();
  await ensureDb(env);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.includes("comune.torino.it")) return response(403, "no");
    if (target.includes("torinoclick") || target.includes("repubblica")) {
      return response(
        200,
        `<?xml version="1.0"?><rss><channel><item>
          <title>Lo Russo in consiglio</title>
          <link>${target.includes("repubblica") ? "https://torino.repubblica.it/2026/a" : "https://www.torinoclick.it/2026/a"}</link>
          <pubDate>Sun, 13 Sep 2026 10:00:00 GMT</pubDate>
        </item></channel></rss>`,
      );
    }
    return response(404, "missing");
  };
  try {
    const result = await runScan(env, { type: "manual", mayorId: "turin" });
    const official = result.sourceHealth.find((row) => row.id === "turin:comune.torino.it");
    const press = result.sourceHealth.find((row) => row.id === "turin:torino.repubblica.it");
    assert.equal(official.ok, false);
    assert.equal(press.ok, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a discovery row without a parseable date is not fresh", () => {
  assert.equal(isFreshDiscoveryRow({ published_at: "" }), false);
  assert.equal(isFreshDiscoveryRow({ published_at: "not-a-date" }), false);
  assert.equal(isFreshDiscoveryRow({ published_at: "2020-01-01T00:00:00Z" }), false);
  assert.equal(isFreshDiscoveryRow({ published_at: THIS_WEEK }), true);
});

test("undated sitemap dumps are not inserted as candidates", async () => {
  const { db, env } = envWith();
  await ensureDb(env);
  const mayor = MAYORS.find((row) => row.id === "turin");
  const source = sourcesFor("turin")[0];
  const rows = Array.from({ length: 80 }, (_, n) => ({
    url: `https://www.comune.torino.it/archive/${n}`,
    title: `Archive ${n}`,
    published_at: "",
    discovery_type: "sitemap",
  }));
  const persisted = await persistDiscovered(env, {
    mayor,
    source,
    scanId: "scan-undated",
    rows,
  });
  assert.equal(persisted.inserted, 0);
  assert.equal(persisted.skippedUndated, 80);
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM candidates`).n, 0);
});

test("one source poll inserts at most the per-poll candidate cap", async () => {
  const { db, env } = envWith();
  await ensureDb(env);
  const mayor = MAYORS.find((row) => row.id === "turin");
  const source = sourcesFor("turin")[0];
  const rows = Array.from({ length: 80 }, (_, n) =>
    freshRow({
      url: `https://www.comune.torino.it/week-${n}`,
      title: `Lo Russo week ${n}`,
    }),
  );
  const persisted = await persistDiscovered(env, {
    mayor,
    source,
    scanId: "scan-cap",
    rows,
  });
  assert.equal(persisted.inserted, MAX_CANDIDATES_PER_SOURCE_POLL);
  assert.equal(persisted.skippedCap, 80 - MAX_CANDIDATES_PER_SOURCE_POLL);
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM candidates`).n, MAX_CANDIDATES_PER_SOURCE_POLL);
});

test("pending fresh candidates per source stay under the backlog cap", async () => {
  const { db, env } = envWith();
  await ensureDb(env);
  const mayor = MAYORS.find((row) => row.id === "turin");
  const source = sourcesFor("turin")[0];
  const first = Array.from({ length: MAX_PENDING_CANDIDATES_PER_SOURCE }, (_, n) =>
    freshRow({
      url: `https://www.comune.torino.it/pending-${n}`,
      title: `Pending ${n}`,
    }),
  );
  const firstPass = await persistDiscovered(env, {
    mayor,
    source,
    scanId: "scan-pending-a",
    rows: first,
  });
  assert.equal(firstPass.inserted, MAX_CANDIDATES_PER_SOURCE_POLL);
  const second = Array.from({ length: MAX_PENDING_CANDIDATES_PER_SOURCE }, (_, n) =>
    freshRow({
      url: `https://www.comune.torino.it/pending-b-${n}`,
      title: `Pending b ${n}`,
    }),
  );
  const secondPass = await persistDiscovered(env, {
    mayor,
    source,
    scanId: "scan-pending-b",
    rows: second,
  });
  assert.equal(
    secondPass.inserted,
    MAX_PENDING_CANDIDATES_PER_SOURCE - MAX_CANDIDATES_PER_SOURCE_POLL,
  );
  const third = await persistDiscovered(env, {
    mayor,
    source,
    scanId: "scan-pending-c",
    rows: [
      freshRow({
        url: "https://www.comune.torino.it/pending-overflow",
        title: "Overflow",
      }),
    ],
  });
  assert.equal(third.inserted, 0);
  assert.equal(third.skippedCap, 1);
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM candidates`).n, MAX_PENDING_CANDIDATES_PER_SOURCE);
});

test("urls already stored as items are not re-queued", async () => {
  const { db, env } = envWith();
  await ensureDb(env);
  const mayor = MAYORS.find((row) => row.id === "turin");
  const source = sourcesFor("turin")[0];
  db.exec(`
    INSERT INTO items (
      id, mayor_id, source, title, title_normalized, url, published_at, snippet,
      language, confidence, status, fingerprint
    ) VALUES (
      'item-1', 'turin', 'official', 'Via Roma', 'via roma',
      'https://www.comune.torino.it/via-roma', datetime('now','-1 days'), 'snippet',
      'it', 'official', 'inbox', 'fp-via-roma'
    )
  `);
  const persisted = await persistDiscovered(env, {
    mayor,
    source,
    scanId: "scan-item",
    rows: [freshRow()],
  });
  assert.equal(persisted.inserted, 0);
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM candidates`).n, 0);
});

test("stale archive candidates are not selected for fetch and do not block the count", async () => {
  const { db, env } = envWith();
  await ensureDb(env);
  const source = sourcesFor("turin")[0];
  db.exec(`
    INSERT INTO candidates (
      id, mayor_id, source_id, scan_id, url, title, published_at, discovered_at,
      discovery_type, stage, fetch_status, attempts
    ) VALUES
    ('old-1', 'turin', '${source.id}', 'scan-old', 'https://www.comune.torino.it/old-1', 'Old',
      NULL, datetime('now','-2 days'), 'sitemap', 'candidate_discovered', 'pending', 0),
    ('old-2', 'turin', '${source.id}', 'scan-old', 'https://www.comune.torino.it/old-2', 'Stale',
      '2020-01-01T00:00:00Z', datetime('now','-2 days'), 'sitemap', 'candidate_discovered', 'pending', 0),
    ('fresh-1', 'turin', '${source.id}', 'scan-new', 'https://www.comune.torino.it/fresh-1', 'Fresh',
      '${THIS_WEEK}', datetime('now','-1 hours'), 'rss', 'candidate_discovered', 'pending', 0)
  `);
  const ids = await pendingFetchIds(env, { mayorId: "turin", limit: 10 });
  assert.deepEqual(ids, ["fresh-1"]);
  assert.equal(await pendingCandidateCount(env, "turin", "scan-old"), 0);
  assert.equal(await pendingCandidateCount(env, "turin", "scan-new"), 1);

  let fetched = 0;
  const summary = await fetchCandidateBatch(env, {
    ids: ["old-1", "old-2", "fresh-1"],
    fetch: async () => {
      fetched += 1;
      return response(200, ARTICLE_HTML.replace("via-roma", "fresh-1"));
    },
  });
  assert.equal(summary.skippedStale, 2);
  assert.equal(fetched, 1);
  assert.equal(db.one(`SELECT fetch_status FROM candidates WHERE id = 'old-1'`).fetch_status, "pending");
});

test("archive rows already pending do not consume the fresh backlog cap", async () => {
  const { db, env } = envWith();
  await ensureDb(env);
  const mayor = MAYORS.find((row) => row.id === "turin");
  const source = sourcesFor("turin")[0];
  const archiveValues = Array.from({ length: 50 }, (_, n) =>
    `('arch-${n}', 'turin', '${source.id}', 'scan-arch', 'https://www.comune.torino.it/arch-${n}', 'Arch ${n}',
      NULL, datetime('now','-3 days'), 'sitemap', 'candidate_discovered', 'pending', 0)`,
  ).join(",\n");
  db.exec(`
    INSERT INTO candidates (
      id, mayor_id, source_id, scan_id, url, title, published_at, discovered_at,
      discovery_type, stage, fetch_status, attempts
    ) VALUES ${archiveValues}
  `);
  const persisted = await persistDiscovered(env, {
    mayor,
    source,
    scanId: "scan-fresh-after-arch",
    rows: [freshRow({ url: "https://www.comune.torino.it/after-archive", title: "After archive" })],
  });
  assert.equal(persisted.inserted, 1);
  assert.equal(
    db.one(`SELECT COUNT(*) AS n FROM candidates WHERE published_at IS NOT NULL`).n,
    1,
  );
});
