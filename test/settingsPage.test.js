import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  filterOffices,
  parseDbDate,
  parseSiteLines,
  relTime,
  renderAddPanel,
  renderAi,
  renderMayorFields,
  renderOfficeCard,
  renderOffices,
  renderSummary,
  renderSystem,
  siteResultHtml,
  siteTone,
} from "../public/settings.js";

const site = (overrides = {}) => ({
  id: "turin:comune.torino.it",
  domain: "comune.torino.it",
  name: "Comune di Torino",
  enabled: true,
  origin: "registry",
  platform: "official",
  platform_ar: "موقع رسمي",
  searches_by_name: false,
  strategies: [{ type: "rss", type_ar: "RSS", supplement: false }],
  last_checked_at: null,
  operational: { code: "ok", label: "تعمل" },
  ...overrides,
});

const office = (overrides = {}) => ({
  id: "turin",
  origin: "seed",
  name_ar: "ستيفانو لو روسو",
  name_en: "Stefano Lo Russo",
  city_ar: "تورينو",
  city_en: "Turin",
  country_ar: "إيطاليا",
  platforms: [site()],
  ...overrides,
});

const view = (offices = [office()], extra = {}) => ({
  offices,
  summary: {
    offices: offices.length,
    custom_offices: 0,
    sources_total: 3,
    sources_active: 2,
    sources_attention: 1,
    offices_without_sources: 0,
    cap_per_office: 3,
  },
  ai: {
    configured: true,
    slots: [
      {
        id: "gemini",
        nameAr: "جيميني",
        model: "gemini-3.5-flash-lite",
        bound: true,
        enabled: true,
        blocked: false,
        hasKey: true,
        budget: { remaining: 380, dailyLimit: 400, used: 20, minIntervalMs: 4500 },
        lastError: { code: "ai_ungrounded_headline:name_missing", at: "2026-10-01 07:30:14" },
      },
      {
        id: "qwen",
        nameAr: "كوين",
        model: "qwen-flash",
        bound: false,
        enabled: false,
        blocked: false,
        hasKey: false,
        budget: { remaining: 2000, dailyLimit: 2000, used: 0, minIntervalMs: 800 },
        lastError: null,
      },
    ],
  },
  system: { weekly_cron: "الأحد 06:00", drain_cron: "كل 10 دقائق", queue: true, window_days: 7, retention_days: 9 },
  audit: [{ created_at: "2026-10-01 08:00:00", actor: "mayorwatch", action: "source_added", mayor_id: "turin", source_id: "turin:x.example.org" }],
  ...extra,
});

test("the summary shows offices, active sites, what needs attention and today's AI quota", () => {
  const html = renderSummary(view());
  assert.match(html, /المكاتب/);
  assert.match(html, /المواقع المفعّلة/);
  assert.match(html, /is-bad/);
  assert.match(html, /380 \/ 400/);
});

test("an office card shows its sites, the slot meter and a site form that locks when full", () => {
  const html = renderOfficeCard(office(), 3);
  assert.match(html, /data-toggle="turin:comune.torino.it"/);
  assert.match(html, /data-check="turin:comune.torino.it"/);
  assert.match(html, /1\/3/);
  assert.match(html, /data-site-form="turin"/);
  assert.doesNotMatch(html, /data-delete-site/);
  assert.doesNotMatch(html, /data-edit-mayor/);

  const full = renderOfficeCard(
    office({ platforms: [site({ id: "a" }), site({ id: "b" }), site({ id: "c" })] }),
    3,
  );
  assert.match(full, /اكتملت المواقع المفعّلة/);
  assert.match(full, /<input name="url"[^>]*disabled/);
});

test("custom offices and custom sites expose delete and edit controls; registry ones do not", () => {
  const html = renderOfficeCard(
    office({ id: "riyadh", origin: "custom", platforms: [site({ id: "riyadh:x.org", origin: "custom", searches_by_name: true })] }),
    3,
  );
  assert.match(html, /data-delete-site="riyadh:x.org"/);
  assert.match(html, /data-edit-mayor="riyadh"/);
  assert.match(html, /data-delete-mayor="riyadh"/);
  assert.match(html, /يبحث باسم العمدة/);
});

test("an office without sites says so, and disabled sites are visibly off", () => {
  assert.match(renderOfficeCard(office({ platforms: [] }), 3), /لا مواقع لهذا المكتب بعد/);
  assert.equal(siteTone(site({ enabled: false })), "off");
  assert.equal(siteTone(site({ operational: { code: "worker_rejected" } })), "bad");
  assert.equal(siteTone(site({ operational: { code: "ok_no_new" } })), "good");
  assert.equal(siteTone(site({ operational: { code: "unchecked" } })), "muted");
});

test("filters find offices by name, by attention, by empty sites and by origin", () => {
  const offices = [
    office(),
    office({ id: "bad", name_ar: "عمدة آخر", name_en: "Other", platforms: [site({ operational: { code: "bad_url" } })] }),
    office({ id: "none", name_ar: "بلا مواقع", name_en: "None", platforms: [] }),
    office({ id: "mine", origin: "custom", name_ar: "مضاف", name_en: "Mine", platforms: [site()] }),
  ];
  assert.deepEqual(filterOffices(offices, { query: "لو روسو" }).map((o) => o.id), ["turin"]);
  assert.deepEqual(filterOffices(offices, { query: "stefano" }).map((o) => o.id), ["turin"]);
  assert.deepEqual(filterOffices(offices, { filter: "attention" }).map((o) => o.id), ["bad"]);
  assert.deepEqual(filterOffices(offices, { filter: "empty" }).map((o) => o.id), ["none"]);
  assert.deepEqual(filterOffices(offices, { filter: "custom" }).map((o) => o.id), ["mine"]);
  assert.match(renderOffices(view(offices), { query: "zzz" }), /لا مكاتب تطابق البحث/);
});

test("site lines are parsed and the official host marks a site as official", () => {
  assert.deepEqual(parseSiteLines("https://www.alriyadh.gov.sa/news\n\n news.example.org ", "alriyadh.gov.sa"), [
    { url: "https://www.alriyadh.gov.sa/news", platform: "official" },
    { url: "news.example.org", platform: "newspaper" },
  ]);
  assert.deepEqual(parseSiteLines("", ""), []);
});

test("add and edit forms carry every required identity field", () => {
  const html = renderAddPanel();
  for (const name of ["name_ar", "name_en", "city_ar", "city_en", "country_ar", "country_code", "native_lang", "sites_text"]) {
    assert.match(html, new RegExp(`name="${name}"`), name);
  }
  assert.match(html, /حفظ وفحص المواقع/);
  const edit = renderMayorFields({ name_ar: "نورة", name_en: "Noura", native_lang: "ar", official_host: "a.gov.sa" });
  assert.match(edit, /value="نورة"/);
  assert.match(edit, /<option value="ar" selected>/);
  assert.doesNotMatch(edit, /sites_text/);
});

test("results explain what was found, or why a site failed", () => {
  const ok = siteResultHtml({
    ok: true,
    trial: { recent_links: 14, about_mayor: 2, supplement_found: 1, samples: [{ title: "Park opens", url: "https://x.org/1" }] },
  });
  assert.match(ok, /تعمل/);
  assert.match(ok, /14/);
  assert.match(ok, /Park opens/);
  assert.match(siteResultHtml({ ok: false, input: "x.org", message: "تعذر فتح الموقع" }), /x\.org: تعذر فتح الموقع/);
  assert.match(siteResultHtml({ ok: true, works: false, fail_reason: "http_403" }), /لا تعمل الآن: http_403/);
  assert.doesNotMatch(siteResultHtml({ ok: false, message: "<script>x</script>" }), /<script>/);
});

test("AI cards show state, quota, the last error in words, and never a key", () => {
  const html = renderAi(view());
  assert.match(html, /جيميني/);
  assert.match(html, /يعمل/);
  assert.match(html, /5%/);
  assert.match(html, /العنوان لا يبدأ باسم العمدة/);
  assert.match(html, /موقوف من الإعداد/);
  assert.match(html, /GEMINI_API_KEY/);
  assert.doesNotMatch(html, /sk-|AIza/);
});

test("the system tab lists the schedule, the manual run and the audit trail", () => {
  const html = renderSystem(view());
  assert.match(html, /الأحد 06:00/);
  assert.match(html, /data-run-weekly/);
  assert.match(html, /mayorwatch/);
  assert.match(html, /أضاف موقعًا/);
  assert.match(html, /x\.example\.org/);
});

test("D1 timestamps are read as UTC and shown as relative time", () => {
  assert.equal(parseDbDate("2026-10-01 07:00:00").toISOString(), "2026-10-01T07:00:00.000Z");
  const now = Date.parse("2026-10-01T09:00:00Z");
  assert.equal(relTime("2026-10-01 08:59:40", now), "الآن");
  assert.equal(relTime("2026-10-01 08:30:00", now), "قبل 30 دقيقة");
  assert.equal(relTime("2026-10-01 05:00:00", now), "قبل 4 ساعة");
  assert.equal(relTime(null, now), "لم يُفحص بعد");
});

test("the main page links to the settings page and no longer carries the old overlay", () => {
  const index = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(index, /href="\/settings"/);
  assert.doesNotMatch(index, /settings-layer|add-mayor-form/);
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /renderSettings|settings-body/);
  const page = fs.readFileSync(new URL("../public/settings.html", import.meta.url), "utf8");
  for (const id of ["st-summary", "st-offices", "panel-ai", "panel-system", "st-search", "st-filter", "st-add-mayor"]) {
    assert.match(page, new RegExp(`id="${id}"`), id);
  }
});

test("form code never reads form.id, which a field named id would shadow", () => {
  const source = fs.readFileSync(new URL("../public/settings.js", import.meta.url), "utf8");
  assert.match(renderAddPanel(), /name="id"/);
  assert.doesNotMatch(source, /\bform\.id\b/);
});

test("add results stay visible after the page re-reads the overview", () => {
  const html = renderOfficeCard(office({ platforms: [site()] }), 3, {
    "office:turin": { ok: false, html: "x.org: تعذر فتح الموقع" },
    "turin:comune.torino.it": { ok: true, html: "تعمل · 3 روابط" },
  });
  assert.match(html, /x\.org: تعذر فتح الموقع/);
  assert.match(html, /st-note is-error/);
  assert.match(html, /تعمل · 3 روابط/);
});
