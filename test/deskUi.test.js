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
  evidenceQuote,
  failureAdvice,
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

  // لا موجز مدقَّق ولا ينتظر تدقيقًا (فشل الموجز): لا زر اعتماد يوحي بانتظار لن يأتي.
  const failed = renderDetail(item({ verify_state: null, trans_engine: "brief-ai-error", desk_lane: "attention_required", attention_reason: "brief_error", brief_error: "ai_http_503" }));
  assert.doesNotMatch(failed, /btn-good/);
  assert.match(failed, /data-act="excluded"/);

  const excluded = renderDetail(item({ status: "excluded", exclude_reason: "لا يخص العمدة" }));
  assert.match(excluded, /data-act="inbox"/);
  assert.match(excluded, /سبب الاستبعاد: لا يخص العمدة/);
  assert.doesNotMatch(excluded, /data-act="excluded"/);
});

test("a failed brief shows one coherent box: the real reason, what to do, and a retry", () => {
  const html = renderDetail(
    item({
      desk_lane: "attention_required",
      attention_reason: "brief_error",
      trans_engine: "brief-ai-error",
      brief_error: "ai_ungrounded_headline:quote_without_mayor",
      brief_attempts: 2,
      verify_state: null,
      current_version_id: null,
    }),
  );
  assert.equal((html.match(/class="brief-error"/g) || []).length, 1);
  assert.match(html, /تعذّرت كتابة موجز موثّق/);
  assert.match(html, /اقتباس العنوان لا يذكر العمدة/);
  assert.match(html, /جرّب النظام محاولتين على النماذج المربوطة ثم توقف/);
  assert.match(html, /الأنسب استبعاده/);
  assert.match(html, /data-act="retry-brief"/);
  assert.match(html, /تعذّر التلخيص — يحتاج مراجعتك/);
  assert.doesNotMatch(html, /ستُعاد المحاولة/);
  // لا «خطأ تشغيلي» عامًا يناقض السبب، ولا «المحاولة 2 من 5» وكأن إعادة تلقائية قادمة
  assert.doesNotMatch(html, /خطأ تشغيلي/);
  assert.doesNotMatch(html, /المحاولة 2 من 5/);
});

test("advice follows the actual failure instead of one generic line", () => {
  assert.match(failureAdvice("ai_ungrounded_headline:name_missing"), /إعادة المحاولة قد تنجح/);
  assert.match(failureAdvice("ai_has_no_grounded_facts"), /استبعاده/);
  assert.match(failureAdvice("ai_http_503"), /عطل مؤقت/);
  assert.match(failureAdvice(""), /أعد المحاولة/);
});

test("other attention reasons keep their own single box, and in-progress failures are not called final", () => {
  const verify = renderDetail(item({ desk_lane: "attention_required", attention_reason: "verify_failed", verify_state: "failed" }));
  assert.equal((verify.match(/class="brief-error"/g) || []).length, 1);
  assert.match(verify, /رفض المدقق المستقل هذا الموجز/);
  assert.match(verify, /data-act="retry-brief">إعادة إنتاج الموجز/);

  const retrying = renderDetail(item({ desk_lane: "reading", trans_engine: "brief-pending", brief_error: "ai_http_503", brief_attempts: 2, verify_state: null }));
  assert.match(retrying, /ستُعاد المحاولة تلقائيًا \(2 من 5\)/);
  const exhausted = renderDetail(item({ desk_lane: "reading", trans_engine: "brief-ai-error", brief_error: "ai_http_503", brief_attempts: 5, verify_state: null }));
  assert.match(exhausted, /توقفت المحاولات بعد 5 محاولات/);
  assert.match(exhausted, /data-act="retry-brief"/);
});

test("the detail view links the source safely and lists merged sources", () => {
  const html = renderDetail(
    item({ merged_sources: JSON.stringify([{ domain: "a.it" }, { domain: "b.it" }]), url: 'https://x.it/a"onmouseover="y' }),
  );
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /"onmouseover="/);
  assert.match(html, /المصادر: a\.it · b\.it/);
});

test("a verifier rejection names what was rejected, shows the quote it was compared with, and offers regeneration", () => {
  const html = renderDetail(
    item({
      desk_lane: "attention_required",
      attention_reason: "verify_failed",
      verify_state: "failed",
      verify_detail: "ai_headline_not_supported",
      version_evidence: JSON.stringify({ headline: "Il sindaco ha annunciato un piano <b>casa</b>", facts: ["x"] }),
    }),
  );
  assert.equal((html.match(/class="brief-error"/g) || []).length, 1);
  assert.match(html, /رفض المدقق المستقل العنوان: لا يطابق الاقتباس الأصلي/);
  assert.match(html, /الاقتباس الأصلي الذي قارن به: <q dir="auto">Il sindaco ha annunciato un piano &lt;b&gt;casa&lt;\/b&gt;<\/q>/);
  assert.match(html, /قارن العنوان بالاقتباس الأصلي أعلاه/);
  assert.match(html, /data-act="retry-brief">إعادة إنتاج الموجز/);
  assert.doesNotMatch(html, /<b>casa<\/b>/);

  const facts = renderDetail(item({ desk_lane: "attention_required", attention_reason: "verify_failed", verify_state: "failed", verify_detail: "ai_facts_not_supported" }));
  assert.match(facts, /رفض المدقق المستقل كل حقائق الموجز/);
  assert.doesNotMatch(facts, /الاقتباس الأصلي الذي قارن به/);

  const exhausted = renderDetail(item({ desk_lane: "attention_required", attention_reason: "verify_exhausted", verify_state: "pending" }));
  assert.match(exhausted, /استُنفدت محاولات التدقيق/);
});

test("the quote helper reads the current evidence shape and the legacy one, and survives garbage", () => {
  assert.equal(evidenceQuote({ version_evidence: JSON.stringify({ headline: "H", facts: [] }) }), "H");
  assert.equal(evidenceQuote({ version_evidence: JSON.stringify([{ fact_ar: "x", evidence: "Q" }]) }), "Q");
  assert.equal(evidenceQuote({ version_evidence: "not json" }), "");
  assert.equal(evidenceQuote({}), "");
});
