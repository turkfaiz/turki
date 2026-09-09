const state = {
  status: "inbox",
  mayors: [],
  items: [],
  selectedId: null,
  busy: false,
  translating: false,
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
  return { google_news: "Google News", official: "Official", inoreader: "Inoreader" }[source] || source;
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
  return it.news_title_ar || it.title || "";
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
    `<option value="">كل العمداء</option>` +
    mayors.map((m) => `<option value="${m.id}">${m.name_ar} — ${m.city_ar}</option>`).join("");
}

function applyPlatform(_source, on, _label, ledId, textId) {
  setLed(ledId, on);
  $(textId).textContent = on ? "يعمل" : "متوقف";
}

async function loadStats() {
  const s = await api("/api/stats");
  $("stat-inbox").textContent = num(s.inbox);
  $("stat-approved").textContent = num(s.approved);
  $("stat-excluded").textContent = num(s.excluded);
  $("stat-dup").textContent = num(s.week?.duplicates);
  applyPlatform("inoreader", s.sources.inoreader === "ready" || s.sources.inoreader?.on, "", "led-inoreader", "src-inoreader");
  applyPlatform("google_news", s.sources.google_news === "ready" || s.sources.google_news?.on !== false, "", "led-google", "src-google");
  applyPlatform("official", s.sources.official === "ready" || s.sources.official?.on !== false, "", "led-official", "src-official");
  $("last-weekly").textContent = s.lastWeekly ? fmtDate(s.lastWeekly.started_at) : "—";
}

async function loadItems() {
  $("list").innerHTML = `<div class="empty">جاري التحميل…</div>`;
  const { items } = await api(`/api/items?status=${encodeURIComponent(state.status)}`);
  state.items = items;
  renderItems(items);
  const missing = (items || []).some((it) => !it.news_title_ar);
  if (missing && !state.translating) {
    state.translating = true;
    api("/api/translate", { method: "POST", body: "{}" })
      .then(async () => {
        const again = await api(`/api/items?status=${encodeURIComponent(state.status)}`);
        state.items = again.items;
        renderItems(again.items);
        if (state.selectedId) loadDetail(state.selectedId);
      })
      .finally(() => {
        state.translating = false;
      });
  }
}

function renderItems(items) {
  if (!items.length) {
    $("list").innerHTML = `<div class="empty">لا توجد عناصر في هذا القسم.</div>`;
    return;
  }
  $("list").innerHTML = items
    .map((it) => {
      const ar = displayTitle(it);
      const showOrigin = it.title && ar !== it.title;
      return `
      <button type="button" class="result ${it.id === state.selectedId ? "selected" : ""}" data-id="${it.id}">
        <h3 class="headline">${escapeHtml(ar)}</h3>
        ${showOrigin ? `<p class="origin">${escapeHtml(it.title)}</p>` : ""}
        <div class="meta">
          <span>${escapeHtml(it.name_ar)} · ${escapeHtml(it.city_ar)}</span>
          ${it.news_title_ar ? `<span class="badge tr">مترجم</span>` : ""}
          <span class="badge ${it.confidence}">${confidenceLabel(it.confidence)}</span>
          <span class="badge">${sourceLabel(it.source)}</span>
          <span class="num">${fmtDate(it.published_at || it.created_at)}</span>
        </div>
      </button>`;
    })
    .join("");
}

async function loadDetail(id) {
  state.selectedId = id;
  const { item } = await api(`/api/items/${id}`);
  const ar = displayTitle(item);
  const snippet = item.news_snippet_ar || item.snippet || "لا يوجد مقتطف.";
  const excludeBox =
    item.status === "excluded"
      ? `<p class="muted">سبب الاستبعاد: ${escapeHtml(item.exclude_reason || "—")}</p>`
      : "";
  $("detail").innerHTML = `
    <p class="kicker">${escapeHtml(item.country_ar)} · ${escapeHtml(item.city_ar)}</p>
    <h2 class="headline">${escapeHtml(ar)}</h2>
    <p class="muted">${escapeHtml(item.name_ar)} — ${escapeHtml(item.office_ar)}</p>
    <p class="meta">
      <span class="badge">الرصد: ${escapeHtml(item.name_en)}</span>
      <span class="badge">لغة الأم: ${escapeHtml(item.native_lang_ar)}</span>
      <span class="badge ${item.confidence}">${confidenceLabel(item.confidence)}</span>
      <span class="badge">${sourceLabel(item.source)}</span>
      <span class="num">${fmtDate(item.published_at || item.created_at)}</span>
    </p>
    <p>${escapeHtml(snippet)}</p>
    <div class="origin-box">
      <span>النص الأصلي</span>
      ${escapeHtml(item.title)}
      ${item.snippet && item.snippet !== snippet ? `<p>${escapeHtml(item.snippet)}</p>` : ""}
    </div>
    <p><a href="${item.url}" target="_blank" rel="noopener">فتح المصدر</a></p>
    ${excludeBox}
    ${item.status !== "excluded" ? `<label>سبب الاستبعاد<input id="exclude-reason" value="استبعاد يدوي من الموظف" /></label>` : ""}
    <div class="actions">
      ${item.status !== "approved" ? `<button type="button" class="btn-good" data-act="approved">اعتماد</button>` : ""}
      ${item.status !== "excluded" ? `<button type="button" class="btn-bad" data-act="excluded">استبعاد</button>` : ""}
      ${item.status === "excluded" ? `<button type="button" class="btn-ghost" data-act="inbox">استرجاع للوارد</button>` : ""}
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
      $("detail").innerHTML = `<p class="muted">اختر خبرًا لعرض الترجمة والتفاصيل.</p>`;
    }
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", async () => {
    state.status = tab.dataset.status;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === tab));
    state.selectedId = null;
    $("detail").innerHTML = `<p class="muted">اختر خبرًا لعرض الترجمة والتفاصيل.</p>`;
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
  const reasonInput = document.getElementById("exclude-reason");
  const reason = status === "excluded" ? (reasonInput?.value.trim() || "استبعاد يدوي من الموظف") : null;
  await api(`/api/items/${state.selectedId}/status`, {
    method: "POST",
    body: JSON.stringify({ status, reason }),
  });
  await refreshAll();
});

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.busy) return;
  state.busy = true;
  const btn = $("search-btn");
  btn.disabled = true;
  btn.textContent = "جارٍ البحث…";
  try {
    const result = await api("/api/search", {
      method: "POST",
      body: JSON.stringify({
        q: $("q").value.trim(),
        mayor_id: $("mayor_id").value || null,
      }),
    });
    state.status = "inbox";
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.status === "inbox"));
    await refreshAll();
    $("detail").innerHTML = `<p>انتهى البحث. جديد: <b class="num">${num(result.found)}</b> · تكرار: <b class="num">${num(result.duplicates)}</b> · مستبعد: <b class="num">${num(result.excluded)}</b></p>`;
  } catch (err) {
    $("detail").innerHTML = `<p class="error">تعذر البحث: ${escapeHtml(err.message)}</p>`;
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = "بحث";
  }
});

loadMayors().then(refreshAll).catch((err) => {
  $("list").innerHTML = `<div class="error">تعذر تحميل الصفحة: ${escapeHtml(err.message)}</div>`;
});
