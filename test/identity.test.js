import test from "node:test";
import assert from "node:assert/strict";
import { MAYORS, isAboutMayor, matchesTopic } from "../src/mayors.js";

const osaka = MAYORS.find((mayor) => mayor.id === "osaka");
const seoul = MAYORS.find((mayor) => mayor.id === "seoul");
const turin = MAYORS.find((mayor) => mayor.id === "turin");
const madrid = MAYORS.find((mayor) => mayor.id === "madrid");

test("a mayor named inside unspaced Japanese text is recognised", () => {
  // اللقب يلتصق بالاسم، فلا توجد مسافة تحيط به.
  assert.equal(isAboutMayor("横山英幸市長が新しい公園を開設しました。", osaka), true);
  assert.equal(isAboutMayor("横山英幸が記者会見を行った。", osaka), true);
});

test("a Korean name carrying a particle is recognised", () => {
  // اللاحقة 은 تلتصق بالاسم مباشرة.
  assert.equal(isAboutMayor("오세훈은 서울의 새로운 공원을 발표했다.", seoul), true);
  assert.equal(isAboutMayor("오세훈 시장이 발표했다.", seoul), true);
});

test("the city alone is still not the mayor", () => {
  assert.equal(isAboutMayor("大阪市は新しい公園を開設しました。", osaka), false);
  assert.equal(isAboutMayor("서울시는 새로운 공원을 발표했다.", seoul), false);
  assert.equal(isAboutMayor("Il Comune di Torino annuncia lavori", turin), false);
});

test("one office's name never matches another office", () => {
  assert.equal(isAboutMayor("横山英幸市長が新しい公園を開設しました。", seoul), false);
  assert.equal(isAboutMayor("오세훈은 서울의 새로운 공원을 발표했다.", osaka), false);
});

test("spaced scripts keep word boundaries so partial words do not match", () => {
  assert.equal(isAboutMayor("Stefano Lo Russo inaugura via Roma", turin), true);
  // «Russophone» يحتوي «Russo» كجزء من كلمة، ولا يجوز أن يُطابق.
  assert.equal(isAboutMayor("A Russophone festival opened in Turin", turin), false);
});

test("a search topic narrows results and every word must appear", () => {
  const article = "Almeida presenta el plan de renovación de la Plaza Mayor";
  assert.equal(matchesTopic(article, "plaza mayor"), true);
  assert.equal(matchesTopic(article, "transporte"), false);
  // كل الكلمات مطلوبة، فوجود واحدة لا يكفي.
  assert.equal(matchesTopic(article, "plaza transporte"), false);
  // موضوع فارغ لا يصفّي شيئًا.
  assert.equal(matchesTopic(article, ""), true);
});

test("a topic matches inside unspaced text too", () => {
  const article = "横山英幸市長が新しい公園を開設しました。";
  assert.equal(matchesTopic(article, "公園"), true);
  assert.equal(matchesTopic(article, "地下鉄"), false);
});

test("topic matching ignores accents and punctuation", () => {
  const article = "Martínez-Almeida presentó el plan de renovación.";
  assert.equal(matchesTopic(article, "renovacion"), true);
  assert.equal(matchesTopic(article, "Martinez Almeida"), true);
  assert.equal(isAboutMayor(article, madrid), true);
});
