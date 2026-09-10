import test from "node:test";
import assert from "node:assert/strict";
import {
  authorized,
  briefStage,
  continuationDelaySeconds,
  searchJobSnapshot,
  shouldContinueBriefs,
} from "../src/worker.js";

test("dashboard authentication is optional locally and enforced when configured", () => {
  const plain = new Request("https://example.com/api/stats");
  assert.equal(authorized(plain, {}), true);
  assert.equal(authorized(plain, { DASHBOARD_PASSWORD: "secret" }), false);
  assert.equal(authorized(plain, { GEMINI_API_KEY: "paid-secret" }), false);

  const authenticated = new Request("https://example.com/api/stats", {
    headers: {
      Authorization: `Basic ${btoa("mayorwatch:secret")}`,
    },
  });
  assert.equal(authorized(authenticated, { DASHBOARD_PASSWORD: "secret" }), true);
  assert.equal(
    authorized(authenticated, {
      DASHBOARD_USER: "other",
      DASHBOARD_PASSWORD: "secret",
    }),
    false,
  );
});

test("queued search snapshot aggregates office progress and results", () => {
  const snapshot = searchJobSnapshot(
    { id: "job-1", query: "", mayor_id: null },
    [
      {
        mayor_id: "seoul",
        status: "completed",
        stage: "completed",
        attempts: 1,
        result_json: JSON.stringify({
          found: 2,
          discovered: 8,
          opened: 3,
          summarized: 2,
          review: { duplicates: 1 },
          errors: [],
        }),
      },
      {
        mayor_id: "turin",
        status: "running",
        stage: "verifying",
        detail: "يفتح الصفحات",
        attempts: 1,
      },
    ],
  );
  assert.equal(snapshot.status, "running");
  assert.equal(snapshot.total, 2);
  assert.equal(snapshot.completed, 1);
  assert.equal(snapshot.running, 1);
  assert.equal(snapshot.totals.found, 2);
  assert.equal(snapshot.totals.duplicates, 1);
  assert.equal(snapshot.tasks[1].stage, "verifying");
});

test("queued search reports partial completion without double counting", () => {
  const snapshot = searchJobSnapshot(
    { id: "job-2", query: "housing", mayor_id: null },
    [
      {
        mayor_id: "seoul",
        status: "completed",
        result_json: JSON.stringify({ found: 1 }),
      },
      {
        mayor_id: "turin",
        status: "failed",
        attempts: 3,
        error: "timeout",
      },
    ],
  );
  assert.equal(snapshot.status, "partial");
  assert.equal(snapshot.completed, 1);
  assert.equal(snapshot.failed, 1);
  assert.equal(snapshot.totals.found, 1);
});

test("brief stage separates waiting on quota from a real failure", () => {
  assert.equal(
    briefStage({ summarized: 1, failed: 0, deferred: 1, pending: 4 }).stage,
    "ai_waiting_quota",
  );
  assert.equal(
    briefStage({ summarized: 1, failed: 0, deferred: 0, pending: 4 }).stage,
    "ai_pending",
  );
  assert.equal(
    briefStage({ summarized: 0, failed: 2, deferred: 0, pending: 0 }).stage,
    "ai_failed",
  );
  assert.equal(
    briefStage({ summarized: 3, failed: 0, deferred: 0, pending: 0 }).stage,
    "completed",
  );
});

test("a long quota pause is left to the periodic drain, not requeued in a loop", () => {
  assert.equal(shouldContinueBriefs({ pending: 0, deferred: 0 }), false);
  assert.equal(shouldContinueBriefs({ pending: 5, deferred: 0 }), true);
  assert.equal(
    shouldContinueBriefs({ pending: 5, deferred: 1, retryAfterSeconds: 30 }),
    true,
  );
  assert.equal(
    shouldContinueBriefs({ pending: 5, deferred: 1, retryAfterSeconds: 20000 }),
    false,
  );
});

test("continuation delays stay inside safe bounds", () => {
  assert.equal(continuationDelaySeconds({ retryAfterSeconds: 0 }), 10);
  assert.equal(continuationDelaySeconds({ retryAfterSeconds: 45 }), 45);
  assert.equal(continuationDelaySeconds({ retryAfterSeconds: 99999 }), 900);
});
