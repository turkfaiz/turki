import test from "node:test";
import assert from "node:assert/strict";
import { canonicalOriginal } from "../src/brief.js";
import { clusterInboxItems } from "../src/reviewAgent.js";
import { REASON } from "../src/reasons.js";

test("canonical original drops duplicated snippet", () => {
  const orig = canonicalOriginal(
    "Oh Se-hoon housing plan - Korea Herald",
    "Oh Se-hoon housing plan - Korea Herald",
  );
  assert.equal(orig.headline, "Oh Se-hoon housing plan");
  assert.equal(orig.extra, "");
});

test("manual exclude reason is a single canonical label", () => {
  assert.equal(REASON.MANUAL, "استبعاد يدوي");
});

test("different events for the same mayor stay separate cards", () => {
  const groups = clusterInboxItems([
    { id: "a", mayor_id: "turin", title: "Inaugurazione della via pedonale di Via Roma sabato" },
    { id: "b", mayor_id: "turin", title: "Torino al buio blackout a catena Lo Russo rete vecchia" },
  ]);
  assert.equal(groups.length, 2);
});
