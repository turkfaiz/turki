const state = {
  status: "inbox",
  mayors: [],
  items: [],
  selectedId: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);

function num(value) {
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

function sourceLabel(source) {
  return {
    google_news: "Google News",
    bing_news: "Bing News",
    official: "Official",
    inoreader: "Inoreader",
    gdelt: "GDELT",
  }[source] || source;
}

function confidenceLabel(c) {
  return { raw: "خام", merged: "مدمج", official: "مؤكد رسمي" }[c] || c;
}

function displayTitle(it) {
  return it.news_title_ar || it.title || "—";
}

function briefBadge(item) {
  const engine = String(item.trans_engine || "");
  if (engine.startsWith("brief-ai-gemini-v2:")) return "ملخص AI موثّق";
  if (engine === "brief-deferred") return "بانتظار حصة AI — يستأنف تلقائيًا";
  if (engine === "brief-ai-error") return "تعذر AI — ستُعاد المحاولة";
  return "بانتظار AI";
}

/** يترجم رمز الخطأ إلى سبب مفهوم، فلا يرى المستخدم «تعذر» بلا تفسير. */
function briefErrorReason(code) {
  const raw = String(code || "");
  if (!raw) return "";
  const rules = [
    [/ai_deferred:daily_limit|ai_http_429.*day|daily/i, "نفدت حصة نداءات الذكاء الاصطناعي لليوم، ويستأنف تلقائيًا بعد تصفير الحصة."],
    [/ai_deferred:rate_pacing/i, "تباعد مقصود بين النداءات لحماية حد الدقيقة، ويكمل تلقائيًا."],
    [/ai_deferred|ai_http_429/i, "المزوّد رفض الطلب مؤقتًا لتجاوز الحد، والنظام في تهدئة ثم يعيد المحاولة."],
    [/ai_http_5\d\d|provider_error/i, "خطأ مؤقت في خدمة الذكاء الاصطناعي، وتُعاد المحاولة."],
    [/aborted|AbortError|timeout/i, "انتهت المهلة قبل أن يرد الذكاء الاصطناعي على قراءة الصفحة."],
    [/ai_ungrounded_headline/i, "لم يجد الذكاء الاصطناعي في نص الصفحة جملة حرفية تُسند العنوان وتذكر العمدة بالاسم، فرُفض العنوان بدل نشر عنوان غير موثّق."],
    [/ai_has_no_grounded_facts/i, "لا توجد في الصفحة حقائق يمكن إسنادها باقتباس حرفي، فالصفحة على الأغلب ليست خبرًا عن العمدة."],
    [/ai_headline_not_supported|ai_facts_not_supported/i, "رفض المدقق المستقل الادعاء لعدم مطابقته الاقتباس الأصلي."],
    [/article_text_too_short/i, "نص الصفحة أقصر من أن يُستخرج منه موجز موثّق."],
    [/ai_empty_response|ai_invalid_json/i, "جاء رد الذكاء الاصطناعي فارغًا أو غير صالح."],
    [/ai_not_configured/i, "مفتاح الذكاء الاصطناعي غير مربوط."],
  ];
  for (const [pattern, message] of rules) {
    if (pattern.test(raw)) return message;
  }
  return `سبب تقني: ${raw}`;
}

function briefErrorBox(item) {
  const engine = String(item.trans_engine || "");
  if (!item.brief_error || engine.startsWith("brief-ai-gemini-v2:")) return "";
  const attempts = Number(item.brief_attempts) || 0;
  const exhausted = attempts >= 5;
  const heading = exhausted
    ? `توقفت المحاولات بعد ${num(attempts)} محاولات`
    : engine === "brief-deferred"
      ? "التلخيص مؤجل ويكمل تلقائيًا"
      : `تعذر التلخيص — المحاولة ${num(attempts)} من 5`;
  return `<div class="brief-error">
      <b>${escapeHtml(heading)}</b><br />${escapeHtml(briefErrorReason(item.brief_error))}
      ${exhausted ? `<div><button type="button" class="btn-retry" data-act="retry-brief">إعادة المحاولة الآن</button></div>` : ""}
    </div>`;
}

function factItems(snippet) {
  return String(snippet || "")
    .split(/\n+/)
    .flatMap((line) => line.split(/\s*[•📌·]\s*/))
    .map((s) => s.replace(/^[•📌·]\s*/, "").trim())
    .filter((s) => s.length >= 4);
}

function mergedSources(item) {
  try {
    const rows = JSON.parse(item.merged_sources || "[]");
    if (Array.isArray(rows) && rows.length) return rows;
  } catch {
    /* use the primary source below */
  }
  return [{ domain: item.publisher_domain, url: item.url, title: item.title }];
}

function originKey(value) {
  return decodeEntities(value)
    .replace(/\s*[-–—|]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function originDisplay(item) {
  const title = decodeEntities(item.title || "");
  const snippet = decodeEntities(item.snippet || "");
  if (!snippet) return title;
  if (originKey(snippet) === originKey(title)) return title;
  if (title.includes(snippet) || snippet.includes(title)) {
    return title.length >= snippet.length ? title : snippet;
  }
  const a = originKey(title);
  const b = originKey(snippet);
  if (!a || !b) return title;
  if (a.startsWith(b.slice(0, Math.min(48, b.length))) || b.startsWith(a.slice(0, Math.min(48, a.length)))) {
    return title;
  }
  return title;
}

function decodeEntities(value) {
  return String(value ?? "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/&#x0*a0;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return decodeEntities(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function selectedMayorId() {
  return $("mayor_id")?.value || "";
}

function syncSearchEnabled() {
  const btn = $("search-btn");
  if (!btn) return;
  btn.disabled = state.busy;
}

function setDeskStatus(text) {
  const el = $("desk-status");
  if (el) el.textContent = text;
}

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || "request_failed");
  return data;
}

async function loadMayors() {
  const { mayors } = await api("/api/mayors");
  state.mayors = mayors;
  $("mayor_id").innerHTML =
    `<option value="">كل المكاتب (${mayors.length})</option>` +
    mayors.map((m) => `<option value="${m.id}">${m.name_ar} — ${m.city_ar}</option>`).join("");
  syncSearchEnabled();
}

async function loadStats() {
  const s = await api("/api/stats");
  const mayorId = selectedMayorId();
  const row = mayorId ? (s.byMayor || []).find((m) => m.mayor_id === mayorId) : null;
  $("stat-inbox").textContent = num(mayorId ? row?.inbox || 0 : s.inbox);
  $("stat-approved").textContent = num(mayorId ? row?.approved || 0 : s.approved);
  $("stat-excluded").textContent = num(mayorId ? row?.excluded || 0 : s.excluded);
  $("stat-dup").textContent = num(s.week?.duplicates);
  state.aiReady = s.sources?.ai_brief === "ready";
  $("last-weekly").textContent = s.lastWeekly ? fmtDate(s.lastWeekly.started_at) : "—";
}

function humanWait(seconds) {
  const total = Number(seconds) || 0;
  if (total < 90) return `${Math.max(1, Math.round(total))} ثانية`;
  if (total < 5400) return `${Math.round(total / 60)} دقيقة`;
  return `${Math.round(total / 3600)} ساعة`;
}

function pct(part, whole) {
  const total = Number(whole) || 0;
  if (!total) return 0;
  return Math.max(0, Math.min(100, (Number(part) || 0) / total * 100));
}

/** قراءة رئيسية في شريط اللوحة: رقم، ومقياس نسبي، وسطر يشرح المعنى. */
function readout(label, value, note, percent = null, tone = "") {
  const meter =
    percent === null
      ? ""
      : `<div class="meter"><span style="width:${Math.round(percent)}%"></span></div>`;
  return `<div class="readout ${tone}">
      <span class="readout-label">${escapeHtml(label)}</span>
      <b class="readout-value num">${escapeHtml(String(value))}</b>
      ${meter}
      <small class="readout-note">${escapeHtml(note)}</small>
    </div>`;
}

const TOOL_ICONS = {
  list: '<path d="M4 6h12M4 10h12M4 14h8"/>',
  page: '<path d="M5 3h7l4 4v10H5z"/><path d="M12 3v4h4"/>',
  spark: '<path d="M10 3l1.8 4.2L16 9l-4.2 1.8L10 15l-1.8-4.2L4 9l4.2-1.8z"/>',
  merge: '<path d="M6 3v4a4 4 0 004 4h4"/><path d="M12 8l3 3-3 3"/><path d="M6 11v6"/>',
  queue: '<path d="M3 5h14M3 10h14M3 15h14"/><circle cx="6" cy="5" r="1.4"/><circle cx="10" cy="10" r="1.4"/>',
  clock: '<circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/>',
  db: '<ellipse cx="10" cy="5" rx="6" ry="2.4"/><path d="M4 5v10c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4V5"/><path d="M4 10c0 1.3 2.7 2.4 6 2.4s6-1.1 6-2.4"/>',
  ban: '<circle cx="10" cy="10" r="7"/><path d="M5.5 5.5l9 9"/>',
};

function toolIcon(name) {
  return `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${TOOL_ICONS[name] || TOOL_ICONS.list}</svg>`;
}

/** رقاقة أداة: أيقونة، واسم، ونقطة حالة تفاعلية تكشف تفصيل عملها. */
function toolChip(tool) {
  const tone = tool.ok === null ? "off" : tool.ok ? "ok" : "bad";
  const label = tool.ok === null ? "معطّلة بالحوكمة" : tool.ok ? "تعمل" : "متوقفة";
  return `<button type="button" class="tool ${tone}" data-tool="${escapeHtml(tool.id)}"
      aria-expanded="false" title="${escapeHtml(label)}">
      <span class="tool-icon">${toolIcon(tool.icon)}</span>
      <span class="tool-name">${escapeHtml(tool.name)}</span>
      <span class="tool-dot" aria-hidden="true"></span>
      <span class="tool-state">${escapeHtml(label)}</span>
    </button>`;
}

function statusRow(tone, title, note) {
  return `<li><span class="diag-dot ${tone}"></span>
      <span>${title}<small>${note}</small></span></li>`;
}

function sourceTone(source) {
  if (Number(source.consecutive_failures) >= 3) return "bad";
  if (source.last_ok_at) return "ok";
  return "warn";
}

/**
 * «لم يُفحص بعد» كانت صياغة مضلّلة: كل مصدر فُحص عند إعداد السجل، والمقصود أن
 * هذا التشغيل لم يفتحه بعد. النص هنا يفصل بين الأمرين بصراحة.
 */
function sourceTitle(source) {
  const role = `${source.tier === 0 ? "غرفة أخبار رسمية" : "تغطية محلية"} · ${source.kind === "feed" ? "تغذية RSS" : "صفحة أخبار الموقع"}`;
  const curated = source.verified
    ? `مُتحقق منه بالفحص عند الإعداد (${source.curated_at || "—"})`
    : `فُحص عند الإعداد ولم يستجب من شبكة الفحص، وبقي لأنه المصدر الأصلي للمدينة`;
  const runtime = source.last_ok_at
    ? `آخر تشغيل: ${num(source.last_items)} عنصرًا`
    : source.last_status
      ? `آخر تشغيل: ${String(source.last_status).slice(0, 60)}`
      : "لم يُشغّل بعد في هذه البيئة";
  return `${role}\n${curated}\n${runtime}`;
}

function renderDiagnostics(d) {
  const b = d.brief || {};
  const budget = d.ai?.budget || {};
  const reg = d.registry || {};
  const waiting = (b.pending || 0) + (b.waitingQuota || 0);
  const briefTotal = (b.completed || 0) + waiting + (b.failed || 0);

  $("diag-headline").textContent = budget.blocked
    ? `متوقف مؤقتًا · يستأنف بعد ${humanWait(budget.resumesInSeconds)}`
    : waiting
      ? `${num(waiting)} بانتظار التلخيص · ${num(b.completed || 0)} مكتمل`
      : `${num(b.completed || 0)} موجزًا مكتملًا · لا شيء معلّق`;

  const grouped = new Map();
  for (const source of d.sources || []) {
    if (!grouped.has(source.mayor_id)) grouped.set(source.mayor_id, []);
    grouped.get(source.mayor_id).push(source);
  }

  const aiTone = !d.ai?.configured ? "is-bad" : budget.blocked ? "is-warn" : "is-good";
  const aiNote = !d.ai?.configured
    ? "المفتاح غير مربوط"
    : budget.blocked
      ? `متوقف · يستأنف بعد ${humanWait(budget.resumesInSeconds)}`
      : `${d.ai.model || "—"} · نداء واحد لكل موجز`;

  $("diag-body").innerHTML = `
    <section class="board-section">
      <h4>١ · القراءات الرئيسية</h4>
      <div class="board-bar">
      ${readout(
        "موجزات مكتملة",
        `${num(b.completed)}${briefTotal ? ` / ${num(briefTotal)}` : ""}`,
        briefTotal ? `${Math.round(pct(b.completed, briefTotal))}% من أخبار النافذة` : "لا أخبار بعد",
        pct(b.completed, briefTotal),
        b.completed ? "is-good" : "",
      )}
      ${readout(
        "رصيد الذكاء الاصطناعي",
        `${num(budget.remaining)} / ${num(budget.dailyLimit)}`,
        aiNote,
        pct(budget.remaining, budget.dailyLimit),
        aiTone,
      )}
      ${readout(
        "المصادر السليمة",
        `${num(reg.healthy)} / ${num(reg.total)}`,
        `${num(reg.perOffice)} مصادر معتمدة لكل مكتب · محركات البحث معطّلة`,
        pct(reg.healthy, reg.total),
        reg.failing ? "is-warn" : "is-good",
      )}
      ${readout(
        "نافذة الرصد",
        `${num(d.windowDays)} أيام`,
        `${num(d.window?.total)} خبرًا داخل النافذة · يُحذف ما بعدها بعد ${num(d.retentionDays)} أيام`,
        null,
      )}
      </div>
    </section>

    <section class="board-section">
      <h4>٢ · الأدوات — اضغط أي أداة لمعرفة عملها</h4>
      <div class="tools">${(d.tools || []).map(toolChip).join("")}</div>
      <p class="tool-detail" id="tool-detail" hidden></p>
    </section>

    <div class="board-panels">
      <section class="panel">
        <h4>٣ · مسار التلخيص</h4>
        <ul class="gauges">
          ${[
            ["مكتمل وموثّق", b.completed, "ok"],
            ["بانتظار الدور", b.pending, "wait"],
            ["بانتظار الحصة", b.waitingQuota, "warn"],
            ["تعذر نهائيًا", b.exhausted, "bad"],
          ].map(([label, value, tone]) => `
            <li class="gauge ${tone}">
              <span class="gauge-head"><span>${escapeHtml(label)}</span><b class="num">${num(value)}</b></span>
              <div class="meter"><span style="width:${Math.round(pct(value, briefTotal || 1))}%"></span></div>
            </li>`).join("")}
        </ul>
        <ul class="diag-list">
          ${statusRow(
            d.ai?.configured ? (budget.blocked ? "warn" : "ok") : "bad",
            d.ai?.configured
              ? budget.blocked
                ? escapeHtml(briefErrorReason(`ai_deferred:${budget.blockReason}`))
                : "يعمل ضمن الحصة"
              : "مفتاح الذكاء الاصطناعي غير مربوط",
            `مهمة تصريف كل عشر دقائق تُكمل المعلّق · تباعد ${num(Math.round((budget.minIntervalMs || 0) / 100) / 10)} ثانية · حصة الدمج ${num(budget.mergeLimit)}`,
          )}
          ${(b.errors || []).map((row) =>
            statusRow(
              /deferred|429/i.test(row.code) ? "warn" : "bad",
              escapeHtml(briefErrorReason(row.code)),
              `${num(row.count)} خبر · أقصى محاولات ${num(row.attempts)} من ${num(b.maxAttempts)}`,
            )).join("")}
        </ul>
      </section>

      <section class="panel">
        <h4>٤ · آخر رصد</h4>
        ${d.lastScan
          ? `<ul class="diag-list">
              ${statusRow(
                Number(d.lastScan.error_count) ? "warn" : "ok",
                `${escapeHtml(d.lastScan.type === "manual" ? "بحث يدوي" : "رصد أسبوعي")} — ${escapeHtml(fmtDate(d.lastScan.started_at))}`,
                `جديد ${num(d.lastScan.found_count)} · مدمج ${num(d.lastScan.duplicate_count)} · مستبعد ${num(d.lastScan.excluded_count)} · مصادر متعثرة ${num(d.lastScan.error_count)}`,
              )}
            </ul>`
          : `<p class="diag-note">لم يُشغّل رصد بعد.</p>`}
        <h4 class="panel-sub">٥ · المصادر المعتمدة — ${num(reg.perOffice)} لكل مكتب</h4>
        <div class="office-grid">
          ${[...grouped.values()].map((sources) => `
            <article class="office-card">
              <b>${escapeHtml(sources[0].name_ar)}</b>
              <span class="office-sources">
                ${sources.map((s) => `<i class="src ${sourceTone(s)}" title="${escapeHtml(sourceTitle(s))}">${escapeHtml(s.domain)}</i>`).join("")}
              </span>
            </article>`).join("")}
        </div>
        <p class="diag-note">
          نقطة خضراء: استجاب في آخر تشغيل · برتقالية: مُعتمد بعد فحص عند الإعداد ولم يُشغّل بعد · حمراء: متعثر ويُراجَع.
        </p>
      </section>
    </div>`;
}

async function loadDiagnostics() {
  try {
    const data = await api("/api/diagnostics");
    state.tools = data.tools || [];
    renderDiagnostics(data);
  } catch (error) {
    $("diag-body").innerHTML = `<p class="diag-note">تعذر تحميل التفاصيل: ${escapeHtml(error.message)}</p>`;
  }
}

$("diag-body").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tool]");
  if (!btn) return;
  const box = $("tool-detail");
  const tool = (state.tools || []).find((entry) => entry.id === btn.dataset.tool);
  const alreadyOpen = btn.getAttribute("aria-expanded") === "true";
  document.querySelectorAll("button[data-tool]").forEach((el) => {
    el.setAttribute("aria-expanded", "false");
    el.classList.remove("on");
  });
  if (alreadyOpen || !tool) {
    box.hidden = true;
    return;
  }
  btn.setAttribute("aria-expanded", "true");
  btn.classList.add("on");
  box.hidden = false;
  box.innerHTML = `<b>${escapeHtml(tool.name)}</b> — ${escapeHtml(tool.detail)}`;
});

function itemsQuery() {
  const qs = new URLSearchParams({ status: state.status });
  const mayorId = selectedMayorId();
  if (mayorId) qs.set("mayor_id", mayorId);
  return `/api/items?${qs.toString()}`;
}

async function loadItems() {
  $("list").innerHTML = `<div class="empty">جاري التحميل…</div>`;
  const { items } = await api(itemsQuery());
  state.items = items;
  renderItems(items);
}

function renderItems(items) {
  if (!items.length) {
    $("list").innerHTML = `<div class="empty">لا توجد بطاقات في هذا القسم. اضغط بحث لتشغيل المسار على النطاق الحالي.</div>`;
    return;
  }
  $("list").innerHTML = items
    .map((it) => `
      <button type="button" class="result ${it.id === state.selectedId ? "selected" : ""}" data-id="${it.id}">
        <p class="kicker">${escapeHtml(it.country_ar)} · ${escapeHtml(it.city_ar)} · ${escapeHtml(it.name_ar)}</p>
        <h3 class="headline">${escapeHtml(displayTitle(it))}</h3>
        ${factItems(it.news_snippet_ar)[0] ? `<p class="fact-line">${escapeHtml(factItems(it.news_snippet_ar)[0])}</p>` : ""}
        <div class="meta">
          <span class="badge">${sourceLabel(it.source)}</span>
          ${it.publisher_tier === 0 || it.publisher_tier === 1 ? `<span class="badge official">معتمد</span>` : ""}
          ${it.publisher_domain ? `<span class="badge">${escapeHtml(it.publisher_domain)}</span>` : ""}
          ${Number(it.source_count) > 1 ? `<span class="badge">${num(it.source_count)} مصادر مدمجة</span>` : ""}
          <span class="badge ${String(it.trans_engine || "").startsWith("brief-ai-gemini-v2:") ? "official" : ""}">${briefBadge(it)}</span>
          ${it.exclude_reason ? `<span class="badge">${escapeHtml(it.exclude_reason)}</span>` : ""}
          <span class="badge">${confidenceLabel(it.confidence)}</span>
          <span class="num">${fmtDate(it.published_at || it.created_at)}</span>
        </div>
      </button>`)
    .join("");
}

async function loadDetail(id) {
  state.selectedId = id;
  const { item } = await api(`/api/items/${id}`);
  const ar = item.news_title_ar || item.title || "—";
  const facts = factItems(item.news_snippet_ar);
  const sources = mergedSources(item);
  const excludeBox =
    item.status === "excluded"
      ? `<p class="meta">سبب الاستبعاد: ${escapeHtml(item.exclude_reason || "—")}</p>`
      : "";
  $("detail").innerHTML = `
    <div class="brief-head">
      <strong>نشرة جاهزة للقرار</strong>
      <span>${escapeHtml(item.country_ar)} · ${escapeHtml(item.city_ar)}</span>
    </div>
    <div class="brief-body">
      <p class="kicker">${escapeHtml(item.name_ar)} — ${escapeHtml(item.office_ar)}</p>
      <h2 class="headline">${escapeHtml(ar)}</h2>
      <div class="meta">
        <span class="badge">${sourceLabel(item.source)}</span>
        ${item.publisher_tier === 0 || item.publisher_tier === 1 ? `<span class="badge official">معتمد</span>` : ""}
        ${item.publisher_domain ? `<span class="badge">${escapeHtml(item.publisher_domain)}</span>` : ""}
        ${sources.length > 1 ? `<span class="badge">${num(sources.length)} مصادر مدمجة</span>` : ""}
        <span class="badge ${String(item.trans_engine || "").startsWith("brief-ai-gemini-v2:") ? "official" : ""}">${briefBadge(item)}</span>
        <span class="badge">${confidenceLabel(item.confidence)}</span>
        <span class="badge">الرصد: ${escapeHtml(item.name_en)}</span>
        <span class="num">${fmtDate(item.published_at || item.created_at)}</span>
      </div>
      ${facts.length ? `<ul class="facts">${facts.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>` : ""}
      ${briefErrorBox(item)}
      <p class="source-line">المصادر: ${sources.map((source) => escapeHtml(source.domain || sourceLabel(source.source))).join(" · ")}</p>
      <div class="origin-block">
        <div class="label">الأصل</div>
        <p>${escapeHtml(originDisplay(item))}</p>
      </div>
      <p><a href="${item.url}" target="_blank" rel="noopener">فتح المصدر</a></p>
      ${excludeBox}
      <div class="actions">
        ${item.status !== "approved" ? `<button type="button" class="btn-good" data-act="approved">اعتماد</button>` : ""}
        ${item.status !== "excluded" ? `<button type="button" class="btn-bad" data-act="excluded">استبعاد يدوي</button>` : ""}
        ${item.status === "excluded" ? `<button type="button" data-act="inbox">استرجاع للوارد</button>` : ""}
      </div>
    </div>
  `;
  document.querySelectorAll(".result").forEach((el) => {
    el.classList.toggle("selected", el.dataset.id === id);
  });
}

async function refreshAll() {
  await Promise.all([loadStats(), loadItems(), loadDiagnostics()]);
  if (state.selectedId) {
    try {
      await loadDetail(state.selectedId);
    } catch {
      $("detail").innerHTML = `<p class="placeholder">بعد اكتمال المسار اختر بطاقة للقراءة ثم اعتماد أو استبعاد.</p>`;
    }
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", async () => {
    state.status = tab.dataset.status;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === tab));
    state.selectedId = null;
    $("detail").innerHTML = `<p class="placeholder">بعد اكتمال المسار اختر بطاقة للقراءة ثم اعتماد أو استبعاد.</p>`;
    await loadItems();
  });
});

$("list").addEventListener("click", (e) => {
  const btn = e.target.closest(".result");
  if (btn) loadDetail(btn.dataset.id);
});

$("detail").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || !state.selectedId) return;
  const status = btn.dataset.act;
  if (status === "retry-brief") {
    btn.disabled = true;
    btn.textContent = "يعيد المحاولة…";
    try {
      await api(`/api/items/${state.selectedId}/retry-brief`, { method: "POST" });
      await loadDetail(state.selectedId);
      await loadDiagnostics();
    } catch (error) {
      btn.disabled = false;
      btn.textContent = `تعذر: ${error.message}`;
    }
    return;
  }
  await api(`/api/items/${state.selectedId}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
  state.selectedId = null;
  await refreshAll();
  $("detail").innerHTML = `<p class="placeholder">تم تسجيل القرار. اختر البطاقة التالية.</p>`;
});

$("mayor_id").addEventListener("change", () => {
  syncSearchEnabled();
  state.selectedId = null;
  $("detail").innerHTML = `<p class="placeholder">بعد اكتمال المسار اختر بطاقة للقراءة ثم اعتماد أو استبعاد.</p>`;
  const mayor = state.mayors.find((m) => m.id === selectedMayorId());
  setDeskStatus(mayor ? `النطاق الحالي: ${mayor.name_ar} — ${mayor.city_ar}.` : "النطاق الحالي: كل المكاتب.");
  refreshAll();
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STAGE_LABELS = {
  queued: "بانتظار البدء",
  discovering: "بحث مباشر بالاسم والمنصب",
  verifying: "فتح الروابط والتحقق",
  saving: "حفظ الصفحات الموثوقة",
  merging: "دمج الحدث المتكرر",
  summarizing: "قراءة وتدقيق AI",
  ai_pending: "بانتظار إكمال قراءة AI",
  ai_waiting_quota: "بانتظار حصة AI — يستأنف تلقائيًا",
  ai_failed: "تعذر تلخيص AI",
  completed: "اكتمل",
  retrying: "إعادة محاولة",
  failed: "تعذر",
};

function renderSearchProgress(job) {
  const box = $("search-progress");
  box.hidden = false;
  const tasks = job.tasks || [];
  const hasAiFailure = tasks.some((task) => task.stage === "ai_failed");
  const hasAiPending = tasks.some((task) =>
    ["ai_pending", "ai_waiting_quota"].includes(task.stage),
  );
  const visualStatus = hasAiFailure ? "failed" : hasAiPending ? "partial" : job.status;
  box.dataset.status = visualStatus;
  const done = Number(job.completed) + Number(job.failed);
  const total = Number(job.total) || 1;
  const percent = Math.min(100, Math.round((done / total) * 100));
  $("progress-title").textContent =
    hasAiFailure
      ? "اكتمل الرصد وتعذر بعض تلخيص AI"
      : hasAiPending
        ? "اكتمل الرصد وبقي تلخيص AI"
        : job.status === "completed"
      ? "اكتمل الرصد"
      : job.status === "partial"
        ? "اكتمل الرصد مع تعذر بعض المكاتب"
        : "جاري الرصد في الخلفية";
  $("progress-count").textContent = `${done} / ${job.total}`;
  $("progress-bar").style.width = `${percent}%`;
  const active = tasks.filter((task) => ["running", "retrying"].includes(task.status));
  const failedTask = tasks.find((task) => task.status === "failed");
  const completedTask = [...tasks].reverse().find((task) => task.status === "completed");
  const visibleTasks = active.length
    ? [active[0]]
    : failedTask
      ? [failedTask]
      : completedTask
        ? [completedTask]
        : tasks.length
          ? [tasks[0]]
          : [];
  $("progress-tasks").innerHTML = visibleTasks
    .map((task) => {
      const className =
        task.stage === "ai_failed"
          ? "failed"
          : ["ai_pending", "ai_waiting_quota"].includes(task.stage)
            ? "running"
            : task.status === "completed"
          ? "completed"
          : task.status === "failed"
            ? "failed"
            : task.status === "queued"
              ? "queued"
              : "running";
      return `<div class="progress-task ${className}">
        <span class="dot"></span>
        <span>
          <b>${escapeHtml(task.mayor_name)}</b>
          <small>${escapeHtml(STAGE_LABELS[task.stage] || task.stage)}${task.detail ? ` — ${escapeHtml(task.detail)}` : ""}</small>
        </span>
      </div>`;
    })
    .join("");
}

async function waitForSearchJob(jobId) {
  localStorage.setItem("mayorWatchSearchJob", jobId);
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const { job } = await api(`/api/search-jobs/${jobId}`);
    renderSearchProgress(job);
    setDeskStatus(
      `الرصد يعمل في الخلفية: اكتمل ${num(job.completed)} من ${num(job.total)} مكتب` +
        `${job.running ? ` · يعمل الآن ${num(job.running)}` : ""}` +
        `${job.failed ? ` · تعذر ${num(job.failed)}` : ""}.`,
    );
    if (attempt % 2 === 0) await refreshAll();
    if (["completed", "partial", "failed"].includes(job.status)) {
      localStorage.removeItem("mayorWatchSearchJob");
      if (job.status === "failed") throw new Error("تعذر الرصد في جميع المكاتب.");
      return {
        ...job.totals,
        failedOffices: job.failed,
        jobStatus: job.status,
      };
    }
    await delay(3000);
  }
  throw new Error("استمر الرصد في الخلفية أكثر من المتوقع. حدّث الصفحة لاحقًا.");
}

async function runDeskSearch(query, mayorId) {
  $("search-progress").hidden = false;
  $("progress-title").textContent = "إرسال مهمة الرصد";
  $("progress-count").textContent = "0 / 0";
  $("progress-bar").style.width = "0";
  $("progress-tasks").innerHTML = "";
  const queued = await api("/api/search", {
    method: "POST",
    body: JSON.stringify({ q: query, mayor_id: mayorId || null }),
  });
  setDeskStatus(`تم إرسال ${num(queued.queued)} مكتب إلى الرصد. يمكنك متابعة النتائج دون تجمّد الصفحة.`);
  return waitForSearchJob(queued.jobId);
}

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.busy) return;
  const mayorId = selectedMayorId();
  state.busy = true;
  syncSearchEnabled();
  const btn = $("search-btn");
  btn.textContent = "جارٍ المسار…";
  setDeskStatus(mayorId ? "النظام يفتح المصدر ويدمج الحدث ويكتب النشرة…" : "بدء البحث في كل المكاتب…");
  try {
    const result = await runDeskSearch($("q").value.trim(), mayorId);
    state.status = "inbox";
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.status === "inbox"));
    state.selectedId = null;
    await refreshAll();
    const ready = (state.items || []).length;
    const failed = Number(result.failedOffices)
      ? ` · تعذر ${num(result.failedOffices)} مكتب`
      : "";
    const sourceErrors = Number(result.sourceErrors) || 0;
    const sourceWarning = sourceErrors ? ` · أخطاء مصادر ${num(sourceErrors)}` : "";
    const aiWarning = Number(result.aiFailed)
      ? ` · تعذر AI ${num(result.aiFailed)}`
      : Number(result.aiPending)
        ? ` · بانتظار AI ${num(result.aiPending)}`
        : "";
    setDeskStatus(
      `اكتشف ${num(result.discovered)} · قرأ ${num(result.opened)} صفحة · جديد ${num(result.found)} · دُمج ${num(result.duplicates)} · لخص AI ${num(result.summarized)} · بانتظار القرار ${num(ready)}${aiWarning}${sourceWarning}${failed}.`,
    );
    if (state.items[0]) {
      await loadDetail(state.items[0].id);
    } else {
      $("detail").innerHTML = `<p class="placeholder">اكتمل المسار ولم تُضف بطاقات جديدة هذا الأسبوع بعد التحقق.</p>`;
    }
  } catch (err) {
    $("detail").innerHTML = `<p class="error">تعذر إكمال المسار: ${escapeHtml(err.message)}</p>`;
    setDeskStatus("تعذر إكمال المسار. أعد المحاولة على النطاق نفسه.");
  } finally {
    state.busy = false;
    btn.textContent = "بحث";
    syncSearchEnabled();
  }
});

async function resumeActiveSearch() {
  const jobId = localStorage.getItem("mayorWatchSearchJob");
  if (!jobId) return;
  state.busy = true;
  syncSearchEnabled();
  $("search-btn").textContent = "الرصد يعمل…";
  try {
    await waitForSearchJob(jobId);
    await refreshAll();
  } catch (error) {
    localStorage.removeItem("mayorWatchSearchJob");
    setDeskStatus(`تعذر استئناف متابعة الرصد: ${error.message}`);
  } finally {
    state.busy = false;
    $("search-btn").textContent = "بحث";
    syncSearchEnabled();
  }
}

loadMayors().then(async () => {
  await refreshAll();
  await resumeActiveSearch();
}).catch((err) => {
  $("list").innerHTML = `<div class="error">تعذر تحميل الصفحة: ${escapeHtml(err.message)}</div>`;
});
