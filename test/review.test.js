import test from "node:test";
import assert from "node:assert/strict";
import { planInboxReview, clusterInboxItems, mergeRecord } from "../src/reviewAgent.js";
import { REASON } from "../src/reasons.js";
import { readSourceDocuments, refreshSourceDocuments } from "../src/sourceDocuments.js";

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
      title: "Turin, clashes at the Askatasuna social centre rally, Lo Russo - Il Sole 24 ORE",
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

test("same event from multiple platforms combines source pages before AI", () => {
  const plan = planInboxReview([
    {
      id: "official",
      mayor_id: "turin",
      title: "Lo Russo inaugura la nuova Via Roma pedonale",
      snippet: "Stefano Lo Russo apre Via Roma sabato",
      article_text: "Testo completo della pagina ufficiale sulla inaugurazione.",
      source: "official",
      url: "https://www.comune.torino.it/via-roma",
      publisher_domain: "comune.torino.it",
      publisher_tier: 0,
    },
    {
      id: "paper",
      mayor_id: "turin",
      title: "Nuova Via Roma pedonale, inaugurazione con Lo Russo",
      snippet: "Stefano Lo Russo inaugura Via Roma sabato",
      article_text: "Testo completo del giornale con dettagli diversi.",
      source: "google_news",
      url: "https://www.lastampa.it/via-roma",
      publisher_domain: "lastampa.it",
      publisher_tier: 1,
    },
  ]);
  assert.equal(plan.merges.length, 1);
  const merged = mergeRecord(plan.merges[0]);
  assert.equal(merged.id, "official");
  assert.equal(merged.sourceCount, 2);
  assert.match(merged.articleText, /pagina ufficiale/);
  assert.match(merged.articleText, /giornale/);
  assert.match(merged.mergedSources, /comune\.torino\.it/);
  assert.match(merged.mergedSources, /lastampa\.it/);
});

test("similar policy headlines with conflicting numbers stay separate events", () => {
  const groups = clusterInboxItems([
    {
      id: "120",
      mayor_id: "seoul",
      title: "Oh Se-hoon unveils housing plan for 120 homes in Seoul",
    },
    {
      id: "300",
      mayor_id: "seoul",
      title: "Oh Se-hoon unveils housing plan for 300 homes in Seoul",
    },
  ]);
  assert.equal(groups.length, 2);
});

test("different policy topics stay separate despite shared mayor and plan wording", () => {
  const groups = clusterInboxItems([
    {
      id: "housing",
      mayor_id: "seoul",
      title: "Oh Se-hoon unveils a housing plan for Seoul",
    },
    {
      id: "budget",
      mayor_id: "seoul",
      title: "Oh Se-hoon unveils a budget plan for Seoul",
    },
  ]);
  assert.equal(groups.length, 2);
});

test("an approved event remains the winner when a new platform copy arrives", () => {
  const plan = planInboxReview([
    {
      id: "approved",
      mayor_id: "turin",
      status: "approved",
      title: "Stefano Lo Russo inaugura Via Roma pedonale sabato",
      snippet: "",
      source: "official",
      publisher_tier: 0,
    },
    {
      id: "new-copy",
      mayor_id: "turin",
      status: "inbox",
      title: "Lo Russo inaugura Via Roma pedonale sabato a Torino",
      snippet: "Stefano Lo Russo",
      source: "google_news",
      publisher_tier: 1,
    },
  ]);
  assert.equal(plan.merges[0].winnerId, "approved");
  assert.equal(plan.exclude.find((row) => row.id === "new-copy")?.reason, REASON.DUPLICATE);
});

test("unchanged rediscovery preserves all merged source bodies without resetting AI", () => {
  const official = {
    id: "official",
    mayor_id: "turin",
    title: "Lo Russo inaugura la nuova Via Roma pedonale",
    snippet: "Stefano Lo Russo apre Via Roma sabato",
    article_text: "Testo completo della pagina ufficiale sulla inaugurazione.",
    source: "official",
    url: "https://www.comune.torino.it/via-roma",
    publisher_domain: "comune.torino.it",
    publisher_tier: 0,
  };
  const paper = {
    id: "paper",
    mayor_id: "turin",
    title: "Nuova Via Roma pedonale, inaugurazione con Lo Russo",
    snippet: "Stefano Lo Russo inaugura Via Roma sabato",
    article_text: "Testo completo del giornale con dettagli diversi.",
    source: "google_news",
    url: "https://www.lastampa.it/via-roma",
    publisher_domain: "lastampa.it",
    publisher_tier: 1,
  };
  const merged = mergeRecord({ winnerId: "official", members: [official, paper] });
  const refreshed = refreshSourceDocuments(
    {
      ...official,
      article_text: merged.articleText,
      source_documents: merged.sourceDocuments,
      merged_sources: merged.mergedSources,
    },
    {
      ...official,
      page_body: official.article_text,
    },
    "comune.torino.it",
  );
  assert.equal(refreshed.changed, false);
  assert.equal(refreshed.documents.length, 2);
  assert.match(refreshed.articleText, /pagina ufficiale/);
  assert.match(refreshed.articleText, /giornale/);
});

test("legacy merged text is backfilled into separate source documents", () => {
  const legacy = {
    id: "legacy",
    source: "official",
    publisher_domain: "comune.torino.it",
    url: "https://www.comune.torino.it/via-roma",
    title: "Titolo ufficiale",
    merged_sources: JSON.stringify([
      {
        source: "official",
        domain: "comune.torino.it",
        url: "https://www.comune.torino.it/via-roma",
        title: "Titolo ufficiale",
      },
      {
        source: "google_news",
        domain: "lastampa.it",
        url: "https://www.lastampa.it/via-roma",
        title: "Titolo giornale",
      },
    ]),
    article_text:
      "[comune.torino.it] Titolo ufficiale\nCorpo completo ufficiale.\n\n" +
      "[lastampa.it] Titolo giornale\nCorpo completo del giornale.",
  };
  const documents = readSourceDocuments(legacy);
  assert.equal(documents.length, 2);
  assert.equal(documents[0].article_text, "Corpo completo ufficiale.");
  assert.equal(documents[1].article_text, "Corpo completo del giornale.");
});
