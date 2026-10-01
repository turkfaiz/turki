/**
 * رحلة الرصد: من فحص المواقع حتى جاهزية القرار.
 *
 * كل رقم هنا محسوب من بيانات حقيقية تسجلها الخلفية (مصادر المهمة، المرشحون،
 * الأخبار المحفوظة)، فلا مؤشر تقدّم متخيَّل. الدوال نقية: بيانات ← نص HTML.
 */
import { amount, duration, esc, num, relTime, sourceStatusAr } from "./lib.js";

export const TERMINAL = ["completed", "partial", "failed"];
export const isRunning = (job) => Boolean(job) && !TERMINAL.includes(job.status);

export const TASK_STAGE_AR = {
  queued: "بانتظار البدء",
  source_poll: "فحص المواقع",
  discovering: "فحص المواقع",
  article_fetch: "قراءة المقالات",
  verifying: "التدقيق الدلالي",
  assigning: "توزيع الأخبار على النماذج",
  ai_reading: "قراءة النماذج للأخبار",
  ai_pending: "بانتظار دور النموذج",
  ai_waiting_quota: "بانتظار حصة النموذج",
  ai_failed: "تعذّر التلخيص",
  waiting: "بانتظار استئناف النماذج",
  retrying: "إعادة محاولة",
  completed: "اكتمل",
  failed: "تعذّر",
};

export const DROP_REASON_AR = {
  unrelated: "لا يخص العمدة",
  stale: "أقدم من أسبوع",
  untrusted: "مصدر غير موثوق",
  unverified: "تعذّر التحقق من الصفحة",
  not_modified: "لم يتغيّر منذ آخر قراءة",
  canonical_outside_registry: "رابط خارج النطاقات المعتمدة",
  duplicate: "مكرر دُمج مع خبر موجود",
};

const WAITING_STAGES = ["ai_waiting_quota", "waiting", "retrying"];

const zero = () => ({
  candidates: { total: 0, waiting: 0, read: 0, failed: 0, duplicates: 0, dropped: {} },
  items: { total: 0, excluded: 0, reading: 0, verifying: 0, decision_ready: 0, attention_required: 0, approved: 0 },
});

/** مراحل الرحلة بحالاتها وأرقامها. */
export function buildStages(job) {
  const funnel = { ...zero(), ...(job.funnel || {}) };
  const c = funnel.candidates;
  const i = funnel.items;
  const sources = job.sources || [];
  const running = isRunning(job);
  const srcTotal = sources.length;
  const srcDone = sources.filter((s) => s.status === "polled" || s.status === "failed").length;
  const srcFailed = sources.filter((s) => s.status === "failed").length;
  const srcBad = sources.filter((s) => s.status === "polled" && !["ok", "ok_no_new"].includes(s.detail)).length;

  const pool = i.reading + i.verifying + i.decision_ready + i.attention_required + i.approved;
  const written = pool - i.reading;
  const checked = i.decision_ready + i.approved;
  const dropped = Object.values(c.dropped).reduce((a, b) => a + b, 0) + c.duplicates + i.excluded;

  const sourcesDone = !running || (srcTotal > 0 && srcDone === srcTotal);
  const readDone = sourcesDone && c.waiting === 0;
  const briefDone = readDone && i.reading === 0;
  const verifyDone = briefDone && i.verifying === 0;
  const blocked = (job.tasks || []).some((task) => WAITING_STAGES.includes(task.stage) || task.journey?.resume_at);

  const pick = (done, active) => (done ? "done" : active ? "active" : "waiting");
  const stages = [
    {
      key: "sources",
      label: "فحص المواقع",
      value: srcTotal ? `${num(srcDone)}/${num(srcTotal)}` : "—",
      sub: srcFailed + srcBad ? `${num(srcFailed + srcBad)} متعثر` : srcTotal ? "المواقع المعتمدة" : running ? "بانتظار البدء" : "لا تفاصيل محفوظة",
      state: pick(sourcesDone && (srcTotal > 0 || !running), running && srcDone < srcTotal),
      warn: srcFailed + srcBad > 0,
    },
    {
      key: "discover",
      label: "اكتشاف الروابط",
      value: num(c.total),
      sub: "رابط من آخر 7 أيام",
      state: pick(sourcesDone, c.total > 0 || srcDone > 0),
    },
    {
      key: "read",
      label: "قراءة المقالات",
      value: c.total ? `${num(c.read)}/${num(c.total)}` : "—",
      sub: c.waiting ? `${num(c.waiting)} بالانتظار` : c.failed ? `${num(c.failed)} تعذّر فتحه` : "اكتملت",
      state: pick(readDone, c.read > 0 || sourcesDone),
      warn: c.failed > 0,
    },
    {
      key: "filter",
      label: "التصفية والحفظ",
      value: num(pool + i.excluded),
      sub: dropped ? `استُبعد ${num(dropped)}` : "محفوظ",
      state: pick(readDone, c.read > 0),
    },
    {
      key: "brief",
      label: "كتابة الموجز",
      value: pool ? `${num(written)}/${num(pool)}` : "—",
      sub: i.reading ? `${num(i.reading)} قيد القراءة` : pool ? "اكتملت" : "لا أخبار",
      state: blocked && !briefDone ? "blocked" : pick(briefDone, pool > 0 && readDone),
    },
    {
      key: "verify",
      label: "التدقيق الدلالي",
      value: written ? `${num(checked + i.attention_required)}/${num(written)}` : "—",
      sub: i.verifying ? `${num(i.verifying)} بانتظار التدقيق` : written ? "اكتمل" : "—",
      state: blocked && !verifyDone ? "blocked" : pick(verifyDone, briefDone && written > 0),
    },
    {
      key: "ready",
      label: "جاهز للقرار",
      value: num(i.decision_ready),
      sub: i.attention_required ? `${num(i.attention_required)} يحتاج تدخلاً` : "للمراجعة والاعتماد",
      state: pick(verifyDone, false),
      warn: i.attention_required > 0,
      goal: true,
    },
  ];
  // المراحل تتداخل فعليًا (تُقرأ المقالات والمواقع ما زالت تُفحص)؛ الأبعد تقدمًا هو الرائد.
  const lead = stages.map((s) => s.state).lastIndexOf("active");
  if (lead >= 0) stages[lead].lead = true;
  if (job.status === "failed") {
    (stages.find((stage) => stage.state !== "done") || stages[0]).state = "failed";
  }
  return stages;
}

export function jobPhase(job) {
  if (!job) return { label: "لا رحلة بعد", tone: "idle" };
  const waiting = (job.tasks || []).some((task) => WAITING_STAGES.includes(task.stage));
  if (job.status === "failed") return { label: "تعذّر الرصد", tone: "bad" };
  if (isRunning(job)) {
    if (waiting) return { label: "بانتظار حصة الذكاء الاصطناعي", tone: "warn" };
    return { label: job.status === "queued" ? "بانتظار البدء" : "يعمل الآن", tone: "live" };
  }
  if (job.status === "partial") return { label: "اكتمل مع تعثّر بعض المكاتب", tone: "warn" };
  return { label: "اكتمل", tone: "good" };
}

function scopeText(job, mayors = []) {
  const office = job.mayor_id ? mayors.find((m) => m.id === job.mayor_id)?.name_ar || job.mayor_id : "كل المكاتب";
  const kind = job.kind === "weekly" ? "الرصد الأسبوعي" : "بحث يدوي";
  return `${kind} · ${office}${job.query ? ` · موضوع: «${job.query}»` : ""}`;
}

/** ما يجري الآن: المكاتب النشطة ومرحلة كل منها. */
export function renderNow(job) {
  if (!isRunning(job)) return "";
  const active = (job.tasks || []).filter((task) => ["running", "retrying", "waiting"].includes(task.status));
  const lines = active.slice(0, 3).map((task) => {
    const stage = TASK_STAGE_AR[task.stage] || task.stage;
    const resume = task.journey?.resume_at ? ` · يستأنف ${esc(relTime(task.journey.resume_at, Date.now(), ""))}` : "";
    return `<li><span class="jr-pulse" aria-hidden="true"></span><b>${esc(task.mayor_name)}</b> ${esc(stage)}${task.detail ? ` — ${esc(task.detail)}` : ""}${resume}</li>`;
  });
  const more = active.length > 3 ? `<li class="jr-more">و${num(active.length - 3)} من المكاتب الأخرى تعمل</li>` : "";
  const queued = (job.tasks || []).filter((task) => task.status === "queued").length;
  const tail = queued ? `<li class="jr-more">${num(queued)} من المكاتب بانتظار الدور</li>` : "";
  const body = lines.join("") + more + tail;
  return body ? `<ul class="jr-now" aria-live="polite">${body}</ul>` : "";
}

export function renderStepper(stages) {
  return `<ol class="jr-steps">${stages
    .map(
      (stage, index) => `<li class="jr-step is-${stage.state}${stage.lead ? " is-lead" : ""}${stage.goal ? " is-goal" : ""}${stage.warn ? " has-warn" : ""}" data-stage="${stage.key}">
        <span class="jr-node" aria-hidden="true">${stage.state === "done" ? "✓" : stage.state === "failed" ? "!" : index + 1}</span>
        <span class="jr-label">${esc(stage.label)}</span>
        <b class="jr-value num">${esc(stage.value)}</b>
        <small class="jr-sub">${esc(stage.sub)}</small>
      </li>`,
    )
    .join("")}</ol>`;
}

/** لماذا استُبعد ما استُبعد: شرائح بالأسباب، فلا يضيع خبر بلا تفسير. */
export function renderDropped(funnel) {
  const c = funnel?.candidates;
  if (!c) return "";
  const reasons = { ...c.dropped };
  if (c.duplicates) reasons.duplicate = c.duplicates;
  const entries = Object.entries(reasons).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length && !c.failed) return `<p class="jr-muted">لم يُستبعد شيء في هذه الرحلة.</p>`;
  const chips = entries
    .map(([reason, n]) => `<span class="jr-chip"><b class="num">${num(n)}</b> ${esc(DROP_REASON_AR[reason] || reason)}</span>`)
    .join("");
  const failed = c.failed ? `<span class="jr-chip is-bad"><b class="num">${num(c.failed)}</b> تعذّر فتح الصفحة</span>` : "";
  return `<div class="jr-chips">${chips}${failed}</div>`;
}

const SOURCE_ICON = { queued: "·", polling: "…", polled: "✓", failed: "✕" };

function sourceTone(source) {
  if (source.status === "failed") return "bad";
  if (source.status === "polled") return ["ok", "ok_no_new"].includes(source.detail) ? "good" : "warn";
  return source.status === "polling" ? "live" : "idle";
}

/** المكاتب ومواقعها وحالة كل موقع الآن. */
export function renderOffices(job) {
  const tasks = job.tasks || [];
  if (!tasks.length) return `<p class="jr-muted">لا مكاتب في هذه الرحلة.</p>`;
  const sources = job.sources || [];
  return `<ul class="jr-offices">${tasks
    .map((task) => {
      const own = sources.filter((s) => s.mayor_id === task.mayor_id);
      const j = task.journey || {};
      const progress = j.total ? `${num(j.settled)}/${num(j.total)} خبرًا استقر` : "";
      const tone = task.status === "failed" ? "bad" : task.status === "completed" ? "good" : task.status === "queued" ? "idle" : "live";
      const chips = own.length
        ? own
            .map((s) => {
              const text = s.status === "polled" || s.status === "failed" ? sourceStatusAr(s.detail) : { queued: "بانتظار الدور", polling: "يُفحص الآن" }[s.status] || s.status;
              return `<span class="jr-src is-${sourceTone(s)}" title="${esc(`${s.name || s.domain} — ${text}`)}"><i aria-hidden="true">${SOURCE_ICON[s.status] || "·"}</i><span class="num">${esc(s.domain)}</span><small>${esc(text)}</small></span>`;
            })
            .join("")
        : `<span class="jr-muted">لا تفاصيل مواقع محفوظة لهذا المكتب في هذه المهمة</span>`;
      return `<li class="jr-office is-${tone}">
        <div class="jr-office-head"><b>${esc(task.mayor_name)}</b><span>${esc(TASK_STAGE_AR[task.stage] || task.stage)}${progress ? ` · ${esc(progress)}` : ""}</span></div>
        <div class="jr-srcs">${chips}</div>
      </li>`;
    })
    .join("")}</ul>`;
}

/** النتيجة بعد الاكتمال: جملة واحدة تلخّص ما حصل. */
export function summaryLine(job) {
  const f = job.funnel;
  if (!f) return "";
  const i = f.items;
  const kept = i.total - i.excluded;
  return `اكتشف ${num(f.candidates.total)} رابطًا · قرأ ${num(f.candidates.read)} · حفظ ${num(kept)} خبرًا · ${num(i.decision_ready)} جاهز للقرار${i.attention_required ? ` · ${num(i.attention_required)} يحتاج تدخلاً` : ""}`;
}

export function renderJourney(job, { mayors = [], now = Date.now(), detailsOpen = false } = {}) {
  const phase = jobPhase(job);
  const stages = buildStages(job);
  const elapsed = duration(job.created_at, isRunning(job) ? now : job.finished_at || now);
  const summary = !isRunning(job) ? summaryLine(job) : "";
  return `<header class="jr-head">
      <div>
        <h2>رحلة الرصد</h2>
        <p class="jr-scope">${esc(scopeText(job, mayors))}</p>
      </div>
      <div class="jr-meta">
        <span class="jr-phase is-${phase.tone}"><i aria-hidden="true"></i>${esc(phase.label)}</span>
        <small>${esc(relTime(job.created_at, now, ""))}${elapsed ? ` · استغرق ${esc(elapsed)}` : ""}</small>
      </div>
    </header>
    ${renderStepper(stages)}
    ${renderNow(job)}
    ${summary ? `<p class="jr-summary">${esc(summary)}</p>` : ""}
    <button type="button" class="jr-toggle" data-jr-toggle="details" aria-expanded="${detailsOpen}">
      ${detailsOpen ? "إخفاء" : "عرض"} تفاصيل المكاتب والمواقع وأسباب الاستبعاد
    </button>
    <div class="jr-details" ${detailsOpen ? "" : "hidden"}>
      <h3>لماذا استُبعد ما استُبعد</h3>
      ${renderDropped(job.funnel)}
      <h3>المكاتب والمواقع</h3>
      ${renderOffices(job)}
    </div>`;
}

export function renderIdle({ lastWeekly = null, nextRun = "الأحد 06:00 بتوقيت الرياض", now = Date.now() } = {}) {
  const last = lastWeekly
    ? `آخر رصد أسبوعي ${relTime(lastWeekly.started_at, now, "")} — جديد ${num(lastWeekly.found_count)} · مدمج ${num(lastWeekly.duplicate_count)} · مستبعد ${num(lastWeekly.excluded_count)}`
    : "لم يجرِ رصد بعد.";
  return `<header class="jr-head"><div><h2>رحلة الرصد</h2><p class="jr-scope">${esc(last)}</p></div>
    <div class="jr-meta"><span class="jr-phase is-idle"><i aria-hidden="true"></i>في الانتظار</span><small>القادم: ${esc(nextRun)}</small></div></header>
    <p class="jr-empty">اختر المكتب واضغط «رصد الآن» لتبدأ رحلة جديدة. ستظهر هنا مراحلها وأرقامها لحظة بلحظة: من فحص المواقع حتى جاهزية القرار.</p>`;
}

const PHASE_SHORT = { good: "اكتمل", warn: "تعثّر", bad: "تعذّر", live: "يعمل", idle: "—" };

export function renderHistory(jobs, activeId, { mayors = [], now = Date.now() } = {}) {
  if (!jobs?.length) return `<p class="jr-muted">لا رحلات سابقة.</p>`;
  return `<ul class="jr-history">${jobs
    .map((job) => {
      const phase = jobPhase({ ...job, tasks: [] });
      const t = job.totals || {};
      return `<li><button type="button" class="jr-run${job.id === activeId ? " is-active" : ""}" data-job="${esc(job.id)}">
        <span class="jr-phase is-${phase.tone}"><i aria-hidden="true"></i>${esc(PHASE_SHORT[phase.tone])}</span>
        <span class="jr-run-main"><b>${esc(scopeText(job, mayors))}</b><small>${esc(relTime(job.created_at, now, ""))} · ${esc(amount(job.offices, "office"))}</small></span>
        <span class="jr-run-nums num">جديد ${num(t.found)} · مدمج ${num(t.duplicates)}</span>
      </button></li>`;
    })
    .join("")}</ul>`;
}
