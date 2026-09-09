import test from "node:test";
import assert from "node:assert/strict";
import { planInboxReview, clusterInboxItems } from "../src/reviewAgent.js";
import { REASON } from "../src/reasons.js";

test("review agent drops leftover untrusted hosts before clustering", () => {
  const plan = planInboxReview([
    {
      id: "junk",
      mayor_id: "turin",
      title: "Stefano Lo Russo blackout clickbait",
      snippet: "",
      source: "google_news",
      publisher_tier: null,
    },
    {
      id: "stampa",
      mayor_id: "turin",
      title: "Torino al buio, blackout a catena. Lo Russo: emergenza",
      snippet: "",
      source: "google_news",
      publisher_tier: 1,
    },
  ]);
  assert.equal(plan.kept, 1);
  assert.equal(plan.untrusted, 1);
  assert.equal(plan.exclude.find((x) => x.id === "junk").reason, REASON.UNTRUSTED);
});

test("review agent keeps one story per event and marks the rest as duplicates", () => {
  const plan = planInboxReview([
    {
      id: "a",
      mayor_id: "turin",
      title: "Torino al buio, blackout a catena. Lo Russo",
      snippet: "",
      source: "google_news",
      publisher_tier: 1,
      published_at: "2026-09-01",
    },
    {
      id: "b",
      mayor_id: "turin",
      title: "Torino al buio blackout a catena Lo Russo rete vecchia",
      snippet: "",
      source: "google_news",
      publisher_tier: 1,
      published_at: "2026-09-01",
    },
    {
      id: "official",
      mayor_id: "turin",
      title: "Comunicato: Torino al buio blackout Lo Russo",
      snippet: "",
      source: "official",
      publisher_tier: 0,
      published_at: "2026-09-01",
    },
  ]);
  assert.equal(plan.kept, 1);
  assert.equal(plan.duplicates, 2);
  assert.ok(plan.exclude.every((x) => x.id !== "official"));
  assert.ok(plan.exclude.every((x) => x.reason === REASON.DUPLICATE));
});

test("unrelated trusted copy is excluded with the unified unrelated reason", () => {
  const plan = planInboxReview([
    {
      id: "sport",
      mayor_id: "turin",
      title: "Champions League scores and transfer rumors",
      snippet: "football",
      source: "google_news",
      publisher_tier: 1,
    },
  ]);
  assert.equal(plan.kept, 0);
  assert.equal(plan.unrelated, 1);
  assert.equal(plan.exclude[0].reason, REASON.UNRELATED);
});

test("google-wrapped allowlisted outlet is recovered from the title suffix", () => {
  const plan = planInboxReview([
    {
      id: "sole",
      mayor_id: "turin",
      title: "Turin, clashes at the Askatasuna social centre rally - Il Sole 24 ORE",
      snippet: "",
      url: "https://news.google.com/rss/articles/CBMiabc",
      source: "google_news",
      publisher_tier: null,
    },
    {
      id: "farm",
      mayor_id: "turin",
      title: "Stefano Lo Russo blackout clickbait - DailyViral24",
      snippet: "",
      url: "https://news.google.com/rss/articles/CBMifarm",
      source: "google_news",
      publisher_tier: null,
    },
  ]);
  assert.equal(plan.kept, 1);
  assert.equal(plan.untrusted, 1);
  assert.ok(plan.exclude.every((x) => x.id !== "sole"));
  assert.equal(plan.exclude.find((x) => x.id === "farm").reason, REASON.UNTRUSTED);
});

test("cluster groups near-duplicate headlines for the same mayor", () => {
  const groups = clusterInboxItems([
    { id: "1", mayor_id: "seoul", title: "Oh Se-hoon unveils housing plan in Seoul" },
    { id: "2", mayor_id: "seoul", title: "Oh Se-hoon unveils housing plan in Seoul today" },
    { id: "3", mayor_id: "madrid", title: "Oh Se-hoon unveils housing plan in Seoul" },
  ]);
  const seoul = groups.filter((g) => g.mayor_id === "seoul");
  assert.equal(seoul.length, 1);
  assert.equal(seoul[0].members.length, 2);
});
