/**
 * صفحة الإعدادات: المكاتب ومواقعها، حالة الذكاء الاصطناعي، النظام وسجل التغييرات.
 * كل ما تعرضه يأتي من /api/settings/overview، وكل تغيير يمرّ بواجهة /api/settings/*
 * ثم تُعاد القراءة، فلا حالة محلية تخالف قاعدة البيانات.
 *
 * الدوال التي تبدأ بـ render نقية (بيانات ← HTML) لتُختبر دون متصفح.
 */

export const SITE_TYPES = { newspaper: "صحيفة", official: "رسمي", agency: "وكالة" };

export const LANGUAGES = [
  ["ar", "العربية"],
  ["en", "الإنجليزية"],
  ["es", "الإسبانية"],
  ["it", "الإيطالية"],
  ["fr", "الفرنسية"],
  ["de", "الألمانية"],
  ["tr", "التركية"],
  ["el", "اليونانية"],
  ["sq", "الألبانية"],
  ["ko", "الكورية"],
  ["ja", "اليابانية"],
  ["zh", "الصينية"],
  ["he", "العبرية"],
  ["fa", "الفارسية"],
  ["ru", "الروسية"],
  ["pt", "البرتغالية"],
];

const AI_SECRETS = {
  gemini: ["GEMINI_API_KEY", "GEMINI_MODEL", "AI_DAILY_LIMIT"],
  deepseek: ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "DEEPSEEK_DAILY_LIMIT"],
  qwen: ["QWEN_API_KEY", "QWEN_MODEL", "QWEN_DAILY_LIMIT"],
};

const ACTION_LABELS = {
  mayor_created: "أضاف عمدة",
  mayor_updated: "عدّل بيانات عمدة",
  mayor_deleted: "حذف عمدة",
  source_added: "أضاف موقعًا",
  source_removed: "حذف موقعًا",
  source_enabled: "غيّر تفعيل موقع",
};

const NEEDS_ATTENTION = new Set([
  "worker_rejected",
  "bad_url",
  "failing",
  "feed_stalled",
  "feed_corrupt",
  "empty_parse",
  "needs_javascript",
  "not_articles",
]);

export const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

export const num = (value) => new Intl.NumberFormat("en-US").format(Number(value) || 0);

/** تواريخ D1 بلا منطقة زمنية ("2026-10-01 07:18:38") وهي UTC. */
export function parseDbDate(value) {
  if (!value) return null;
  const raw = String(value);
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function relTime(value, now = Date.now()) {
  const date = parseDbDate(value);
  if (!date) return "لم يُفحص بعد";
  const minutes = Math.round((now - date.getTime()) / 60000);
  if (minutes < 1) return "الآن";
  if (minutes < 60) return `قبل ${num(minutes)} دقيقة`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `قبل ${num(hours)} ساعة`;
  return `قبل ${num(Math.round(hours / 24))} يومًا`;
}

export function siteTone(platform) {
  if (!platform.enabled) return "off";
  const code = platform.operational?.code || "";
  if (code === "ok" || code === "ok_no_new") return "good";
  if (code === "unchecked" || !code) return "muted";
  return NEEDS_ATTENTION.has(code) ? "bad" : "warn";
}

export function aiErrorReason(code) {
  const raw = String(code || "");
  const rules = [
    [/ai_ungrounded_headline:name_missing/, "العنوان لا يبدأ باسم العمدة"],
    [/ai_ungrounded_headline:quote_not_in_page/, "اقتباس غير موجود حرفيًا في الصفحة"],
    [/ai_ungrounded_headline:quote_without_mayor/, "الاقتباس لا يذكر العمدة"],
    [/ai_ungrounded_headline/, "عنوان بلا إسناد حرفي"],
    [/ai_has_no_grounded_facts/, "لا حقائق يمكن إسنادها"],
    [/ai_http_402/, "الحساب غير مدفوع"],
    [/ai_http_429|daily/, "نفدت الحصة"],
    [/ai_http_40[013]/, "رُفض الطلب (المفتاح أو الإعداد)"],
    [/ai_http_5\d\d|provider_error/, "خطأ مؤقت في الخدمة"],
    [/timeout|abort/i, "انتهت المهلة"],
  ];
  return rules.find(([pattern]) => pattern.test(raw))?.[1] || raw;
}

/* ───────────── الملخص ───────────── */

export function renderSummary(view) {
  const s = view.summary;
  const slots = (view.ai?.slots || []).filter((slot) => slot.bound && slot.enabled);
  const remaining = slots.reduce((sum, slot) => sum + slot.budget.remaining, 0);
  const limit = slots.reduce((sum, slot) => sum + slot.budget.dailyLimit, 0);
  const tile = (label, value, note, tone = "") =>
    `<div class="st-tile ${tone}"><span>${esc(label)}</span><b class="num">${esc(value)}</b><small>${esc(note)}</small></div>`;
  return [
    tile("المكاتب", num(s.offices), `${num(s.custom_offices)} مضاف من الإعدادات`),
    tile("المواقع المفعّلة", num(s.sources_active), `من ${num(s.sources_total)} · الحد ${num(s.cap_per_office)} لكل مكتب`),
    tile(
      "تحتاج انتباهًا",
      num(s.sources_attention + s.offices_without_sources),
      `${num(s.sources_attention)} موقع متعثر · ${num(s.offices_without_sources)} مكتب بلا مواقع`,
      s.sources_attention + s.offices_without_sources ? "is-bad" : "is-good",
    ),
    tile(
      "حصة الذكاء اليوم",
      limit ? `${num(remaining)} / ${num(limit)}` : "—",
      slots.length ? `${num(slots.length)} نموذج مربوط` : "لا نموذج مربوط",
      slots.length ? "" : "is-bad",
    ),
  ].join("");
}

/* ───────────── المكاتب ───────────── */

export function filterOffices(offices, { query = "", filter = "all" } = {}) {
  const q = query.trim().toLowerCase();
  return offices.filter((office) => {
    if (q) {
      const hay = [office.name_ar, office.name_en, office.name_native, office.city_ar, office.city_en, office.country_ar]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    const active = office.platforms.filter((platform) => platform.enabled);
    if (filter === "attention") return active.some((platform) => siteTone(platform) === "bad");
    if (filter === "empty") return active.length === 0;
    if (filter === "custom") return office.origin === "custom";
    return true;
  });
}

function renderSiteRow(platform, note) {
  const tone = siteTone(platform);
  const chips = [
    `<span class="st-chip">${esc(SITE_TYPES[platform.platform] || platform.platform_ar || "")}</span>`,
    platform.searches_by_name ? `<span class="st-chip st-chip-accent">يبحث باسم العمدة</span>` : "",
    platform.origin === "custom" ? `<span class="st-chip">مضاف</span>` : "",
  ].join("");
  const strategies = platform.strategies
    .filter((step) => !step.supplement)
    .map((step) => step.type_ar)
    .join(" ← ");
  return `<li class="st-site is-${tone}" data-site="${esc(platform.id)}">
    <span class="st-dot" aria-hidden="true"></span>
    <div class="st-site-main">
      <div class="st-site-title"><b>${esc(platform.name)}</b> <a class="st-domain num" href="https://${esc(platform.domain)}" target="_blank" rel="noopener noreferrer">${esc(platform.domain)}</a></div>
      <div class="st-site-meta">${chips}<span>${esc(strategies)}</span></div>
      <div class="st-site-status">${esc(platform.operational?.label || "—")} · ${platform.last_checked_at ? `فُحص ${esc(relTime(platform.last_checked_at))}` : "لم يُفحص بعد"}</div>
      ${note ? `<div class="st-note ${note.ok ? "" : "is-error"}">${note.html}</div>` : ""}
    </div>
    <div class="st-site-actions">
      <label class="st-switch" title="تفعيل الموقع أو إيقافه">
        <input type="checkbox" data-toggle="${esc(platform.id)}" ${platform.enabled ? "checked" : ""} />
        <span>${platform.enabled ? "مفعّل" : "موقوف"}</span>
      </label>
      <button type="button" class="st-btn st-btn-ghost" data-check="${esc(platform.id)}">فحص الآن</button>
      ${platform.origin === "custom" ? `<button type="button" class="st-btn st-btn-danger" data-delete-site="${esc(platform.id)}">حذف</button>` : ""}
    </div>
  </li>`;
}

export function renderOfficeCard(office, cap = 3, notes = {}) {
  const active = office.platforms.filter((platform) => platform.enabled).length;
  const full = active >= cap;
  const dots = Array.from({ length: cap }, (_, index) => `<i class="${index < active ? "is-on" : ""}"></i>`).join("");
  const custom = office.origin === "custom";
  const sites = office.platforms.length
    ? `<ul class="st-sites">${office.platforms.map((platform) => renderSiteRow(platform, notes[platform.id])).join("")}</ul>`
    : `<p class="st-empty-site">لا مواقع لهذا المكتب بعد. أضف موقعًا ليبدأ الرصد.</p>`;
  const officeNote = notes[`office:${office.id}`];
  return `<article class="st-office ${active ? "" : "is-empty"}" data-mayor="${esc(office.id)}" data-origin="${esc(office.origin)}">
    <header class="st-office-head">
      <div>
        <h3>${esc(office.name_ar)}${custom ? ` <span class="st-chip">مضاف</span>` : ""}</h3>
        <p class="st-office-sub"><span class="num">${esc(office.name_en)}</span> · ${esc(office.city_ar)} — ${esc(office.country_ar)}</p>
      </div>
      <div class="st-slots" title="المواقع المفعّلة من الحد الأقصى" aria-label="${active} من ${cap} مواقع مفعّلة">
        <span class="st-dots">${dots}</span><small class="num">${active}/${cap}</small>
      </div>
    </header>
    ${sites}
    <form class="st-site-form" data-site-form="${esc(office.id)}" autocomplete="off">
      <input name="url" type="text" dir="ltr" inputmode="url" required placeholder="${full ? "اكتملت المواقع المفعّلة — أوقف موقعًا لإضافة آخر" : "أضف موقعًا: example.com/news"}" aria-label="رابط الموقع" ${full ? "disabled" : ""} />
      <select name="platform" aria-label="نوع الموقع" ${full ? "disabled" : ""}>
        ${Object.entries(SITE_TYPES).map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}
      </select>
      <button type="submit" class="st-btn st-btn-primary" ${full ? "disabled" : ""}>إضافة وفحص</button>
      ${officeNote ? `<div class="st-note ${officeNote.ok ? "" : "is-error"}">${officeNote.html}</div>` : ""}
    </form>
    ${
      custom
        ? `<footer class="st-office-foot">
            <button type="button" class="st-btn st-btn-ghost" data-edit-mayor="${esc(office.id)}">تعديل البيانات</button>
            <button type="button" class="st-btn st-btn-danger" data-delete-mayor="${esc(office.id)}">حذف المكتب</button>
          </footer>`
        : ""
    }
  </article>`;
}

export function renderOffices(view, { query = "", filter = "all", notes = {} } = {}) {
  const shown = filterOffices(view.offices, { query, filter });
  if (!shown.length) return `<p class="st-empty">لا مكاتب تطابق البحث.</p>`;
  return shown.map((office) => renderOfficeCard(office, view.summary.cap_per_office, notes)).join("");
}

/* ───────────── نموذج الإضافة والتعديل ───────────── */

function field(name, label, { required = false, ltr = false, placeholder = "", value = "", maxlength = 120, wide = false } = {}) {
  return `<label class="st-field${wide ? " st-wide" : ""}">${esc(label)}${required ? " *" : ""}
    <input name="${name}" ${required ? "required" : ""} maxlength="${maxlength}" ${ltr ? 'dir="ltr"' : ""} placeholder="${esc(placeholder)}" value="${esc(value)}" />
  </label>`;
}

function languageSelect(selected = "") {
  return `<label class="st-field">لغة الرصد (لغة أخبار البلد) *
    <select name="native_lang" required>
      <option value="" disabled ${selected ? "" : "selected"}>اختر اللغة</option>
      ${LANGUAGES.map(([code, label]) => `<option value="${code}" ${code === selected ? "selected" : ""}>${label} (${code})</option>`).join("")}
    </select>
  </label>`;
}

export function renderMayorFields(mayor = {}, { withSites = false } = {}) {
  return `
    <fieldset><legend>الهوية</legend><div class="st-grid">
      ${field("name_ar", "الاسم بالعربية", { required: true, placeholder: "نورة العبدالله", value: mayor.name_ar })}
      ${field("name_en", "الاسم بالإنجليزية", { required: true, ltr: true, placeholder: "Noura Alabdullah", value: mayor.name_en })}
      ${field("name_native", "الاسم بلغة الأم (إن اختلف)", { ltr: true, placeholder: "يُنسخ من الإنجليزية إن تُرك", value: mayor.name_native && mayor.name_native !== mayor.name_en ? mayor.name_native : "" })}
    </div></fieldset>
    <fieldset><legend>المدينة والدولة</legend><div class="st-grid">
      ${field("city_ar", "المدينة بالعربية", { required: true, placeholder: "الرياض", maxlength: 80, value: mayor.city_ar })}
      ${field("city_en", "المدينة بالإنجليزية", { required: true, ltr: true, placeholder: "Riyadh", maxlength: 80, value: mayor.city_en })}
      ${field("country_ar", "الدولة بالعربية", { required: true, placeholder: "السعودية", maxlength: 80, value: mayor.country_ar })}
      ${field("country_code", "رمز الدولة (حرفان)", { required: true, ltr: true, placeholder: "SA", maxlength: 2, value: mayor.country_code })}
      ${languageSelect(mayor.native_lang)}
    </div></fieldset>
    ${
      withSites
        ? `<fieldset><legend>مواقع الرصد</legend><div class="st-grid">
            <label class="st-field st-wide">حتى 3 مواقع، رابط في كل سطر. يفحصها النظام ويختار طريقة القراءة تلقائيًا.
              <textarea name="sites_text" rows="3" dir="ltr" placeholder="https://example.com/news&#10;https://another-site.com"></textarea>
            </label>
          </div></fieldset>`
        : ""
    }
    <details class="st-advanced"><summary>خيارات متقدمة</summary>
      ${field("title_ar", "المنصب بالعربية", { placeholder: "عمدة الرياض", value: mayor.title_ar })}
      ${field("title_en", "المنصب بالإنجليزية", { ltr: true, placeholder: "Mayor of Riyadh", value: mayor.title_en })}
      ${field("official_host", "النطاق الرسمي للبلدية (للتصنيف)", { ltr: true, placeholder: "alriyadh.gov.sa", maxlength: 253, value: mayor.official_host })}
      ${withSites ? field("id", "معرّف المكتب (يُشتق تلقائيًا)", { ltr: true, placeholder: "riyadh-noura", maxlength: 40 }) : ""}
    </details>`;
}

export function renderAddPanel() {
  return `<form id="st-add-form" class="st-form" autocomplete="off">
    <h2>إضافة عمدة</h2>
    ${renderMayorFields({}, { withSites: true })}
    <div class="st-form-actions">
      <button type="submit" class="st-btn st-btn-primary">حفظ وفحص المواقع</button>
      <button type="button" class="st-btn st-btn-ghost" id="st-add-cancel">إلغاء</button>
      <p class="st-form-status" role="status"></p>
    </div>
  </form>`;
}

/** يحوّل أسطر المواقع إلى قائمة، ويعدّ موقعًا رسميًا ما طابق النطاق الرسمي. */
export function parseSiteLines(text, officialHost = "") {
  const official = String(officialHost || "").trim().replace(/^www\./i, "").toLowerCase();
  return String(text || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((url) => {
      const host = url.replace(/^[a-z]+:\/\//i, "").replace(/^www\./i, "").split(/[/?#]/)[0].toLowerCase();
      const isOfficial = official && (host === official || host.endsWith(`.${official}`));
      return { url, platform: isOfficial ? "official" : "newspaper" };
    });
}

/* ───────────── نتائج الإضافة والفحص ───────────── */

export function siteResultHtml(result) {
  if (!result.ok && result.works === undefined) {
    return `${esc(result.input ? `${result.input}: ` : "")}${esc(result.message || result.error || "فشل")}`;
  }
  const trial = result.trial || result;
  const works = result.works ?? result.ok;
  const samples = (trial.samples || [])
    .map((sample) => `<li><a href="${esc(sample.url)}" target="_blank" rel="noopener noreferrer">${esc(sample.title)}</a></li>`)
    .join("");
  const head = works
    ? `تعمل · ${num(trial.recent_links)} رابطًا حديثًا · ${num(trial.about_mayor)} يذكر العمدة${trial.supplement_found ? ` · ${num(trial.supplement_found)} من بحث الموقع` : ""}`
    : `لا تعمل الآن: ${esc(result.fail_reason || result.status || "غير معروف")}`;
  return `${esc(head)}${samples ? `<ul class="st-samples">${samples}</ul>` : ""}`;
}

/* ───────────── الذكاء الاصطناعي ───────────── */

export function renderAi(view) {
  const slots = view.ai?.slots || [];
  if (!slots.length) return `<p class="st-empty">لا بيانات عن النماذج.</p>`;
  const cards = slots
    .map((slot) => {
      const b = slot.budget;
      let state = ["يعمل", "good"];
      if (!slot.enabled) state = ["موقوف من الإعداد", "off"];
      else if (!slot.bound) state = ["المفتاح غير مربوط", "bad"];
      else if (slot.blocked) state = ["متوقف مؤقتًا", "warn"];
      else if (b.remaining <= 0) state = ["نفدت حصة اليوم", "warn"];
      const pct = b.dailyLimit ? Math.min(100, Math.round((b.used / b.dailyLimit) * 100)) : 0;
      const vars = AI_SECRETS[slot.id] || [];
      return `<article class="st-ai is-${state[1]}">
        <header><h3>${esc(slot.nameAr)}</h3><span class="st-pill is-${state[1]}">${esc(state[0])}</span></header>
        <p class="st-ai-model num">${esc(slot.model)}</p>
        <div class="st-meter" role="img" aria-label="${pct}% من الحصة مستهلك"><i style="width:${pct}%"></i></div>
        <p class="st-ai-nums"><b class="num">${num(b.used)}</b> مستهلك من <span class="num">${num(b.dailyLimit)}</span> · بقي <b class="num">${num(b.remaining)}</b> · فاصل <span class="num">${num(b.minIntervalMs)}</span>ms</p>
        <p class="st-ai-err">${slot.lastError ? `آخر خطأ: ${esc(aiErrorReason(slot.lastError.code))} · ${esc(relTime(slot.lastError.at))}` : "لا أخطاء مسجلة"}</p>
        <p class="st-ai-vars">المفتاح: ${slot.hasKey ? "موجود" : "غير موجود"} · يُضبط من <code dir="ltr">${esc(vars[0] || "")}</code></p>
      </article>`;
    })
    .join("");
  return `<div class="st-ai-grid">${cards}</div>
    <p class="st-hint">المفاتيح أسرار Cloudflare لا تظهر ولا تُعدَّل من هنا. أضفها بـ <code dir="ltr">npx wrangler secret put NAME</code>، وغيّر الطراز والحد من Variables في لوحة Cloudflare دون نشر جديد. ويعمل الخبر على النموذج الذي فيه سعة الآن.</p>`;
}

/* ───────────── النظام والسجل ───────────── */

export function renderSystem(view) {
  const sys = view.system;
  const rows = [
    ["الرصد الأسبوعي", sys.weekly_cron],
    ["تصريف الموجزات المعلّقة", sys.drain_cron],
    ["طابور التشغيل", sys.queue ? "مربوط" : "غير مربوط"],
    ["نافذة العرض", `${num(sys.window_days)} أيام`],
    ["الاحتفاظ بالأخبار", `${num(sys.retention_days)} أيام (ما لا قرار عليه)`],
    ["الحد الأقصى للمواقع", `${num(view.summary.cap_per_office)} مفعّلة لكل مكتب`],
  ]
    .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join("");
  const names = new Map(view.offices.map((office) => [office.id, office.name_ar]));
  const audit = view.audit.length
    ? view.audit
        .map((row) => {
          const target = row.source_id ? row.source_id.split(":").slice(1).join(":") : names.get(row.mayor_id) || row.mayor_id || "";
          return `<li><span class="num">${esc(relTime(row.created_at))}</span><b>${esc(row.actor)}</b> ${esc(ACTION_LABELS[row.action] || row.action)} <span class="st-audit-target">${esc(target)}</span></li>`;
        })
        .join("")
    : `<li class="st-empty">لا تغييرات مسجلة بعد.</li>`;
  return `<div class="st-system">
    <section class="st-card"><h2>الجدولة والنظام</h2><dl class="st-kv">${rows}</dl></section>
    <section class="st-card"><h2>تشغيل يدوي</h2>
      <p class="st-hint">يرصد كل المكاتب الآن بدل انتظار الأحد. يستهلك من حصة الذكاء الاصطناعي اليومية.</p>
      <button type="button" class="st-btn st-btn-primary" data-run-weekly>رصد كل المكاتب الآن</button>
      <p class="st-form-status" id="st-run-status" role="status"></p>
      <p class="st-hint">للتشخيص: <a href="/api/health">/api/health</a> · <a href="/api/diagnostics">/api/diagnostics</a></p>
    </section>
    <section class="st-card st-wide"><h2>آخر التغييرات</h2><ol class="st-audit">${audit}</ol></section>
  </div>`;
}

/* ───────────── التشغيل في المتصفح ───────────── */

function init() {
  const $ = (id) => document.getElementById(id);
  const state = { view: null, query: "", filter: "all", notes: {}, tab: "offices" };

  async function api(path, options = {}) {
    const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.message || data.error || "request_failed");
      error.data = data;
      throw error;
    }
    return data;
  }

  let toastTimer = null;
  function toast(message, bad = false) {
    const el = $("st-toast");
    el.textContent = message;
    el.classList.toggle("is-error", bad);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 4500);
  }

  function paint() {
    const view = state.view;
    if (!view) return;
    $("st-summary").innerHTML = renderSummary(view);
    $("st-offices").innerHTML = renderOffices(view, { query: state.query, filter: state.filter, notes: state.notes });
    $("panel-ai").innerHTML = renderAi(view);
    $("panel-system").innerHTML = renderSystem(view);
  }

  async function load() {
    try {
      state.view = await api("/api/settings/overview");
      paint();
    } catch (error) {
      $("st-offices").innerHTML = `<p class="st-empty is-error">تعذر تحميل الإعدادات: ${esc(error.message)}</p>`;
    }
  }

  function showTab(tab) {
    state.tab = tab;
    for (const button of document.querySelectorAll("[data-tab]")) {
      button.setAttribute("aria-selected", String(button.dataset.tab === tab));
    }
    for (const name of ["offices", "ai", "system"]) $(`panel-${name}`).hidden = name !== tab;
    if (location.hash !== `#${tab}`) history.replaceState(null, "", `#${tab}`);
  }

  async function guarded(button, busyLabel, work) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = busyLabel;
    try {
      await work();
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  document.addEventListener("click", async (event) => {
    const target = event.target.closest("button");
    if (!target) return;

    if (target.dataset.tab) return showTab(target.dataset.tab);
    if (target.id === "st-add-mayor") {
      const panel = $("st-add-panel");
      panel.hidden = !panel.hidden;
      if (!panel.hidden) {
        panel.innerHTML = renderAddPanel();
        panel.scrollIntoView({ block: "start", behavior: "smooth" });
      }
      return;
    }
    if (target.id === "st-add-cancel") {
      $("st-add-panel").hidden = true;
      return;
    }
    if (target.dataset.check) {
      const id = target.dataset.check;
      await guarded(target, "يفحص…", async () => {
        try {
          const result = await api(`/api/settings/sources/${encodeURIComponent(id)}/check`, { method: "POST" });
          state.notes[id] = { ok: result.works, html: siteResultHtml(result) };
        } catch (error) {
          state.notes[id] = { ok: false, html: esc(error.message) };
        }
        await load();
      });
      return;
    }
    if (target.dataset.deleteSite) {
      if (!window.confirm("حذف هذا الموقع من المكتب؟ الأخبار المحفوظة منه تبقى.")) return;
      try {
        await api(`/api/settings/sources/${encodeURIComponent(target.dataset.deleteSite)}`, { method: "DELETE" });
        toast("حُذف الموقع");
        await load();
      } catch (error) {
        toast(error.message, true);
      }
      return;
    }
    if (target.dataset.deleteMayor) {
      if (!window.confirm("حذف هذا المكتب ومواقعه؟ لا يمكن التراجع، ويُرفض الحذف إن وُجدت قرارات محفوظة.")) return;
      try {
        await api(`/api/settings/mayors/${encodeURIComponent(target.dataset.deleteMayor)}`, { method: "DELETE" });
        toast("حُذف المكتب");
        await load();
      } catch (error) {
        toast(error.message, true);
      }
      return;
    }
    if (target.dataset.editMayor) {
      const office = state.view.offices.find((row) => row.id === target.dataset.editMayor);
      const dialog = $("st-edit-dialog");
      dialog.innerHTML = `<form method="dialog" id="st-edit-form" class="st-form" data-id="${esc(office.id)}">
        <h2>تعديل ${esc(office.name_ar)}</h2>
        ${renderMayorFields(office)}
        <div class="st-form-actions">
          <button type="submit" class="st-btn st-btn-primary" value="save">حفظ</button>
          <button type="button" class="st-btn st-btn-ghost" id="st-edit-cancel">إلغاء</button>
          <p class="st-form-status" role="status"></p>
        </div>
      </form>`;
      dialog.showModal();
      return;
    }
    if (target.id === "st-edit-cancel") {
      $("st-edit-dialog").close();
      return;
    }
    if (target.dataset.runWeekly) {
      if (!window.confirm("رصد كل المكاتب الآن؟ يستهلك من حصة الذكاء الاصطناعي اليومية.")) return;
      await guarded(target, "يبدأ…", async () => {
        try {
          await api("/api/scan/weekly", { method: "POST" });
          $("st-run-status").textContent = "بدأ الرصد في الخلفية. تابع التقدم من صفحة الرصد.";
        } catch (error) {
          $("st-run-status").textContent = error.message;
        }
      });
    }
  });

  document.addEventListener("change", async (event) => {
    const input = event.target;
    if (input.dataset?.toggle) {
      input.disabled = true;
      try {
        await api(`/api/settings/sources/${encodeURIComponent(input.dataset.toggle)}`, {
          method: "POST",
          body: JSON.stringify({ enabled: input.checked }),
        });
      } catch (error) {
        toast(error.message, true);
      }
      await load();
    }
    if (input.id === "st-filter") {
      state.filter = input.value;
      paint();
    }
  });

  $("st-search").addEventListener("input", (event) => {
    state.query = event.target.value;
    paint();
  });

  document.addEventListener("submit", async (event) => {
    const form = event.target;

    if (form.dataset.siteForm) {
      event.preventDefault();
      const mayorId = form.dataset.siteForm;
      const button = form.querySelector("[type=submit]");
      await guarded(button, "يفحص ويجرّب…", async () => {
        try {
          const result = await api(`/api/settings/mayors/${encodeURIComponent(mayorId)}/sites`, {
            method: "POST",
            body: JSON.stringify({ url: form.url.value, platform: form.platform.value }),
          });
          state.notes[result.id] = { ok: true, html: siteResultHtml(result) };
          delete state.notes[`office:${mayorId}`];
          toast(`أُضيف ${result.domain}`);
        } catch (error) {
          state.notes[`office:${mayorId}`] = { ok: false, html: esc(error.message) };
        }
        await load();
      });
      return;
    }

    if (form.getAttribute("id") === "st-add-form") {
      event.preventDefault();
      const status = form.querySelector(".st-form-status");
      const button = form.querySelector("[type=submit]");
      const data = Object.fromEntries(new FormData(form).entries());
      const sites = parseSiteLines(data.sites_text, data.official_host);
      delete data.sites_text;
      for (const key of Object.keys(data)) if (!String(data[key]).trim()) delete data[key];
      data.native_lang_ar = LANGUAGES.find(([code]) => code === data.native_lang)?.[1] || "";
      if (sites.length) data.sites = sites;
      status.classList.remove("is-error");
      await guarded(button, sites.length ? "يحفظ ويفحص المواقع…" : "يحفظ…", async () => {
        try {
          const created = await api("/api/settings/mayors", { method: "POST", body: JSON.stringify(data) });
          for (const site of created.sites || []) {
            state.notes[site.ok ? site.id : `office:${created.mayor.id}`] = { ok: site.ok, html: siteResultHtml(site) };
          }
          $("st-add-panel").hidden = true;
          toast(`أُضيف ${created.mayor.name_ar}`);
          await load();
          document.querySelector(`[data-mayor="${CSS.escape(created.mayor.id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
        } catch (error) {
          status.textContent = error.message;
          status.classList.add("is-error");
        }
      });
      return;
    }

    if (form.getAttribute("id") === "st-edit-form") {
      event.preventDefault();
      const status = form.querySelector(".st-form-status");
      const data = Object.fromEntries(new FormData(form).entries());
      data.native_lang_ar = LANGUAGES.find(([code]) => code === data.native_lang)?.[1] || "";
      try {
        await api(`/api/settings/mayors/${encodeURIComponent(form.dataset.id)}`, { method: "PATCH", body: JSON.stringify(data) });
        $("st-edit-dialog").close();
        toast("حُفظت التعديلات");
        await load();
      } catch (error) {
        status.textContent = error.message;
        status.classList.add("is-error");
      }
    }
  });

  const initial = location.hash.replace("#", "");
  showTab(["offices", "ai", "system"].includes(initial) ? initial : "offices");
  load();
}

if (typeof document !== "undefined" && document.getElementById("settings-root")) init();
