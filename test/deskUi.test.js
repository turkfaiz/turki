import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  ATTENTION_REASON_AR,
  LANE_EMPTY,
  TAB_HINT,
  briefErrorReason,
  briefState,
  deskHeading,
  renderDetail,
  renderItemCard,
  renderItemList,
} from "../public/desk.js";

const read = (file) => fs.readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");

const item = (over = {}) => ({
  id: "i1",
  status: "inbox",
  desk_lane: "decision_ready",
  city_ar: "تورينو",
  name_ar: "ستيفانو لو روسو",
  country_ar: "إيطاليا",
  office_ar: "عمدة تورينو",
  news_title_ar: "ستيفانو لو روسو يفتتح الحديقة",
  news_snippet_ar: "افتتاح الحديقة غدًا.\nالحفل في الصباح.",
  title: "Lo Russo inaugura il parco",
  snippet: "Lo Russo inaugura il parco",
  url: "https://www.comune.torino.it/parco",
  publisher_domain: "comune.torino.it",
  source: "approved_feed",
  confidence: "raw",
  trans_engine: "brief-ai-gemini-v2:gemini-test",
  verify_state: "passed",
  published_at: "2026-10-01T08:00:00Z",
  ...over,
});

test("failure codes are explained in Arabic instead of shown raw", () => {
  assert.match(briefErrorReason("ai_ungrounded_headline"), /جملة حرفية/);
  assert.match(briefErrorReason("ai_ungrounded_headline:name_missing"), /لا يبدأ باسم العمدة/);
  assert.match(briefErrorReason("ai_deferred:daily_limit"), /نفدت حصة/);
  assert.match(briefErrorReason("article_text_too_short"), /أقصر/);
  assert.match(briefErrorReason("The operation was aborted"), /المهلة/);
  assert.match(briefErrorReason("Too many subrequests by single Worker invocation"), /مسار مستقل/);
  assert.match(briefErrorReason("ai_http_402:invalid_request_error"), /غير مدفوع/);
  assert.equal(briefErrorReason(""), "");
});

test("the desk heading follows the lane, and every lane has an empty state and a hint", () => {
  assert.equal(deskHeading({ status: "inbox", desk_lane: "decision_ready" }), "نشرة جاهزة للقرار");
  assert.equal(deskHeading({ status: "inbox", desk_lane: "reading", trans_engine: "brief-ai-gemini-v2:x" }), "خبر قيد القراءة");
  assert.equal(deskHeading({ status: "inbox", desk_lane: "attention_required" }), "يحتاج تدخلاً");
  assert.equal(deskHeading({ status: "approved" }), "نشرة معتمدة");
  for (const lane of ["reading", "verifying", "decision_ready", "attention_required", "approved", "excluded"]) {
    assert.ok(LANE_EMPTY[lane], lane);
    assert.ok(TAB_HINT[lane], lane);
  }
});

test("the page keeps the six desk paths as tabs with live counters, decision first", () => {
  const html = read("index.html");
  for (const status of ["reading", "verifying", "decision_ready", "attention_required", "approved", "excluded"]) {
    assert.match(html, new RegExp(`data-status="${status}"`), status);
    assert.match(html, new RegExp(`data-count="${status}"`), status);
  }
  assert.ok(html.indexOf('data-status="decision_ready"') < html.indexOf('data-status="reading"'));
  assert.match(html, /class="tab on" data-status="decision_ready"/);
});

test("the old KPI row and diagnostics board are gone from the main page", () => {
  const html = read("index.html");
  const app = read("app.js");
  assert.doesNotMatch(html, /kpis|diagnostics|diag-body|stat-reading|progress-tasks/);
  // لوحة التشخيص تمسح جداول كاملة؛ مكانها الإعدادات وعند الطلب فقط.
  assert.doesNotMatch(app, /\/api\/diagnostics/);
  assert.match(html, /href="\/settings#tools"/);
});

test("a card shows office, title, first fact and a plain verification state", () => {
  const html = renderItemCard(item(), "i1", Date.parse("2026-10-01T10:00:00Z"));
  assert.match(html, /class="card selected"/);
  assert.match(html, /تورينو · ستيفانو لو روسو/);
  assert.match(html, /<h3>ستيفانو لو روسو يفتتح الحديقة<\/h3>/);
  assert.match(html, /افتتاح الحديقة غدًا/);
  assert.match(html, /state is-good/);
  assert.match(html, /مدقَّق/);
  assert.match(html, /قبل ساعتين/);
  assert.doesNotMatch(html, /approved_feed|brief-ai/);
});

test("card states cover waiting, rejected, deferred and merged sources, and escape markup", () => {
  assert.deepEqual(briefState(item({ verify_state: "pending" })), { text: "بانتظار التدقيق", tone: "wait" });
  assert.deepEqual(briefState(item({ verify_state: "failed" })), { text: "رُفض في التدقيق", tone: "bad" });
  assert.equal(briefState(item({ trans_engine: "brief-deferred" })).tone, "warn");
  assert.equal(briefState(item({ trans_engine: "brief-pending" })).text, "بانتظار الموجز");
  const html = renderItemCard(item({ news_title_ar: "<img src=x onerror=alert(1)>", source_count: 3, confidence: "official" }));
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /3 مصادر مدمجة/);
  assert.match(html, /مؤكد رسمي/);
});

test("the list renders cards or the lane's own empty message", () => {
  assert.match(renderItemList([item(), item({ id: "i2" })], "decision_ready"), /data-id="i2"/);
  assert.match(renderItemList([], "attention_required"), /لا يوجد ما يحتاج تدخلاً/);
});

test("approval is offered only for a verified brief; excluded items can be restored", () => {
  const ready = renderDetail(item());
  assert.match(ready, /data-act="approved">اعتماد</);
  assert.match(ready, /data-act="excluded"/);
  assert.match(ready, /كتب الموجز: جيميني · gemini-test/);

  const pending = renderDetail(item({ verify_state: "pending" }));
  assert.match(pending, /disabled title="لا يُعتمد موجز قبل اجتياز التدقيق الدلالي"/);
  assert.doesNotMatch(pending, /data-act="approved">/);

  const excluded = renderDetail(item({ status: "excluded", exclude_reason: "لا يخص العمدة" }));
  assert.match(excluded, /data-act="inbox"/);
  assert.match(excluded, /سبب الاستبعاد: لا يخص العمدة/);
  assert.doesNotMatch(excluded, /data-act="excluded"/);
});

test("an item needing attention explains why, and exhausted briefs offer a retry", () => {
  const html = renderDetail(item({ desk_lane: "attention_required", attention_reason: "verify_failed", verify_state: "failed" }));
  assert.match(html, new RegExp(ATTENTION_REASON_AR.verify_failed.slice(0, 20)));
  const stuck = renderDetail(
    item({ trans_engine: "brief-ai-error", brief_error: "ai_http_5xx", brief_attempts: 5, verify_state: null, desk_lane: "attention_required", attention_reason: "brief_exhausted" }),
  );
  assert.match(stuck, /data-act="retry-brief"/);
  assert.match(stuck, /توقفت المحاولات بعد 5 محاولات/);
});

test("the detail view links the source safely and lists merged sources", () => {
  const html = renderDetail(
    item({ merged_sources: JSON.stringify([{ domain: "a.it" }, { domain: "b.it" }]), url: 'https://x.it/a"onmouseover="y' }),
  );
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /"onmouseover="/);
  assert.match(html, /المصادر: a\.it · b\.it/);
});
