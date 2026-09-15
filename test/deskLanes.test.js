import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import worker, { ensureDb } from "../src/worker.js";
import {
  applyDeskLaneMigration,
  DESK_LANES,
  planDeskLaneMigration,
  resolveDeskQuery,
} from "../src/deskLanes.js";
import { createTestD1 } from "./helpers/d1.js";
import { seedPopulatedDesk, snapshotProtected } from "./helpers/populatedDesk.js";

function envWith(db, overrides = {}) {
  return { DB: db, GEMINI_MODEL: "gemini-test", AI_MIN_INTERVAL_MS: "0", AI_DAILY_LIMIT: "1000", ...overrides };
}

function request(path) {
  return new Request(`https://mayor-watch.test${path}`, {
    headers: { "content-type": "application/json" },
  });
}

test("inbox and waiting aliases map to decision_ready and reading", () => {
  assert.deepEqual(resolveDeskQuery("inbox"), {
    kind: "lane",
    value: DESK_LANES.DECISION_READY,
    requested: "inbox",
  });
  assert.deepEqual(resolveDeskQuery("waiting"), {
    kind: "lane",
    value: DESK_LANES.READING,
    requested: "waiting",
  });
  assert.equal(resolveDeskQuery("approved").kind, "status");
  assert.equal(resolveDeskQuery("nope").kind, "invalid");
});

test("a completed trans_engine is not decision-ready without a passed current version", async () => {
  const db = createTestD1();
  const env = envWith(db);
  await ensureDb(env);
  seedPopulatedDesk(db);

  const inbox = await worker.fetch(request("/api/items?status=inbox"), env).then((res) => res.json());
  const ready = await worker
    .fetch(request("/api/items?status=decision_ready"), env)
    .then((res) => res.json());
  const reading = await worker.fetch(request("/api/items?status=reading"), env).then((res) => res.json());
  const verifying = await worker
    .fetch(request("/api/items?status=verifying"), env)
    .then((res) => res.json());
  const attention = await worker
    .fetch(request("/api/items?status=attention_required"), env)
    .then((res) => res.json());
  const waiting = await worker.fetch(request("/api/items?status=waiting"), env).then((res) => res.json());

  assert.deepEqual(
    inbox.items.map((row) => row.id),
    ["item-ready"],
    "inbox now means decision_ready, not every unread row",
  );
  assert.deepEqual(ready.items.map((row) => row.id), ["item-ready"]);
  assert.deepEqual(reading.items.map((row) => row.id), ["item-reading"]);
  assert.deepEqual(verifying.items.map((row) => row.id), ["item-verifying"]);
  assert.deepEqual(attention.items.map((row) => row.id).sort(), ["item-exhausted", "item-failed", "item-legacy-engine"]);
  assert.deepEqual(waiting.items.map((row) => row.id), ["item-reading"]);
  assert.equal(
    inbox.items.some((row) => row.id === "item-legacy-engine"),
    false,
    "a completed engine without a version never enters the decision lane",
  );
  assert.equal(
    ready.items.some((row) => row.id === "item-stale-ready"),
    false,
    "a passed version outside the display window stays out of decision_ready",
  );
});

test("stats expose the four operational lanes and keep inbox as the decision alias", async () => {
  const db = createTestD1();
  const env = envWith(db);
  await ensureDb(env);
  seedPopulatedDesk(db);

  const stats = await worker.fetch(request("/api/stats"), env).then((res) => res.json());
  assert.equal(stats.reading, 1);
  assert.equal(stats.verifying, 1);
  assert.equal(stats.decision_ready, 1);
  assert.equal(stats.attention_required, 3);
  assert.equal(stats.inbox, 1);
  assert.equal(stats.waiting, 1);
  assert.equal(stats.approved, 1);

  const turin = stats.byMayor.find((row) => row.mayor_id === "turin");
  assert.equal(turin.decision_ready, 1);
  assert.equal(turin.reading, 1);
  assert.equal(turin.verifying, 1);
});

test("dry-run reports row movement without deleting or applying", async () => {
  const db = createTestD1();
  const env = envWith(db);
  await ensureDb(env);
  seedPopulatedDesk(db);
  db.exec(`UPDATE items SET desk_lane = NULL, desk_attention_reason = NULL`);

  const before = snapshotProtected(db);
  const plan = await planDeskLaneMigration(env);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.applied, false);
  assert.deepEqual(plan.wouldDelete, {
    items: 0,
    approvals: 0,
    brief_versions: 0,
    scans: 0,
    jobs: 0,
    sources: 0,
    mayors: 0,
    ai_budget: 0,
  });
  assert.ok(plan.wouldChange >= 6, "inbox rows still need a stored lane");
  assert.equal(plan.lanes.decision_ready, 1);
  assert.equal(plan.lanes.reading, 1);
  assert.equal(plan.lanes.verifying, 1);
  assert.equal(plan.protected.approvals, before.approvals);
  assert.equal(db.one(`SELECT COUNT(*) AS n FROM items WHERE desk_lane IS NULL`).n, before.items);

  const http = await worker
    .fetch(request("/api/admin/migrations/desk-lanes?dry_run=1"), env)
    .then((res) => res.json());
  assert.equal(http.dryRun, true);
  assert.equal(http.plan.wouldDelete.items, 0);

  const applied = await applyDeskLaneMigration(env, { dryRun: false });
  assert.equal(applied.applied, true);
  assert.deepEqual(snapshotProtected(db), before);
  assert.equal(db.one(`SELECT desk_lane FROM items WHERE id = 'item-ready'`).desk_lane, "decision_ready");
  assert.equal(db.one(`SELECT desk_lane FROM items WHERE id = 'item-legacy-engine'`).desk_lane, "attention_required");
  assert.equal(db.one(`SELECT desk_lane FROM items WHERE id = 'item-stale-ready'`).desk_lane, null);
  assert.equal(db.one(`SELECT desk_lane FROM items WHERE id = 'item-approved'`).desk_lane, null);
});

test("bootstrap source never wipes the desk or zeroes AI budgets", () => {
  const source = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /wipeNewsDesk/);
  assert.doesNotMatch(source, /desk_wipe_epoch/);
  assert.doesNotMatch(source, /fresh-desk-v1/);
  assert.doesNotMatch(source, /DELETE FROM approvals/);
  assert.doesNotMatch(source, /DELETE FROM brief_versions/);
  const ensure = source.slice(
    source.indexOf("export async function ensureDb"),
    source.indexOf("export async function pruneOldItems"),
  );
  assert.doesNotMatch(ensure, /DELETE FROM items/);
  assert.doesNotMatch(ensure, /DELETE FROM scans/);
  assert.doesNotMatch(ensure, /DELETE FROM search_jobs/);
  assert.doesNotMatch(ensure, /DELETE FROM sources/);
  assert.doesNotMatch(ensure, /SET calls = 0/);
});
