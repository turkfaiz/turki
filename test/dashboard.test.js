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
        `${code}\nreturn { renderDiagnostics, briefErrorReason, briefErrorBox, sourceTitle, renderProviderLanes, toolChip, toolStateLabel, renderSettings, displayBudget, deskHeading, briefBadge };`,
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
  assert.equal((html.match(/class="src /g) || []).length, data.sources.length + 3);
  assert.match(html, /src-key/, "color meaning sits in a compact key, not a second caption");
  assert.ok(html.includes("meter"), "readouts must carry proportional meters");
  assert.match(page.element("diag-headline").textContent, /بانتظار التلخيص/);
  assert.doesNotMatch(html, /٦ · نماذج القراءة/, "provider lanes stay off until diagnostics include them");
});

test("provider lanes are appended without replacing existing diagnostic sections", () => {
  const page = loadPageScript();
  const data = diagnosticsFixture();
  data.providers = {
    queued: 3,
    eligible: 2,
    bound: 1,
    lanes: [
      {
        id: "gemini",
        nameAr: "جيميني",
        model: "gemini-test",
        bound: true,
        enabled: true,
        hasKey: true,
        queued: 2,
        inProgress: 1,
        completed: 4,
        failed: 0,
        minIntervalMs: 4500,
        vars: { key: "GEMINI_API_KEY", enabled: "GEMINI_ENABLED" },
        budget: { remaining: 380, dailyLimit: 400, blocked: false, resumesInSeconds: 0 },
      },
      {
        id: "deepseek",
        nameAr: "ديبسيك",
        model: "deepseek-flash",
        bound: false,
        enabled: true,
        hasKey: false,
        queued: 0,
        inProgress: 0,
        completed: 0,
        failed: 0,
        minIntervalMs: 800,
        vars: { key: "DEEPSEEK_API_KEY", enabled: "DEEPSEEK_ENABLED" },
        budget: { remaining: 2000, dailyLimit: 2000, blocked: false, resumesInSeconds: 0 },
      },
    ],
  };
  page.renderDiagnostics(data);
  const html = page.element("diag-body").innerHTML;
  for (const heading of [
    "١ · القراءات الرئيسية",
    "٢ · الأدوات",
    "٣ · مسار التلخيص",
    "٤ · آخر رصد",
    "٥ · المصادر المعتمدة",
    "٦ · نماذج القراءة",
  ]) {
    assert.ok(html.includes(heading), `missing section: ${heading}`);
  }
  assert.match(html, /جيميني/);
  assert.match(html, /ديبسيك/);
  assert.match(html, /جاري العمل/);
  assert.match(html, /DEEPSEEK_API_KEY/);
  assert.doesNotMatch(html, /الطابور مشترك/);
  assert.match(html, /يُسند لفتحة واحدة/);
});

test("status cards sum remaining quota across every bound slot", () => {
  const page = loadPageScript();
  const data = diagnosticsFixture();
  data.ai.slots = [
    {
      id: "gemini",
      nameAr: "جيميني",
      model: "gemini-test",
      bound: true,
      enabled: true,
      blocked: false,
      budget: { remaining: 10, dailyLimit: 400, blocked: false, minIntervalMs: 4500, mergeLimit: 120 },
    },
    {
      id: "deepseek",
      nameAr: "ديبسيك",
      model: "deepseek-flash",
      bound: true,
      enabled: true,
      blocked: false,
      budget: { remaining: 20, dailyLimit: 2000, blocked: false, minIntervalMs: 800, mergeLimit: 600 },
    },
    {
      id: "qwen",
      nameAr: "كوين",
      model: "qwen-flash",
      bound: true,
      enabled: true,
      blocked: false,
      budget: { remaining: 30, dailyLimit: 2000, blocked: false, minIntervalMs: 800, mergeLimit: 600 },
    },
  ];
  const budget = page.displayBudget(data);
  assert.equal(budget.remaining, 60);
  assert.equal(budget.dailyLimit, 4400);
  assert.equal(budget.blocked, false);
  page.renderDiagnostics(data);
  const html = page.element("diag-body").innerHTML;
  assert.match(html, /60 \/ 4,400/);
  assert.match(html, /جيميني، ديبسيك، كوين/);
});

test("a paused slot is left out of the usable remaining quota", () => {
  const page = loadPageScript();
  const data = diagnosticsFixture();
  data.ai.slots = [
    {
      id: "gemini",
      nameAr: "جيميني",
      bound: true,
      blocked: false,
      budget: { remaining: 379, dailyLimit: 400, blocked: false, mergeLimit: 120, minIntervalMs: 4500 },
    },
    {
      id: "deepseek",
      nameAr: "ديبسيك",
      bound: true,
      blocked: true,
      budget: {
        remaining: 1999,
        dailyLimit: 2000,
        blocked: true,
        blockReason: "provider_unpaid",
        mergeLimit: 600,
        minIntervalMs: 800,
      },
    },
  ];
  const budget = page.displayBudget(data);
  assert.equal(budget.remaining, 379);
  assert.equal(budget.dailyLimit, 400);
  assert.equal(budget.blocked, false);
});

test("a terminal slot error is shown on that provider card only", () => {
  const page = loadPageScript();
  const data = diagnosticsFixture();
  data.providers = {
    queued: 1,
    bound: 2,
    lanes: [
      {
        id: "gemini",
        nameAr: "جيميني",
        model: "gemini-test",
        bound: true,
        enabled: true,
        hasKey: true,
        queued: 1,
        inProgress: 0,
        completed: 0,
        failed: 1,
        minIntervalMs: 4500,
        vars: { key: "GEMINI_API_KEY", enabled: "GEMINI_ENABLED" },
        budget: { remaining: 380, dailyLimit: 400, blocked: false, resumesInSeconds: 0 },
        lastError: { code: "ai_http_402:invalid_request_error", at: "2026-09-15 08:00:00" },
      },
      {
        id: "deepseek",
        nameAr: "ديبسيك",
        model: "deepseek-flash",
        bound: true,
        enabled: true,
        hasKey: true,
        queued: 0,
        inProgress: 0,
        completed: 0,
        failed: 0,
        minIntervalMs: 800,
        vars: { key: "DEEPSEEK_API_KEY", enabled: "DEEPSEEK_ENABLED" },
        budget: { remaining: 2000, dailyLimit: 2000, blocked: false, resumesInSeconds: 0 },
      },
    ],
  };
  page.renderDiagnostics(data);
  const html = page.element("diag-body").innerHTML;
  assert.match(html, /غير مدفوع/);
  assert.match(html, /ديبسيك/);
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
  assert.match(briefErrorReason("Too many subrequests by single Worker invocation"), /مسار مستقل/);
  assert.match(briefErrorReason("ai_http_402:invalid_request_error"), /غير مدفوع/);
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

test("a registry with failing hosts is not labeled as stopped", () => {
  const { toolChip, toolStateLabel } = loadPageScript();
  assert.equal(toolStateLabel("warn"), "تعمل · بعضها متعثر");
  assert.equal(toolStateLabel(true), "تعمل");
  assert.equal(toolStateLabel(false), "متوقفة");
  const html = toolChip({
    id: "registry",
    name: "سجل المصادر",
    icon: "list",
    ok: "warn",
    detail: "السجل يعمل ولم يُوقف.",
  });
  assert.match(html, /تعمل · بعضها متعثر/);
  assert.doesNotMatch(html, />متوقفة</);
  assert.match(html, /class="tool warn"/);
  assert.match(html, /tool-copy/);
  assert.doesNotMatch(html, /tool-dot/, "status lives under the name, not as a second green mark");
});

test("a healthy tool chip stacks the state under the name instead of a green icon plus caption", () => {
  const { toolChip } = loadPageScript();
  const html = toolChip({
    id: "reader",
    name: "قارئ الصفحات",
    icon: "page",
    ok: true,
    detail: "يفتح كل رابط",
  });
  assert.match(html, /class="tool ok"/);
  assert.match(html, /<span class="tool-name">قارئ الصفحات<\/span>/);
  assert.match(html, /<span class="tool-state">تعمل<\/span>/);
  assert.doesNotMatch(html, /tool-dot/);
});

test("settings render every mayor office and its platforms", () => {
  const page = loadPageScript();
  const html = page.renderSettings({
    offices: [
      {
        id: "turin",
        origin: "seed",
        name_ar: "ستيفانو لو روسو",
        name_en: "Stefano Lo Russo",
        name_native: "Stefano Lo Russo",
        city_ar: "تورينو",
        city_en: "Turin",
        country_ar: "إيطاليا",
        title_ar: "عمدة تورينو",
        title_en: "Mayor of Turin",
        platforms: [
          {
            id: "turin:comune.torino.it",
            name: "Comune di Torino",
            kind: "feed",
            enabled: true,
            platform_ar: "موقع رسمي",
            strategies: [{ type: "rss", type_ar: "RSS" }],
            last_checked_at: null,
            last_discovery_at: null,
            operational: { label: "لم تُفحص بعد في هذه البيئة" },
          },
        ],
      },
      {
        id: "riyadh-noura",
        origin: "custom",
        name_ar: "نورة العبدالله",
        name_en: "Noura Alabdullah",
        name_native: "نورة العبدالله",
        city_ar: "الرياض",
        city_en: "Riyadh",
        country_ar: "السعودية",
        title_ar: "عمدة الرياض",
        title_en: "Mayor of Riyadh",
        official_host: "alriyadh.gov.sa",
        platforms: [],
      },
    ],
  });
  assert.match(html, /العمداء|ستيفانو لو روسو|عمدة تورينو|Mayor of Turin|موقع رسمي|RSS/);
  assert.match(html, /data-source-toggle="turin:comune.torino.it"/);
  assert.match(html, /data-origin="custom"/);
  assert.match(html, /مضاف/);
  assert.match(html, /لا منصات مسجّلة لهذا المكتب/);
  assert.match(html, /alriyadh\.gov\.sa/);
});

test("the settings panel includes a form for the required mayor identity fields", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="add-mayor-form"/);
  for (const field of ["name_ar", "name_en", "city_ar", "city_en", "country_ar", "country_code", "native_lang"]) {
    assert.match(html, new RegExp(`name="${field}"`));
  }
  assert.match(html, /حفظ العمدة/);
});

test("the settings overlay stays closed until the user opens it", () => {
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /\.settings-layer:not\(\[hidden\]\)\s*\{\s*display:\s*flex;/);
  assert.match(css, /\.settings-layer\s*\{[\s\S]*?display:\s*none;/);
  assert.match(css, /\.settings-office\.is-new/);
});

test("the desk splits reading, verifying, decision, and attention into separate paths", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  for (const status of ["reading", "verifying", "decision_ready", "attention_required", "approved", "excluded"]) {
    assert.match(html, new RegExp(`data-status="${status}"`));
  }
  assert.match(html, /id="stat-reading"/);
  assert.match(html, /id="stat-verifying"/);
  assert.match(html, /id="stat-decision-ready"/);
  assert.match(html, /id="stat-attention"/);
  assert.doesNotMatch(html, /id="stat-inbox"/);
  assert.match(html, /class="tab on" data-status="decision_ready"/);
  const css = fs.readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /grid-template-columns:\s*repeat\(6/);
  const { deskHeading } = loadPageScript();
  assert.equal(deskHeading({ status: "inbox", desk_lane: "decision_ready" }), "نشرة جاهزة للقرار");
  assert.equal(
    deskHeading({ status: "inbox", desk_lane: "reading", trans_engine: "brief-ai-gemini-v2:x" }),
    "خبر قيد القراءة",
  );
  assert.equal(deskHeading({ status: "inbox", desk_lane: "attention_required" }), "يحتاج تدخلاً");
});

test("brief badges stay short so the green mark is not followed by a sentence", () => {
  const { briefBadge } = loadPageScript();
  assert.equal(
    briefBadge({ trans_engine: "brief-ai-gemini-v2:x", verify_state: "passed" }),
    "مدقَّق",
  );
  assert.equal(
    briefBadge({ trans_engine: "brief-ai-gemini-v2:x", verify_state: "pending" }),
    "بانتظار التدقيق",
  );
  assert.doesNotMatch(
    briefBadge({ trans_engine: "brief-ai-gemini-v2:x", verify_state: "passed" }),
    /مسند|متحقق/,
  );
});
