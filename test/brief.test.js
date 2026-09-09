import test from "node:test";
import assert from "node:assert/strict";
import { canonicalOriginal, writeOfficialBrief } from "../src/brief.js";
import { MAYORS } from "../src/mayors.js";
import { REASON } from "../src/reasons.js";

test("official brief names the person and the actual subject, not machine-translated prose", () => {
  const turin = MAYORS.find((m) => m.id === "turin");
  const brief = writeOfficialBrief(
    turin,
    'Torino al buio, blackout a catena. Lo Russo: “È un’emergenza, rete vecchia” - La Stampa',
    "Torino al buio, blackout a catena. Lo Russo: è un'emergenza",
  );
  assert.match(brief.title_ar, /ستيفانو لو روسو/);
  assert.match(brief.title_ar, /كهرباء|طوارئ/);
  assert.doesNotMatch(brief.title_ar, /الظلام|التعتيم/);
  assert.match(brief.snippet_ar, /الشخص: ستيفانو لو روسو/);
  assert.match(brief.snippet_ar, /عمدة تورينو/);
  assert.equal(brief.original.extra, "");
  assert.equal(brief.engine, "brief");
});

test("canonical original drops duplicated snippet", () => {
  const orig = canonicalOriginal(
    "Oh Se-hoon housing plan - Korea Herald",
    "Oh Se-hoon housing plan - Korea Herald",
  );
  assert.equal(orig.headline, "Oh Se-hoon housing plan");
  assert.equal(orig.extra, "");
});

test("arabic municipal news keeps the person in the brief", () => {
  const amman = MAYORS.find((m) => m.id === "amman");
  const brief = writeOfficialBrief(
    amman,
    "الشواربة: مديونية أمانة عمان الكبرى 950 مليون دينار - وكالة عمون",
    "",
  );
  assert.match(brief.title_ar, /يوسف الشواربة/);
  assert.match(brief.snippet_ar, /أمين عمّان/);
  assert.match(brief.title_ar, /ميزانية|مديونية/);
});

test("foreign leftover words never become the Arabic headline", () => {
  const turin = MAYORS.find((m) => m.id === "turin");
  const brief = writeOfficialBrief(turin, "Stefano Lo Russo attends a local ribbon event", "");
  assert.match(brief.title_ar, /ستيفانو لو روسو/);
  assert.doesNotMatch(brief.title_ar, /attends|ribbon/);
});

test("manual exclude reason is a single canonical label", () => {
  assert.equal(REASON.MANUAL, "استبعاد يدوي");
});
