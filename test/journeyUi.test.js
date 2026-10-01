import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStages,
  jobPhase,
  renderDropped,
  renderHistory,
  renderIdle,
  renderJourney,
  renderNow,
  renderOffices,
  summaryLine,
} from "../public/journey.js";
import { duration, parseDbDate, relTime } from "../public/lib.js";

const funnel = (over = {}) => ({
  candidates: { total: 0, waiting: 0, read: 0, failed: 0, duplicates: 0, dropped: {}, ...(over.candidates || {}) },
  items: {
    total: 0, excluded: 0, reading: 0, verifying: 0, decision_ready: 0, attention_required: 0, approved: 0,
    ...(over.items || {}),
  },
});

const task = (over = {}) => ({
  mayor_id: "turin", mayor_name: "ستيفانو لو روسو", status: "running", stage: "source_poll", detail: "",
  journey: {}, source_errors: [], ...over,
});

const job = (over = {}) => ({
  id: "j1", status: "running", kind: "manual", query: "", mayor_id: null,
  created_at: "2026-10-01 08:00:00", finished_at: null,
  tasks: [task()], sources: [], funnel: funnel(), ...over,
});

const states = (j) => Object.fromEntries(buildStages(j).map((s) => [s.key, s.state]));

test("a job that just started has waiting stages and the first one active", () => {
  const j = job({
    sources: [
      { mayor_id: "turin", source_id: "turin:a", domain: "a.it", status: "polled", detail: "ok" },
      { mayor_id: "turin", source_id: "turin:b", domain: "b.it", status: "polling", detail: "" },
      { mayor_id: "turin", source_id: "turin:c", domain: "c.it", status: "queued", detail: "" },
    ],
  });
  const stages = buildStages(j);
  assert.equal(stages[0].value, "1/3");
  assert.deepEqual(states(j), { sources: "active", discover: "active", read: "waiting", filter: "waiting", brief: "waiting", verify: "waiting", ready: "waiting" });
});

test("stages advance with the real counts: reading pages, then briefs, then verification", () => {
  const sources = [{ mayor_id: "turin", source_id: "turin:a", domain: "a.it", status: "polled", detail: "ok" }];
  const reading = job({ sources, funnel: funnel({ candidates: { total: 10, waiting: 4, read: 6 }, items: { reading: 2 } }) });
  assert.deepEqual(states(reading), { sources: "done", discover: "done", read: "active", filter: "active", brief: "waiting", verify: "waiting", ready: "waiting" });
  assert.equal(buildStages(reading)[2].value, "6/10");
  assert.equal(buildStages(reading)[2].sub, "4 بالانتظار");

  const writing = job({ sources, funnel: funnel({ candidates: { total: 10, read: 10 }, items: { reading: 2, verifying: 3 } }) });
  assert.equal(states(writing).read, "done");
  assert.equal(states(writing).brief, "active");
  assert.equal(buildStages(writing)[4].value, "3/5");

  const checking = job({ sources, funnel: funnel({ candidates: { total: 10, read: 10 }, items: { verifying: 2, decision_ready: 3 } }) });
  assert.equal(states(checking).brief, "done");
  assert.equal(states(checking).verify, "active");
  assert.equal(states(checking).ready, "waiting");
});

test("a finished job shows every stage done and a one-line summary", () => {
  const j = job({
    status: "completed",
    finished_at: "2026-10-01 08:04:00",
    sources: [{ mayor_id: "turin", source_id: "turin:a", domain: "a.it", status: "polled", detail: "ok" }],
    funnel: funnel({ candidates: { total: 20, read: 20, dropped: { unrelated: 9 }, duplicates: 2 }, items: { total: 9, excluded: 1, decision_ready: 6, attention_required: 2 } }),
  });
  assert.ok(buildStages(j).every((stage) => stage.state === "done"));
  assert.equal(buildStages(j)[6].value, "6");
  assert.equal(buildStages(j)[6].sub, "2 يحتاج تدخلاً");
  assert.equal(summaryLine(j), "اكتشف 20 رابطًا · قرأ 20 · حفظ 8 خبرًا · 6 جاهز للقرار · 2 يحتاج تدخلاً");
  assert.equal(jobPhase(j).label, "اكتمل");
});

test("waiting for AI quota is shown as blocked, not as progress", () => {
  const j = job({
    sources: [{ mayor_id: "turin", source_id: "turin:a", domain: "a.it", status: "polled", detail: "ok" }],
    tasks: [task({ stage: "ai_waiting_quota", status: "waiting", journey: { resume_at: "2026-10-01 12:00:00" } })],
    funnel: funnel({ candidates: { total: 5, read: 5 }, items: { reading: 5 } }),
  });
  assert.equal(states(j).brief, "blocked");
  assert.deepEqual(jobPhase(j), { label: "بانتظار حصة الذكاء الاصطناعي", tone: "warn" });
});

test("failed and partial jobs are labelled honestly", () => {
  assert.equal(jobPhase(job({ status: "failed" })).tone, "bad");
  assert.equal(jobPhase(job({ status: "partial" })).tone, "warn");
  assert.ok(buildStages(job({ status: "failed" })).some((stage) => stage.state === "failed"));
  assert.equal(jobPhase(null).label, "لا رحلة بعد");
});

test("dropped reasons are explained in Arabic, and an empty drop list says so", () => {
  const html = renderDropped(funnel({ candidates: { dropped: { unrelated: 9, stale: 3 }, duplicates: 2, failed: 1 } }));
  assert.match(html, /9<\/b> لا يخص العمدة/);
  assert.match(html, /3<\/b> أقدم من أسبوع/);
  assert.match(html, /2<\/b> مكرر دُمج/);
  assert.match(html, /تعذّر فتح الصفحة/);
  assert.match(renderDropped(funnel()), /لم يُستبعد شيء/);
});

test("offices list each site with its state in words and escapes names", () => {
  const html = renderOffices(
    job({
      tasks: [task({ mayor_name: "<b>x</b>", journey: { settled: 2, total: 5 } })],
      sources: [
        { mayor_id: "turin", source_id: "turin:a", domain: "a.it", name: "A", status: "failed", detail: "http_403" },
        { mayor_id: "turin", source_id: "turin:b", domain: "b.it", name: "B", status: "polled", detail: "worker_rejected" },
        { mayor_id: "turin", source_id: "turin:c", domain: "c.it", name: "C", status: "polled", detail: "ok_no_new" },
        { mayor_id: "turin", source_id: "turin:d", domain: "d.it", name: "D", status: "queued", detail: "" },
      ],
    }),
  );
  assert.doesNotMatch(html, /<b>x<\/b>/);
  assert.match(html, /2\/5 خبرًا استقر/);
  assert.match(html, /is-bad/);
  assert.match(html, /الموقع يرفض الطلب الآلي/);
  assert.match(html, /تعمل · لا جديد/);
  assert.match(html, /بانتظار الدور/);
});

test("the live feed shows at most three active offices and counts the rest", () => {
  const tasks = ["a", "b", "c", "d", "e"].map((id) => task({ mayor_id: id, mayor_name: `مكتب ${id}`, stage: "article_fetch", detail: "يفتح المقالات" }));
  tasks.push(task({ mayor_id: "q", status: "queued", stage: "queued" }));
  const html = renderNow(job({ tasks }));
  assert.equal((html.match(/<li><span class="jr-pulse"/g) || []).length, 3);
  assert.match(html, /و2 من المكاتب الأخرى تعمل/);
  assert.match(html, /1 من المكاتب بانتظار الدور/);
  assert.equal(renderNow(job({ status: "completed" })), "");
});

test("the journey panel combines header, stepper, live feed and a collapsible detail area", () => {
  const html = renderJourney(job({ query: "مياه" }), { mayors: [], now: Date.parse("2026-10-01T08:02:00Z") });
  assert.match(html, /رحلة الرصد/);
  assert.match(html, /موضوع: «مياه»/);
  assert.match(html, /يعمل الآن/);
  assert.match(html, /class="jr-steps"/);
  assert.match(html, /data-jr-toggle="details" aria-expanded="false"/);
  assert.match(html, /class="jr-details" hidden/);
  assert.match(renderJourney(job(), { detailsOpen: true }), /class="jr-details" >/);
});

test("history rows are keyboard-reachable buttons and mark the active run", () => {
  const html = renderHistory(
    [
      { id: "j1", status: "completed", kind: "weekly", query: "", mayor_id: null, created_at: "2026-10-01 03:00:00", offices: 13, totals: { found: 12, duplicates: 4 } },
      { id: "j2", status: "partial", kind: "manual", query: "", mayor_id: "turin", created_at: "2026-09-30 10:00:00", offices: 1, totals: { found: 1, duplicates: 0 } },
    ],
    "j2",
    { mayors: [{ id: "turin", name_ar: "ستيفانو لو روسو" }] },
  );
  assert.match(html, /<button type="button" class="jr-run" data-job="j1"/);
  assert.match(html, /class="jr-run is-active" data-job="j2"/);
  assert.match(html, /13 مكتبًا/);
  assert.match(html, /مكتب واحد/);
  assert.match(html, /الرصد الأسبوعي · كل المكاتب/);
  assert.match(html, /بحث يدوي · ستيفانو لو روسو/);
  assert.match(renderHistory([], null), /لا رحلات سابقة/);
});

test("the idle state explains what will appear and shows the last weekly run", () => {
  const html = renderIdle({ lastWeekly: { started_at: "2026-09-28 03:00:00", found_count: 14, duplicate_count: 3, excluded_count: 40 }, now: Date.parse("2026-09-28T05:00:00Z") });
  assert.match(html, /آخر رصد أسبوعي قبل ساعتين — جديد 14 · مدمج 3 · مستبعد 40/);
  assert.match(html, /رصد الآن/);
  assert.match(renderIdle({}), /لم يجرِ رصد بعد/);
});

test("time helpers read D1 timestamps as UTC", () => {
  assert.equal(parseDbDate("2026-10-01 08:00:00").toISOString(), "2026-10-01T08:00:00.000Z");
  assert.equal(duration("2026-10-01 08:00:00", Date.parse("2026-10-01T08:00:45Z")), "45 ثانية");
  assert.equal(duration("2026-10-01 08:00:00", Date.parse("2026-10-01T08:05:00Z")), "5 دقائق");
  assert.equal(relTime("2026-10-01 07:00:00", Date.parse("2026-10-01T08:00:00Z")), "قبل ساعة");
});
