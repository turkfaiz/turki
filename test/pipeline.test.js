import test from "node:test";
import assert from "node:assert/strict";
import { ensureDb } from "../src/worker.js";
import { createTestD1 } from "./helpers/d1.js";
import {
  fetchCandidateBatch,
  persistDiscovered,
  runScan,
} from "../src/pipeline.js";
import { MAYORS } from "../src/mayors.js";
import { sourcesFor } from "../src/sources.js";

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
    rows: [
      {
        url: "https://www.comune.torino.it/via-roma",
        title: "Via Roma",
        discovery_type: "rss",
      },
    ],
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
    rows: [{ url: "https://www.comune.torino.it/via-roma", title: "Via Roma", discovery_type: "rss" }],
  });
  db.exec(`UPDATE candidates SET fetch_status = 'fetched' WHERE url LIKE '%via-roma'`);
  const again = await persistDiscovered(env, {
    mayor,
    source,
    scanId: "scan-2",
    rows: [{ url: "https://www.comune.torino.it/via-roma", title: "Via Roma again", discovery_type: "rss" }],
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
    rows: [{ url: "https://www.comune.torino.it/via-roma", title: "Via Roma", discovery_type: "rss" }],
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
  const rows = [1, 2, 3, 4].map((n) => ({
    url: `https://www.comune.torino.it/story-${n}`,
    title: `Stefano Lo Russo story ${n}`,
    discovery_type: "rss",
  }));
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
