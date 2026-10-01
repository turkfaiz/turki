/**
 * مكتب الأخبار: بطاقات القائمة وتفصيل الخبر وما يلزمهما من نصوص.
 * دوال نقية (بيانات ← HTML) تُختبر دون متصفح؛ التفاعل في app.js.
 */
import { fmtDate, num, relTime } from "./lib.js";

export const LANE_EMPTY = {
  reading: "لا توجد أخبار تُقرأ الآن. بعد الرصد تظهر هنا حتى يكتمل الموجز.",
  verifying: "لا توجد موجزات بانتظار التدقيق الدلالي.",
  decision_ready: "لا توجد نشرات جاهزة للقرار. لا يظهر هنا إلا موجز له نسخة حالية اجتازت التدقيق داخل نافذة العرض.",
  attention_required: "لا يوجد ما يحتاج تدخلاً الآن.",
  approved: "لا توجد بطاقات معتمدة في نافذة العرض.",
  excluded: "لا توجد بطاقات مستبعدة في نافذة العرض.",
};

export const ATTENTION_REASON_AR = {
  verify_failed: "رُفض الموجز في التدقيق الدلالي ويحتاج مراجعة أو إعادة إنتاج.",
  ai_unconfigured: "مفتاح الذكاء الاصطناعي غير مربوط، فتوقفت القراءة.",
  brief_exhausted: "استُنفدت محاولات التلخيص دون موجز صالح.",
  brief_error: "تعذر التلخيص بعد خطأ تشغيلي ويحتاج تدخلاً.",
  brief_without_version: "يوجد موجز مكتمل بلا نسخة محفوظة، فلا يُعتمد.",
  verify_exhausted: "استُنفدت محاولات التدقيق دون اجتياز.",
};

export function decodeEntities(value) {
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

export function escapeHtml(value) {
  return decodeEntities(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function confidenceLabel(c) {
  return { raw: "خام", merged: "مدمج", official: "مؤكد رسمي" }[c] || c;
}

export function deskHeading(item) {
  if (item.status === "approved") return "نشرة معتمدة";
  if (item.status === "excluded") return "خبر مستبعد";
  if (item.desk_lane === "decision_ready") return "نشرة جاهزة للقرار";
  if (item.desk_lane === "verifying") return "موجز بانتظار التدقيق";
  if (item.desk_lane === "attention_required") return "يحتاج تدخلاً";
  return "خبر قيد القراءة";
}

export function displayTitle(it) {
  return it.news_title_ar || it.title || "—";
}

export function briefBadge(item) {
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

export function briefErrorReason(code) {
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
    [/ai_ungrounded_headline:name_missing/i, "كتب النموذج عنوانًا لا يبدأ باسم العمدة العربي كما هو مسجّل، فرُفض."],
    [/ai_ungrounded_headline:quote_not_in_page/i, "الاقتباس الذي أسند به النموذج العنوان غير موجود حرفيًا في نص الصفحة، فرُفض."],
    [/ai_ungrounded_headline:quote_without_mayor/i, "اقتباس العنوان لا يذكر العمدة باسمه ولا بلقبه ولا بمنصبه، فالخبر على الأغلب ليس عنه."],
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

export function briefErrorBox(item) {
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

export function factItems(snippet) {
  return String(snippet || "")
    .split(/\n+/)
    .flatMap((line) => line.split(/\s*[•📌·]\s*/))
    .map((s) => s.replace(/^[•📌·]\s*/, "").trim())
    .filter((s) => s.length >= 4);
}

export function mergedSources(item) {
  try {
    const rows = JSON.parse(item.merged_sources || "[]");
    if (Array.isArray(rows) && rows.length) return rows;
  } catch {
    /* use the primary source below */
  }
  return [{ domain: item.publisher_domain, url: item.url, title: item.title }];
}

export function originKey(value) {
  return decodeEntities(value)
    .replace(/\s*[-–—|]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function originDisplay(item) {
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

export function providerFromItem(item) {
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

/** حالة الموجز في سطر قصير للبطاقة؛ الشارة الطويلة للتفصيل. */
export function briefState(item) {
  const engine = String(item.trans_engine || "");
  if (/^brief-ai-[a-z0-9]+-v2:/i.test(engine)) {
    if (item.verify_state === "passed") return { text: "مدقَّق", tone: "good" };
    if (item.verify_state === "failed") return { text: "رُفض في التدقيق", tone: "bad" };
    return { text: "بانتظار التدقيق", tone: "wait" };
  }
  if (engine === "brief-deferred") return { text: "بانتظار حصة الذكاء", tone: "warn" };
  if (engine === "brief-ai-error") return { text: "تعذّر التلخيص", tone: "bad" };
  return { text: "بانتظار الموجز", tone: "wait" };
}

export function renderItemCard(item, selectedId = null, now = Date.now()) {
  const fact = factItems(item.news_snippet_ar)[0];
  const state = briefState(item);
  const when = item.published_at || item.created_at;
  const merged = Number(item.source_count) > 1 ? `<span class="chip">${num(item.source_count)} مصادر مدمجة</span>` : "";
  const official = item.confidence === "official" ? `<span class="chip chip-official">مؤكد رسمي</span>` : "";
  return `<button type="button" class="card${item.id === selectedId ? " selected" : ""}" data-id="${escapeHtml(item.id)}">
    <span class="card-top"><span class="card-office">${escapeHtml(item.city_ar)} · ${escapeHtml(item.name_ar)}</span><time title="${escapeHtml(fmtDate(when))}">${escapeHtml(relTime(when, now, "—"))}</time></span>
    <h3>${escapeHtml(displayTitle(item))}</h3>
    ${fact ? `<p class="card-fact">${escapeHtml(fact)}</p>` : ""}
    <span class="card-foot">
      <span class="state is-${state.tone}"><i aria-hidden="true"></i>${escapeHtml(state.text)}</span>
      ${item.publisher_domain ? `<span class="chip">${escapeHtml(item.publisher_domain)}</span>` : ""}
      ${official}${merged}
      ${item.exclude_reason ? `<span class="chip">${escapeHtml(item.exclude_reason)}</span>` : ""}
    </span>
  </button>`;
}

export function renderItemList(items, status, selectedId = null, now = Date.now()) {
  if (!items.length) {
    return `<div class="empty"><p>${escapeHtml(LANE_EMPTY[status] || "لا توجد بطاقات في هذا القسم.")}</p></div>`;
  }
  return items.map((item) => renderItemCard(item, selectedId, now)).join("");
}

export const DETAIL_PLACEHOLDER = `<div class="placeholder"><b>اختر خبرًا</b><p>اقرأ موجزه ومصدره، ثم اعتمده أو استبعده.</p></div>`;

export function renderDetail(item) {
  const facts = factItems(item.news_snippet_ar);
  const sources = mergedSources(item);
  const reader = providerFromItem(item);
  const attention =
    item.desk_lane === "attention_required"
      ? `<div class="brief-error"><b>سبب التعثر</b><br />${escapeHtml(
          ATTENTION_REASON_AR[item.attention_reason] || briefErrorReason(item.brief_error || item.verify_detail) || "يحتاج تدخلاً قبل أن يدخل مسار القرار.",
        )}</div>`
      : "";
  const excluded = item.status === "excluded" ? `<p class="meta">سبب الاستبعاد: ${escapeHtml(item.exclude_reason || "—")}</p>` : "";
  const canApprove = item.verify_state === "passed";
  return `
    <div class="brief-head">
      <strong>${escapeHtml(deskHeading(item))}</strong>
      <span>${escapeHtml(item.country_ar)} · ${escapeHtml(item.city_ar)}</span>
    </div>
    <div class="brief-body">
      <p class="kicker">${escapeHtml(item.name_ar)} — ${escapeHtml(item.office_ar)}</p>
      <h2 class="headline">${escapeHtml(displayTitle(item))}</h2>
      <div class="meta">
        <span class="badge ${canApprove ? "official" : ""}">${escapeHtml(briefBadge(item))}</span>
        ${item.publisher_domain ? `<span class="badge">${escapeHtml(item.publisher_domain)}</span>` : ""}
        ${sources.length > 1 ? `<span class="badge">${num(sources.length)} مصادر مدمجة</span>` : ""}
        ${item.confidence === "official" ? `<span class="badge official">مؤكد رسمي</span>` : ""}
        ${Number(item.needs_review) ? `<span class="badge">تغيّر المصدر — يحتاج مراجعة جديدة</span>` : ""}
        <span class="num">${escapeHtml(fmtDate(item.published_at || item.created_at))}</span>
      </div>
      ${facts.length ? `<ul class="facts">${facts.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>` : ""}
      ${attention}
      ${briefErrorBox(item)}
      ${reader ? `<p class="source-line">كتب الموجز: ${escapeHtml(reader.name)}${reader.model ? ` · ${escapeHtml(reader.model)}` : ""}</p>` : ""}
      <p class="source-line">المصادر: ${sources.map((source) => escapeHtml(source.domain || "—")).join(" · ")}</p>
      <div class="origin-block">
        <div class="label">النص الأصلي</div>
        <p>${escapeHtml(originDisplay(item))}</p>
      </div>
      <p><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">فتح المصدر ↗</a></p>
      ${excluded}
      <div class="actions">
        ${item.status !== "approved"
          ? canApprove
            ? `<button type="button" class="btn-good" data-act="approved">اعتماد</button>`
            : `<button type="button" class="btn-good" disabled title="لا يُعتمد موجز قبل اجتياز التدقيق الدلالي">اعتماد — بانتظار التدقيق</button>`
          : ""}
        ${item.status !== "excluded" ? `<button type="button" class="btn-bad" data-act="excluded">استبعاد يدوي</button>` : ""}
        ${item.status === "excluded" ? `<button type="button" data-act="inbox">استرجاع للوارد</button>` : ""}
      </div>
    </div>`;
}

export const TAB_HINT = {
  reading: "أخبار رُصدت ويجري كتابة موجزها.",
  verifying: "موجزات كُتبت وبانتظار التدقيق الدلالي.",
  decision_ready: "موجزات مدقَّقة جاهزة لقرارك: اعتماد أو استبعاد.",
  attention_required: "أخبار تعثّرت وتحتاج تدخلاً منك.",
  approved: "نشرات اعتمدتها.",
  excluded: "أخبار استبعدتها أو استُبعدت تلقائيًا.",
};
