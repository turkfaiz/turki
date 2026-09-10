import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * The dashboard renderer once disappeared inside an over-wide cleanup and no
 * test noticed, because a missing function is a runtime fault rather than a
 * syntax error. This loads the real page script against a stub DOM and asserts
 * the panel it produces, so the same silence cannot happen twice.
 */
function loadPageScript() {
  const store = new Map();
  const element = (id) => {
    if (!store.has(id)) {
      store.set(id, {
        id,
        innerHTML: "",
        textContent: "",
        hidden: false,
        dataset: {},
        style: {},
        classList: { toggle() {}, add() {}, remove() {} },
        addEventListener() {},
        setAttribute() {},
        getAttribute: () => "false",
        querySelectorAll: () => [],
        closest: () => null,
      });
    }
    return store.get(id);
  };
  globalThis.document = {
    getElementById: element,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

  let code = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const bootstrap = code.indexOf("loadMayors().then");
  if (bootstrap !== -1) code = code.slice(0, bootstrap);
  const exported = new Function(
    `${code}\nreturn { renderDiagnostics, briefErrorReason, briefErrorBox, sourceTitle };`,
  )();
  return { ...exported, element };
}

function diagnosticsFixture() {
  const offices = ["turin", "seoul", "amman"];
  return {
    windowDays: 7,
    retentionDays: 9,
    window: { total: 12, oldest: null, newest: null },
    brief: {
      completed: 4,
      pending: 2,
      waitingQuota: 1,
      failed: 1,
      exhausted: 1,
      maxAttempts: 5,
      errors: [{ code: "ai_ungrounded_headline", count: 1, attempts: 5 }],
    },
    ai: {
      configured: true,
      model: "gemini-test",
      budget: {
        remaining: 380,
        dailyLimit: 400,
        mergeLimit: 120,
        minIntervalMs: 4500,
        blocked: false,
        blockReason: null,
        resumesInSeconds: 0,
      },
    },
    registry: { total: 9, healthy: 6, failing: 0, unchecked: 3, verified: 7, perOffice: 3 },
    sources: offices.flatMap((mayorId, index) =>
      [0, 1, 2].map((rank) => ({
        mayor_id: mayorId,
        name_ar: `مكتب ${index}`,
        domain: `${mayorId}-${rank}.example`,
        tier: rank === 0 ? 0 : 1,
        kind: rank === 0 ? "page" : "feed",
        rank: rank + 1,
        verified: rank === 0 ? 0 : 1,
        curated_at: "2026-09-10",
        last_ok_at: rank === 0 ? null : "2026-09-10 01:00:00",
        last_items: rank === 0 ? 0 : 20,
        last_status: rank === 0 ? "HTTP 403" : "ok",
        consecutive_failures: 0,
      })),
    ),
    tools: [
      { id: "registry", name: "سجل المصادر", icon: "list", ok: true, detail: "تفصيل" },
      { id: "ai", name: "الذكاء الاصطناعي", icon: "spark", ok: true, detail: "تفصيل" },
      { id: "engines", name: "محركات البحث", icon: "ban", ok: null, detail: "معطّلة بالحوكمة" },
    ],
    lastScan: {
      type: "manual",
      started_at: "2026-09-10T01:19:52.014Z",
      found_count: 3,
      duplicate_count: 1,
      excluded_count: 2,
      error_count: 0,
    },
  };
}

test("the dashboard renders every ordered section from real diagnostics", () => {
  const page = loadPageScript();
  const data = diagnosticsFixture();
  page.renderDiagnostics(data);
  const html = page.element("diag-body").innerHTML;

  for (const heading of [
    "١ · القراءات الرئيسية",
    "٢ · الأدوات",
    "٣ · مسار التلخيص",
    "٤ · آخر رصد",
    "٥ · المصادر المعتمدة",
  ]) {
    assert.ok(html.includes(heading), `missing section: ${heading}`);
  }
  assert.equal((html.match(/data-tool=/g) || []).length, data.tools.length);
  assert.equal((html.match(/class="office-card"/g) || []).length, 3);
  assert.equal((html.match(/class="src /g) || []).length, data.sources.length);
  assert.ok(html.includes("meter"), "readouts must carry proportional meters");
  assert.match(page.element("diag-headline").textContent, /بانتظار التلخيص/);
});

test("a blocked AI budget is reported as a pause with a resume time", () => {
  const page = loadPageScript();
  const data = diagnosticsFixture();
  data.ai.budget.blocked = true;
  data.ai.budget.blockReason = "daily_limit";
  data.ai.budget.resumesInSeconds = 3600;
  page.renderDiagnostics(data);
  assert.match(page.element("diag-headline").textContent, /متوقف مؤقتًا/);
  assert.match(page.element("diag-body").innerHTML, /نفدت حصة/);
});

test("failure codes are explained in Arabic instead of shown raw", () => {
  const { briefErrorReason } = loadPageScript();
  assert.match(briefErrorReason("ai_ungrounded_headline"), /جملة حرفية/);
  assert.match(briefErrorReason("ai_deferred:daily_limit"), /نفدت حصة/);
  assert.match(briefErrorReason("article_text_too_short"), /أقصر/);
  assert.match(briefErrorReason("The operation was aborted"), /المهلة/);
  assert.equal(briefErrorReason(""), "");
});

test("source tooltips separate curation from this deployment's runtime", () => {
  const { sourceTitle } = loadPageScript();
  const curated = sourceTitle({
    tier: 1,
    kind: "feed",
    verified: 1,
    curated_at: "2026-09-10",
    last_ok_at: "2026-09-10 01:00:00",
    last_items: 20,
  });
  assert.match(curated, /مُتحقق منه بالفحص عند الإعداد/);
  assert.match(curated, /آخر تشغيل/);

  const kept = sourceTitle({ tier: 0, kind: "page", verified: 0, curated_at: "2026-09-10" });
  assert.match(kept, /غرفة أخبار رسمية/);
  assert.match(kept, /لم يستجب من شبكة الفحص/);
  assert.doesNotMatch(kept, /لم يُفحص بعد/, "the misleading wording must not return");
});
