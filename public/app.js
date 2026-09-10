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

function setLed(id, on) {
  const el = $(id);
  if (!el) return;
  el.className = `led ${on ? "led-on" : "led-off"}`;
}

function displayTitle(it) {
  return it.news_title_ar || it.title || "—";
}

function briefBadge(item) {
  const engine = String(item.trans_engine || "");
  if (engine.startsWith("brief-ai-gemini-v2:")) return "ملخص AI موثّق";
  if (engine === "brief-ai-error") return "تعذر AI — ستُعاد المحاولة";
  return "بانتظار AI";
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

function applyPlatform(on, ledId, textId) {
  setLed(ledId, on);
  $(textId).textContent = on ? "يعمل" : "متوقف";
}

async function loadStats() {
  const s = await api("/api/stats");
  const mayorId = selectedMayorId();
  const row = mayorId ? (s.byMayor || []).find((m) => m.mayor_id === mayorId) : null;
  $("stat-inbox").textContent = num(mayorId ? row?.inbox || 0 : s.inbox);
  $("stat-approved").textContent = num(mayorId ? row?.approved || 0 : s.approved);
  $("stat-excluded").textContent = num(mayorId ? row?.excluded || 0 : s.excluded);
  $("stat-dup").textContent = num(s.week?.duplicates);
  applyPlatform(s.sources.inoreader === "ready" || s.sources.inoreader?.on, "led-inoreader", "src-inoreader");
  applyPlatform(s.sources.google_news === "ready" || s.sources.google_news?.on !== false, "led-google", "src-google");
  applyPlatform(s.sources.official === "ready" || s.sources.official?.on !== false, "led-official", "src-official");
  applyPlatform(s.sources.ai_brief === "ready", "led-ai", "src-ai");
  $("src-ai").textContent = s.sources.ai_brief === "ready" ? "يقرأ الصفحة" : "غير مربوط";
  $("last-weekly").textContent = s.lastWeekly ? fmtDate(s.lastWeekly.started_at) : "—";
}

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
  await Promise.all([loadStats(), loadItems()]);
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
  const hasAiPending = tasks.some((task) => task.stage === "ai_pending");
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
          : task.stage === "ai_pending"
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
