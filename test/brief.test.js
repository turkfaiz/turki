import test from "node:test";
import assert from "node:assert/strict";
import { canonicalOriginal, writeOfficialBrief } from "../src/brief.js";
import { clusterInboxItems } from "../src/reviewAgent.js";
import { MAYORS } from "../src/mayors.js";
import { REASON } from "../src/reasons.js";

const turin = MAYORS.find((m) => m.id === "turin");
const amman = MAYORS.find((m) => m.id === "amman");

test("radar brief is a factual sentence with fact bullets, not role labels", () => {
  const brief = writeOfficialBrief(
    turin,
    'Torino al buio, blackout a catena. Lo Russo: “È un’emergenza, rete vecchia” - La Stampa',
    "Torino al buio, blackout a catena. Lo Russo: è un'emergenza",
  );
  assert.match(brief.title_ar, /ستيفانو لو روسو/);
  assert.match(brief.title_ar, /كهرباء|طوارئ/);
  assert.doesNotMatch(brief.title_ar, /الظلام|التعتيم|ملف |نشاط رسمي|متابعة خبر|بروتوكول/);
  assert.doesNotMatch(brief.snippet_ar, /الشخص:|المنصب:|المدينة:|الموضوع:/);
  assert.match(brief.snippet_ar, /كهرباء|طوارئ|شبكة/);
  assert.doesNotMatch(brief.title_ar, /[A-Za-zÀ-ÿ]/);
  assert.doesNotMatch(brief.snippet_ar, /[A-Za-zÀ-ÿ]/);
  assert.equal(brief.original.extra, "");
  assert.equal(brief.engine, "brief-radar");
});

test("via roma inauguration names the street and the day", () => {
  const brief = writeOfficialBrief(
    turin,
    "Inaugurazione della via pedonale di Via Roma. Sabato 12 settembre",
    "Grande festa per l'inaugurazione. Stefano Lo Russo.",
  );
  assert.match(brief.title_ar, /فيا روما/);
  assert.match(brief.title_ar, /افتتاح|يفتتح/);
  assert.match(brief.title_ar, /12|سبتمبر|السبت/);
  assert.doesNotMatch(brief.title_ar, /نشاط رسمي|بروتوكول|ملف |للمشاة للمشاة/);
  assert.doesNotMatch(brief.title_ar, /[A-Za-zÀ-ÿ]/);
  assert.doesNotMatch(brief.snippet_ar, /[A-Za-zÀ-ÿ]/);
  assert.equal(brief.engine, "brief-radar");
});

test("canonical original drops duplicated snippet", () => {
  const orig = canonicalOriginal(
    "Oh Se-hoon housing plan - Korea Herald",
    "Oh Se-hoon housing plan - Korea Herald",
  );
  assert.equal(orig.headline, "Oh Se-hoon housing plan");
  assert.equal(orig.extra, "");
});

test("arabic municipal news keeps the person, the number, and the debt fact", () => {
  const brief = writeOfficialBrief(
    amman,
    "الشواربة: مديونية أمانة عمان الكبرى 950 مليون دينار - وكالة عمون",
    "",
  );
  assert.match(brief.title_ar, /يوسف الشواربة/);
  assert.match(brief.title_ar, /مديونية|ميزانية/);
  assert.match(brief.title_ar, /950/);
  assert.doesNotMatch(brief.snippet_ar, /الشخص:|المنصب:/);
});

test("foreign leftover words never become the Arabic headline", () => {
  const brief = writeOfficialBrief(turin, "Stefano Lo Russo attends a local ribbon event", "");
  assert.match(brief.title_ar, /ستيفانو لو روسو/);
  assert.doesNotMatch(brief.title_ar, /attends|ribbon/i);
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
