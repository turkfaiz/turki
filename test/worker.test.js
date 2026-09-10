import test from "node:test";
import assert from "node:assert/strict";
import { authorized, searchJobSnapshot } from "../src/worker.js";

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
