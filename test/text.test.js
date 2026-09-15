import test from "node:test";
import assert from "node:assert/strict";
import { arabicRatio, hasSourceScript } from "../src/text.js";

test("source-script leftovers are detected in mixed Arabic headlines", () => {
  assert.equal(hasSourceScript("ستيفانو لو روسو يفتتح شارع فيا روما للمشاة"), false);
  assert.equal(hasSourceScript("ستيفانو لو روسو يفتتح Via Roma"), true);
  assert.equal(hasSourceScript("أوه سيه هون يفتتح 오세훈 إسكان الشباب"), true);
  assert.equal(hasSourceScript("موعد الاحتفال السبت 12 سبتمبر."), false);
  assert.ok(arabicRatio("ستيفانو لو روسو يفتتح Via Roma") > 0.45);
});
