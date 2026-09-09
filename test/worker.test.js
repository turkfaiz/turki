import test from "node:test";
import assert from "node:assert/strict";
import { authorized } from "../src/worker.js";

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
