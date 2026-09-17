const state = {
  status: "decision_ready",
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
  const raw = String(source || "");
  if (raw === "official") return "رسمي";
  if (raw.startsWith("approved_")) return "منصة معتمدة";
  if (raw === "google_news" || raw === "bing_news" || raw === "gdelt" || raw === "inoreader") {
    return "مصدر قديم خارج السجل";
  }
  return raw || "مصدر";
}

function confidenceLabel(c) {
  return { raw: "خام", merged: "مدمج", official: "مؤكد رسمي" }[c] || c;
}

const LANE_EMPTY = {
  reading: "لا توجد أخبار تُقرأ الآن. بعد الرصد تظهر هنا حتى يكتمل الموجز.",
  verifying: "لا توجد موجزات بانتظار التدقيق الدلالي.",
  decision_ready: "لا توجد نشرات جاهزة للقرار. لا يظهر هنا إلا موجز له نسخة حالية اجتازت التدقيق داخل نافذة العرض.",
  attention_required: "لا يوجد ما يحتاج تدخلاً الآن.",
  approved: "لا توجد بطاقات معتمدة في نافذة العرض.",
  excluded: "لا توجد بطاقات مستبعدة في نافذة العرض.",
};

const ATTENTION_REASON_AR = {
  verify_failed: "رُفض الموجز في التدقيق الدلالي ويحتاج مراجعة أو إعادة إنتاج.",
  ai_unconfigured: "مفتاح الذكاء الاصطناعي غير مربوط، فتوقفت القراءة.",
  brief_exhausted: "استُنفدت محاولات التلخيص دون موجز صالح.",
  brief_error: "تعذر التلخيص بعد خطأ تشغيلي ويحتاج تدخلاً.",
  brief_without_version: "يوجد موجز مكتمل بلا نسخة محفوظة، فلا يُعتمد.",
  verify_exhausted: "استُنفدت محاولات التدقيق دون اجتياز.",
};

function deskHeading(item) {
  if (item.status === "approved") return "نشرة معتمدة";
  if (item.status === "excluded") return "خبر مستبعد";
  if (item.desk_lane === "decision_ready") return "نشرة جاهزة للقرار";
  if (item.desk_lane === "verifying") return "موجز بانتظار التدقيق";
  if (item.desk_lane === "attention_required") return "يحتاج تدخلاً";
  return "خبر قيد القراءة";
}

function displayTitle(it) {
  return it.news_title_ar || it.title || "—";
}

/** الشارة تعكس مستوى التحقق الفعلي، لا مجرد وجود موجز. */
function briefBadge(item) {
  const engine = String(item.trans_engine || "");
  if (/^brief-ai-[a-z0-9]+-v2:/i.test(engine)) {
    if (item.verify_state === "passed") return "موجز مدقَّق — مسند ومُتحقق دلاليًا";
    if (item.verify_state === "failed") return "موجز مرفوض في التدقيق";
    return "موجز مسند — بانتظار التدقيق الدلالي";
  }
  if (engine === "brief-deferred") return "بانتظار حصة AI — يستأنف تلقائيًا";
  if (engine === "brief-working") return "يُقرأ الآن";
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
    [/ai_deferred:provider_unpaid|ai_http_402/i, "هذا النموذج رفض الطلب لأن الحساب غير مدفوع أو غير مقبول. المسار وُقف وأُعيدت الأخبار للنماذج التي ما زالت تعمل."],
    [/ai_deferred:provider_rejected|ai_http_40[013]/i, "هذا النموذج رفض شكل الطلب. المسار وُقف مؤقتًا وأُعيدت الأخبار لفتحة أخرى."],
    [/ai_http_5\d\d|provider_error/i, "خطأ مؤقت في خدمة الذكاء الاصطناعي، وتُعاد المحاولة."],
    [/aborted|AbortError|timeout/i, "انتهت المهلة قبل أن يرد الذكاء الاصطناعي على قراءة الصفحة."],
    [/subrequest|too many subrequests|worker invocation/i, "توقف النداء لأن جلب الصفحات والقراءة وقعا في نفس التشغيل وتجاوزا حد طلبات العامل. القراءة صارت في مسار مستقل وتُعاد تلقائيًا."],
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
  if (!item.brief_error || (/^brief-ai-[a-z0-9]+-v2:/i.test(engine))) return "";
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

async function api(path, options = {}) {
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
  const mast = $("mast-offices");
  if (mast) {
    mast.textContent = `International Mayoral Briefing · ${mayors.length} ${mayors.length === 1 ? "office" : "offices"}`;
  }
  syncSearchEnabled();
}

async function loadStats() {
  const s = await api("/api/stats");
  const mayorId = selectedMayorId();
  const row = mayorId ? (s.byMayor || []).find((m) => m.mayor_id === mayorId) : null;
  const src = mayorId ? row || {} : s;
  $("stat-reading").textContent = num(src.reading);
  $("stat-verifying").textContent = num(src.verifying);
  $("stat-decision-ready").textContent = num(src.decision_ready ?? src.inbox);
  $("stat-attention").textContent = num(src.attention_required);
  state.aiReady = s.sources?.ai_brief === "ready";
  $("last-weekly").textContent = s.lastWeekly ? fmtDate(s.lastWeekly.started_at) : "—";
  return s;
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

/** رقاقة أداة: أيقونة، واسم، ونقطة حالة. السجل المتعثر يعمل، فلا يُوسم متوقفًا. */
function toolStateLabel(ok) {
  if (ok === null) return "معطّلة بالحوكمة";
  if (ok === true) return "تعمل";
  if (ok === "warn") return "تعمل · بعضها متعثر";
  return "متوقفة";
}

function toolChip(tool) {
  const tone = tool.ok === null ? "off" : tool.ok === true ? "ok" : tool.ok === "warn" ? "warn" : "bad";
  const label = toolStateLabel(tool.ok);
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
  const kindLabel =
    {
      feed: "تغذية RSS",
      page: "غرفة أخبار",
      sitemap: "Sitemap",
      api: "واجهة الموقع",
      search: "بحث داخلي",
      browser: "Browser",
    }[source.kind] || source.kind;
  const role = `${source.tier === 0 ? "غرفة أخبار رسمية" : "تغطية محلية"} · ${kindLabel}`;
  const curated = source.verified
    ? `مُتحقق منه بالفحص عند الإعداد (${source.curated_at || "—"})`
    : `فُحص عند الإعداد ولم يستجب من شبكة الفحص، وبقي لأنه المصدر الأصلي للمدينة`;
  const operational = source.operational?.label
    ? `الحالة: ${source.operational.label}`
    : source.last_ok_at
      ? `آخر تشغيل: ${num(source.last_items)} عنصرًا`
      : source.last_status
        ? `آخر تشغيل: ${String(source.last_status).slice(0, 60)}`
        : "لم يُشغّل بعد في هذه البيئة";
  return `${role}\n${curated}\n${operational}`;
}

function providerFromItem(item) {
  const names = { gemini: "جيميني", deepseek: "ديبسيك", qwen: "كوين" };
  const engine = String(item.trans_engine || "");
  const match = engine.match(/^brief-ai-([a-z0-9]+)-v2:(.+)$/i);
  if (match) {
    return { id: match[1].toLowerCase(), model: match[2], name: names[match[1].toLowerCase()] || match[1] };
  }
  const id = String(item.brief_provider || "");
  if (id) return { id, model: "", name: names[id] || id };
  return null;
}

function budgetFromSlots(slots) {
  const bound = (slots || []).filter((row) => row.bound);
  if (!bound.length) return null;
  const active = bound.filter((row) => !(row.blocked || row.budget?.blocked));
  const pool = active.length ? active : bound;
  const remaining = active.length
    ? active.reduce((sum, row) => sum + Number(row.budget?.remaining || 0), 0)
    : 0;
  const dailyLimit = pool.reduce((sum, row) => sum + Number(row.budget?.dailyLimit || 0), 0);
  const mergeLimit = pool.reduce((sum, row) => sum + Number(row.budget?.mergeLimit || 0), 0);
  const minIntervalMs = Math.min(
    ...pool.map((row) => Number(row.budget?.minIntervalMs ?? row.minIntervalMs ?? 0)),
  );
  const allBlocked = active.length === 0;
  return {
    remaining,
    dailyLimit,
    mergeLimit,
    minIntervalMs,
    blocked: allBlocked,
    blockReason: allBlocked
      ? bound.find((row) => row.budget?.blockReason)?.budget.blockReason || null
      : null,
    resumesInSeconds: allBlocked
      ? Math.min(...bound.map((row) => Number(row.budget?.resumesInSeconds || 0)))
      : 0,
  };
}

function displayBudget(d) {
  return budgetFromSlots(d.ai?.slots) || budgetFromSlots(d.providers?.lanes) || d.ai?.budget || {};
}

function boundSlotNote(d, budget) {
  const slots = (d.ai?.slots || d.providers?.lanes || []).filter((row) => row.bound);
  if (!d.ai?.configured && !slots.length) return "المفتاح غير مربوط";
  if (budget.blocked) return `متوقف · يستأنف بعد ${humanWait(budget.resumesInSeconds)}`;
  if (slots.length > 1) {
    return `${slots.map((row) => row.nameAr || row.id).join("، ")} · نداء واحد لكل موجز`;
  }
  return `${slots[0]?.model || d.ai?.model || "—"} · نداء واحد لكل موجز`;
}

function renderProviderLanes(providers) {
  const lanes = providers?.lanes || [];
  if (!lanes.length) return "";
  return `
    <section class="board-section provider-board">
      <h4>٦ · نماذج القراءة — الربط من Cloudflare</h4>
      <p class="diag-note">كل خبر يُسند لفتحة واحدة قبل القراءة. رقم الطابور خاص بهذه الفتحة، وجاري العمل يظهر طالما النداء لم يُغلق. إن رُفض المحتوى عند نموذج يُمرَّر تلقائيًا للنموذج التالي.</p>
      <div class="provider-grid">
        ${lanes.map((lane) => {
          const budget = lane.budget || {};
          const tone = !lane.hasKey ? "is-bad" : !lane.bound || budget.blocked ? "is-warn" : "is-good";
          const state = !lane.hasKey
            ? `ضع السر ${lane.vars.key} في Cloudflare`
            : !lane.enabled
              ? `موقوف من ${lane.vars.enabled}`
              : budget.blocked
                ? `متوقف · يستأنف بعد ${humanWait(budget.resumesInSeconds)}`
                : `${lane.model} · يعمل`;
          const lastError = lane.lastError?.code
            ? `<small class="readout-note">آخر خطأ: ${escapeHtml(briefErrorReason(lane.lastError.code))}</small>`
            : "";
          return `<article class="provider-card ${tone}">
            <b>${escapeHtml(lane.nameAr)}</b>
            <small>${escapeHtml(state)}</small>
            <ul class="provider-counts">
              <li><span>في الطابور</span><b class="num">${num(lane.queued)}</b></li>
              <li><span>جاري العمل</span><b class="num">${num(lane.inProgress)}</b></li>
              <li><span>مكتمل</span><b class="num">${num(lane.completed)}</b></li>
              <li><span>تعذر</span><b class="num">${num(lane.failed)}</b></li>
            </ul>
            <div class="meter"><span style="width:${Math.round(pct(budget.remaining, budget.dailyLimit))}%"></span></div>
            <small class="readout-note">الرصيد ${num(budget.remaining)} / ${num(budget.dailyLimit)} · تباعد ${num(Math.round((lane.minIntervalMs || 0) / 100) / 10)} ث</small>
            ${lastError}
          </article>`;
        }).join("")}
      </div>
    </section>`;
}

function renderDiagnostics(d) {
  const b = d.brief || {};
  const budget = displayBudget(d);
  const reg = d.registry || {};
  const writes = d.writes || {};
  const waiting = (b.pending || 0) + (b.waitingQuota || 0);
  const briefTotal = (b.completed || 0) + waiting + (b.failed || 0);
  const aiNote = boundSlotNote(d, budget);
  const archive = Number(writes.pendingArchive) || 0;

  $("diag-headline").textContent = archive
    ? `${num(archive)} مرشحاً أرشيفياً معلّقاً · لا يُحسب طابور AI`
    : budget.blocked
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
      ${readout(
        "ضغط الكتابة",
        archive ? num(archive) : num(writes.pendingFresh || 0),
        writes.detail || (archive ? "أرشيف معلّق في المرشحين" : "مرشحون جدد لهذا الأسبوع"),
        null,
        writes.ok === false || archive ? "is-bad" : "",
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
    </div>` + renderProviderLanes(d.providers);
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

let diagPoll = 0;
$("diagnostics").addEventListener("toggle", () => {
  window.clearInterval(diagPoll);
  if (!$("diagnostics").open) return;
  loadDiagnostics();
  diagPoll = window.setInterval(() => {
    if ($("diagnostics").open) loadDiagnostics();
  }, 4000);
});

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
    $("list").innerHTML = `<div class="empty">${LANE_EMPTY[state.status] || "لا توجد بطاقات في هذا القسم. اضغط بحث لتشغيل المسار على النطاق الحالي."}</div>`;
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
          <span class="badge ${it.verify_state === "passed" ? "official" : ""}">${briefBadge(it)}</span>
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
  const attentionBox =
    item.desk_lane === "attention_required"
      ? `<div class="brief-error"><b>سبب التعثر</b><br />${escapeHtml(
          ATTENTION_REASON_AR[item.attention_reason] || briefErrorReason(item.brief_error || item.verify_detail) || "يحتاج تدخلاً قبل أن يدخل مسار القرار.",
        )}</div>`
      : "";
  $("detail").innerHTML = `
    <div class="brief-head">
      <strong>${escapeHtml(deskHeading(item))}</strong>
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
        <span class="badge ${item.verify_state === "passed" ? "official" : ""}">${briefBadge(item)}</span>
        ${Number(item.needs_review) ? `<span class="badge">تغيّر المصدر — يحتاج مراجعة جديدة</span>` : ""}
        <span class="badge">${confidenceLabel(item.confidence)}</span>
        <span class="badge">الرصد: ${escapeHtml(item.name_en)}</span>
        <span class="num">${fmtDate(item.published_at || item.created_at)}</span>
      </div>
      ${facts.length ? `<ul class="facts">${facts.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>` : ""}
      ${attentionBox}
      ${briefErrorBox(item)}
      ${(() => {
        const reader = providerFromItem(item);
        return reader
          ? `<p class="source-line">المراجع: ${escapeHtml(reader.name)}${reader.model ? ` · ${escapeHtml(reader.model)}` : ""}</p>`
          : "";
      })()}
      <p class="source-line">المصادر: ${sources.map((source) => escapeHtml(source.domain || sourceLabel(source.source))).join(" · ")}</p>
      <div class="origin-block">
        <div class="label">الأصل</div>
        <p>${escapeHtml(originDisplay(item))}</p>
      </div>
      <p><a href="${item.url}" target="_blank" rel="noopener">فتح المصدر</a></p>
      ${excludeBox}
      <div class="actions">
        ${item.status !== "approved"
          ? item.verify_state === "passed"
            ? `<button type="button" class="btn-good" data-act="approved">اعتماد</button>`
            : `<button type="button" class="btn-good" disabled title="لا يُعتمد موجز قبل اجتياز التدقيق الدلالي">اعتماد — بانتظار التدقيق</button>`
          : ""}
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
  const [stats] = await Promise.all([loadStats(), loadItems(), loadDiagnostics()]);
  if (state.selectedId) {
    try {
      await loadDetail(state.selectedId);
    } catch {
      $("detail").innerHTML = `<p class="placeholder">بعد اكتمال المسار اختر بطاقة للقراءة ثم اعتماد أو استبعاد.</p>`;
    }
  }
  return stats;
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

function laneAfterSearch(stats) {
  if (Number(stats?.reading) > 0) return "reading";
  if (Number(stats?.verifying) > 0) return "verifying";
  if (Number(stats?.attention_required) > 0) return "attention_required";
  if (Number(stats?.decision_ready) > 0) return "decision_ready";
  return null;
}

function applyDeskLane(lane) {
  if (!lane) return;
  state.status = lane;
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("on", tab.dataset.status === lane);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const STAGE_LABELS = {
  queued: "بانتظار البدء",
  discovering: "فحص المصادر المعتمدة",
  source_poll: "فحص مصدر واحد",
  article_fetch: "فتح المقالات المكتشفة",
  verifying: "التدقيق الدلالي",
  saving: "حفظ الصفحات الموثوقة",
  merging: "دمج الحدث المتكرر",
  assigning: "توزيع الأخبار على نماذج القراءة",
  summarizing: "قراءة وتدقيق AI",
  ai_reading: "قراءة النماذج",
  ai_pending: "بانتظار إكمال قراءة AI",
  ai_waiting_quota: "بانتظار حصة AI — يستأنف تلقائيًا",
  ai_failed: "تعذر تلخيص AI",
  waiting: "بانتظار استئناف النماذج",
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
    ["ai_pending", "ai_waiting_quota", "ai_reading", "verifying", "waiting", "retrying"].includes(
      task.stage,
    ),
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

const searchPoll = { controller: null };

async function waitForSearchJob(jobId) {
  searchPoll.controller?.abort();
  const controller = new AbortController();
  searchPoll.controller = controller;
  localStorage.setItem("mayorWatchSearchJob", jobId);
  try {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (controller.signal.aborted) return null;
      const { job } = await api(`/api/search-jobs/${jobId}`, { signal: controller.signal });
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
  } catch (error) {
    if (error?.name === "AbortError") return null;
    throw error;
  }
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
    if (!result) return;
    state.selectedId = null;
    const stats = await refreshAll();
    applyDeskLane(laneAfterSearch(stats) || state.status);
    await loadItems();
    const ready = Number(stats?.decision_ready) || 0;
    const failed = Number(result.failedOffices)
      ? ` · تعذر ${num(result.failedOffices)} مكتب`
      : "";
    const sourceErrors = Number(result.sourceErrors) || 0;
    // تمييز «لا نتائج» عن «لم يكتمل الفحص» عن «صفّاها الموضوع».
    const sourceWarning = sourceErrors
      ? ` · تعذّر ${num(sourceErrors)} مصدر فلم يكتمل الفحص`
      : "";
    const topicNote = Number(result.skippedTopic)
      ? ` · استبعد الموضوع ${num(result.skippedTopic)}`
      : "";
    const aiWarning = Number(result.aiFailed)
      ? ` · تعذر AI ${num(result.aiFailed)}`
      : Number(result.aiPending)
        ? ` · بانتظار AI ${num(result.aiPending)}`
        : "";
    setDeskStatus(
      `اكتشف ${num(result.discovered)} · قرأ ${num(result.opened)} صفحة · جديد ${num(result.found)} · دُمج ${num(result.duplicates)} · لخص AI ${num(result.summarized)} · قيد القراءة ${num(stats?.reading)} · تدقيق ${num(stats?.verifying)} · بانتظار القرار ${num(ready)} · تدخل ${num(stats?.attention_required)}${topicNote}${aiWarning}${sourceWarning}${failed}.`,
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

function renderSettings(payload) {
  const box = $("settings-body");
  if (!box) return "";
  if (payload?.error) {
    box.innerHTML = `<p class="settings-error">${escapeHtml(payload.error)}</p>`;
    return box.innerHTML;
  }
  const offices = payload?.offices || [];
  if (!offices.length) {
    box.innerHTML = `<p class="settings-empty">لا عمداء في السجل.</p>`;
    return box.innerHTML;
  }
  box.innerHTML = offices
    .map((office) => {
      const platforms = office.platforms || [];
      const custom = office.origin === "custom";
      const badge = custom ? ` <span class="settings-badge">مضاف</span>` : "";
      const host = office.official_host
        ? `<br>النطاق الرسمي: <span dir="ltr">${escapeHtml(office.official_host)}</span>`
        : "";
      return `<article class="settings-office" data-mayor="${escapeHtml(office.id)}" data-origin="${escapeHtml(office.origin || "seed")}">
        <h3>${escapeHtml(office.name_ar)}${badge}</h3>
        <p class="settings-meta">
          ${escapeHtml(office.name_en)} · ${escapeHtml(office.name_native)}<br>
          ${escapeHtml(office.city_ar)}${office.city_en ? ` / ${escapeHtml(office.city_en)}` : ""} — ${escapeHtml(office.country_ar)}<br>
          ${escapeHtml(office.title_ar)}${office.title_en ? ` · ${escapeHtml(office.title_en)}` : ""}${host}
        </p>
        <div class="settings-platforms">
          ${
            platforms.length
              ? platforms
                  .map((platform) => {
                    const types = (platform.strategies || [])
                      .map((step) => step.type_ar || step.type)
                      .join(" ← ");
                    const checked = platform.enabled ? "checked" : "";
                    const off = platform.enabled ? "" : " is-off";
                    return `<div class="settings-platform${off}">
                      <div>
                        <b>${escapeHtml(platform.name)}</b>
                        <small>${escapeHtml(platform.platform_ar || "")} · ${escapeHtml(types || platform.kind)}</small>
                        <small>آخر فحص: ${escapeHtml(fmtDate(platform.last_checked_at))} · آخر اكتشاف: ${escapeHtml(fmtDate(platform.last_discovery_at))}</small>
                        <small>${escapeHtml(platform.operational?.label || "—")}</small>
                      </div>
                      <label class="settings-toggle">
                        <input type="checkbox" data-source-toggle="${escapeHtml(platform.id)}" ${checked}>
                        ${platform.enabled ? "مفعّلة" : "متوقفة"}
                      </label>
                    </div>`;
                  })
                  .join("")
              : `<p class="settings-empty">لا منصات مسجّلة لهذا المكتب.</p>`
          }
        </div>
      </article>`;
    })
    .join("");
  return box.innerHTML;
}

async function loadSettings() {
  const box = $("settings-body");
  box.innerHTML = `<p class="settings-empty">جاري التحميل…</p>`;
  try {
    const data = await api("/api/settings/offices");
    renderSettings(data);
  } catch (error) {
    renderSettings({ error: `تعذر تحميل الإعدادات: ${error.message}` });
  }
}

function openSettings(open) {
  const layer = $("settings-layer");
  const btn = $("settings-btn");
  layer.hidden = !open;
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  if (open) loadSettings();
}

$("settings-btn").addEventListener("click", () => {
  openSettings($("settings-layer").hidden);
});
$("settings-close").addEventListener("click", () => openSettings(false));
$("settings-layer").addEventListener("click", (e) => {
  if (e.target === $("settings-layer")) openSettings(false);
});
$("settings-body").addEventListener("change", async (e) => {
  const input = e.target.closest("input[data-source-toggle]");
  if (!input) return;
  input.disabled = true;
  try {
    await api(`/api/settings/sources/${encodeURIComponent(input.dataset.sourceToggle)}`, {
      method: "POST",
      body: JSON.stringify({ enabled: input.checked }),
    });
    await loadSettings();
  } catch (error) {
    input.checked = !input.checked;
    renderSettings({ error: `تعذر حفظ الحالة: ${error.message}` });
  }
});

$("add-mayor-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const submit = form.querySelector("[type=submit]");
  const status = $("add-mayor-status");
  const payload = Object.fromEntries(new FormData(form).entries());
  const roles = ["official", "newspaper", "agency"];
  payload.platforms = [1, 2, 3]
    .map((n, index) => ({
      name: String(payload[`platform_${n}_name`] || "").trim(),
      url: String(payload[`platform_${n}_url`] || "").trim(),
      platform: roles[index],
    }))
    .filter((row) => row.url);
  for (const key of Object.keys(payload)) {
    if (key.startsWith("platform_")) delete payload[key];
    else if (!String(payload[key] || "").trim() && key !== "platforms") delete payload[key];
  }
  submit.disabled = true;
  status.textContent = "جاري الحفظ…";
  status.classList.remove("is-error");
  try {
    const created = await api("/api/settings/mayors", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    form.reset();
    status.textContent = "أُضيف المكتب. يمكنك إضافة عمدة آخر من النموذج نفسه.";
    await loadSettings();
    await loadMayors();
    const card = document.querySelector(
      `.settings-office[data-mayor="${CSS.escape(created.mayor.id)}"]`,
    );
    if (card) {
      card.classList.add("is-new");
      card.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("is-error");
  } finally {
    submit.disabled = false;
  }
});

loadMayors().then(async () => {
  await refreshAll();
  await resumeActiveSearch();
}).catch((err) => {
  $("list").innerHTML = `<div class="error">تعذر تحميل الصفحة: ${escapeHtml(err.message)}</div>`;
});
