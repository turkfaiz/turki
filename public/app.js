/**
 * صفحة الرصد: أمر البحث، رحلة الرصد الحية، ومكتب الأخبار (قائمة + تفصيل).
 * الإحصاءات التشغيلية وحالة الأدوات والمصادر في صفحة الإعدادات، وهنا مؤشر واحد
 * يقود إليها.
 */
import { DETAIL_PLACEHOLDER, TAB_HINT, renderDetail, renderItemList } from "./desk.js";
import { isRunning, renderHistory, renderIdle, renderJourney } from "./journey.js";
import { api, num } from "./lib.js";

const $ = (id) => document.getElementById(id);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const JOB_KEY = "mayorWatchSearchJob";

const state = {
  status: "decision_ready",
  mayors: [],
  items: [],
  selectedId: null,
  busy: false,
  stats: null,
  job: null,
  follow: 0,
  detailsOpen: false,
  pollError: "",
};

const selectedMayorId = () => $("mayor_id")?.value || "";

/* ───────────── الترويسة والأمر ───────────── */

async function loadMayors() {
  const { mayors } = await api("/api/mayors");
  state.mayors = mayors;
  $("mayor_id").innerHTML =
    `<option value="">كل المكاتب (${num(mayors.length)})</option>` +
    mayors.map((m) => `<option value="${m.id}">${m.name_ar} — ${m.city_ar}</option>`).join("");
}

function paintScope() {
  const mayor = state.mayors.find((m) => m.id === selectedMayorId());
  const sources = state.stats?.registry?.total;
  $("scope-line").textContent = mayor
    ? `${mayor.name_ar} — ${mayor.city_ar}${mayor.country_ar ? `، ${mayor.country_ar}` : ""}`
    : `${num(state.mayors.length)} مكتبًا${sources ? ` · ${num(sources)} موقع رصد` : ""}`;
  $("desk-status").textContent = TAB_HINT[state.status] || "";
}

function attentionText(n) {
  if (n === 1) return "أداة واحدة تحتاج انتباهًا";
  if (n === 2) return "أداتان تحتاجان انتباهًا";
  return `${num(n)} ${n <= 10 ? "أدوات" : "أداة"} تحتاج انتباهًا`;
}

async function loadHealth() {
  const pill = $("health-pill");
  try {
    const view = await api("/api/settings/tools");
    const tone = view.state === "ok" ? "good" : view.state === "warn" ? "warn" : "bad";
    pill.className = `health-pill is-${tone}`;
    $("health-text").textContent = view.state === "ok" ? "الأدوات تعمل" : attentionText(view.needs_attention);
  } catch {
    pill.className = "health-pill is-idle";
    $("health-text").textContent = "تعذّر فحص الأدوات";
  }
}

/* ───────────── الإحصاءات وعدّادات الأقسام ───────────── */

async function loadStats() {
  const stats = await api("/api/stats");
  state.stats = stats;
  const mayorId = selectedMayorId();
  const row = mayorId ? (stats.byMayor || []).find((m) => m.mayor_id === mayorId) || {} : stats;
  for (const key of ["reading", "verifying", "decision_ready", "attention_required", "approved", "excluded"]) {
    const el = document.querySelector(`[data-count="${key}"]`);
    if (!el) continue;
    const value = Number(row[key]) || 0;
    el.textContent = num(value);
    el.closest(".tab").classList.toggle("has-items", value > 0);
  }
  paintScope();
  return stats;
}

/* ───────────── مكتب الأخبار ───────────── */

function itemsQuery() {
  const qs = new URLSearchParams({ status: state.status });
  if (selectedMayorId()) qs.set("mayor_id", selectedMayorId());
  return `/api/items?${qs.toString()}`;
}

async function loadItems() {
  $("list").innerHTML = `<div class="empty"><p>جاري التحميل…</p></div>`;
  const { items } = await api(itemsQuery());
  state.items = items;
  $("list").innerHTML = renderItemList(items, state.status, state.selectedId);
}

async function loadDetail(id) {
  state.selectedId = id;
  const { item } = await api(`/api/items/${id}`);
  $("detail").innerHTML = renderDetail(item);
  document.querySelectorAll(".card").forEach((el) => el.classList.toggle("selected", el.dataset.id === id));
}

async function refreshAll() {
  const [stats] = await Promise.all([loadStats(), loadItems()]);
  if (state.selectedId) {
    try {
      await loadDetail(state.selectedId);
    } catch {
      $("detail").innerHTML = DETAIL_PLACEHOLDER;
    }
  }
  return stats;
}

function selectTab(status) {
  state.status = status;
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.status === status;
    t.classList.toggle("on", on);
    t.setAttribute("aria-selected", String(on));
  });
  state.selectedId = null;
  $("detail").innerHTML = DETAIL_PLACEHOLDER;
  paintScope();
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", async () => {
    selectTab(tab.dataset.status);
    await loadItems();
  });
});

$("list").addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  loadDetail(card.dataset.id).catch((error) => {
    $("detail").innerHTML = `<div class="placeholder"><b>تعذّر فتح الخبر</b><p>${error.message}</p></div>`;
  });
});

$("detail").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || !state.selectedId) return;
  if (btn.dataset.act === "retry-brief") {
    btn.disabled = true;
    btn.textContent = "يعيد المحاولة…";
    try {
      await api(`/api/items/${state.selectedId}/retry-brief`, { method: "POST" });
      await loadDetail(state.selectedId);
    } catch (error) {
      btn.disabled = false;
      btn.textContent = `تعذّر: ${error.message}`;
    }
    return;
  }
  await api(`/api/items/${state.selectedId}/status`, {
    method: "POST",
    body: JSON.stringify({ status: btn.dataset.act }),
  });
  state.selectedId = null;
  await refreshAll();
  $("detail").innerHTML = `<div class="placeholder"><b>سُجّل القرار</b><p>اختر الخبر التالي.</p></div>`;
});

$("mayor_id").addEventListener("change", () => {
  state.selectedId = null;
  $("detail").innerHTML = DETAIL_PLACEHOLDER;
  paintScope();
  refreshAll();
});

/* ───────────── رحلة الرصد ───────────── */

function paintJourney() {
  const box = $("journey");
  const job = state.job;
  box.dataset.phase = !job ? "idle" : isRunning(job) ? "running" : "done";
  const error = state.pollError ? `<p class="jr-error" role="alert">${state.pollError}</p>` : "";
  box.innerHTML =
    (job
      ? renderJourney(job, { mayors: state.mayors, detailsOpen: state.detailsOpen })
      : renderIdle({ lastWeekly: state.stats?.lastWeekly })) + error;
}

async function pullJob(id) {
  try {
    const { job } = await api(`/api/search-jobs/${id}?detail=1`);
    state.job = job;
    state.pollError = "";
  } catch (error) {
    if (error.message === "not_found") state.job = null;
    else state.pollError = `تعذّرت متابعة الرحلة: ${error.message}. تُعاد المحاولة.`;
  }
  paintJourney();
  return state.job;
}

/** يتابع مهمة حتى تنتهي، ويحدّث مكتب الأخبار بين حين وآخر. يعيد المهمة الأخيرة. */
async function followJob(id) {
  const token = ++state.follow;
  localStorage.setItem(JOB_KEY, id);
  let tick = 0;
  let failures = 0;
  while (token === state.follow) {
    const job = await pullJob(id);
    failures = state.pollError ? failures + 1 : 0;
    if (job && !isRunning(job)) {
      localStorage.removeItem(JOB_KEY);
      await refreshAll();
      loadHealth();
      return job;
    }
    if (failures >= 6) {
      localStorage.removeItem(JOB_KEY);
      return job;
    }
    tick += 1;
    if (tick % 8 === 0) await refreshAll();
    await delay(3500);
  }
  return state.job;
}

$("journey").addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-jr-toggle]");
  if (!toggle) return;
  state.detailsOpen = !state.detailsOpen;
  paintJourney();
});

async function showHistory() {
  const box = $("history");
  box.innerHTML = `<p class="jr-muted">جاري التحميل…</p>`;
  try {
    const { jobs } = await api("/api/search-jobs?limit=10");
    box.innerHTML = renderHistory(jobs, state.job?.id, { mayors: state.mayors });
  } catch (error) {
    box.innerHTML = `<p class="jr-error">تعذّر تحميل السجل: ${error.message}</p>`;
  }
}

$("history-toggle").addEventListener("click", async (e) => {
  const box = $("history");
  const open = box.hidden;
  box.hidden = !open;
  e.currentTarget.setAttribute("aria-expanded", String(open));
  if (open) await showHistory();
});

$("history").addEventListener("click", async (e) => {
  const run = e.target.closest("[data-job]");
  if (!run) return;
  state.follow += 1;
  const job = await pullJob(run.dataset.job);
  if (job && isRunning(job)) followJob(job.id);
  $("journey").scrollIntoView({ block: "nearest", behavior: "smooth" });
  await showHistory();
});

/* ───────────── بدء الرصد ───────────── */

function setBusy(busy) {
  state.busy = busy;
  const btn = $("search-btn");
  btn.disabled = busy;
  btn.textContent = busy ? "الرصد يعمل…" : "رصد الآن";
}

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.busy) return;
  setBusy(true);
  try {
    const queued = await api("/api/search", {
      method: "POST",
      body: JSON.stringify({ q: $("q").value.trim(), mayor_id: selectedMayorId() || null }),
    });
    state.detailsOpen = false;
    $("journey").scrollIntoView({ block: "nearest", behavior: "smooth" });
    const job = await followJob(queued.jobId);
    if (job && job.status !== "failed") {
      selectTab("decision_ready");
      await refreshAll();
      const first = state.items[0];
      if (first) await loadDetail(first.id);
    }
  } catch (error) {
    state.pollError = `تعذّر بدء الرصد: ${error.message}`;
    paintJourney();
  } finally {
    setBusy(false);
  }
});

/* ───────────── البدء ───────────── */

async function boot() {
  $("detail").innerHTML = DETAIL_PLACEHOLDER;
  await loadMayors();
  await refreshAll();
  loadHealth();
  const resume = localStorage.getItem(JOB_KEY);
  const job = await pullJob(resume || "latest");
  if (job && isRunning(job)) {
    setBusy(true);
    await followJob(job.id);
    setBusy(false);
  } else if (resume) {
    localStorage.removeItem(JOB_KEY);
  }
}

boot().catch((error) => {
  $("list").innerHTML = `<div class="empty"><p>تعذّر تحميل الصفحة: ${error.message}</p></div>`;
});
