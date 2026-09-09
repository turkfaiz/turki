const state = {
  status: "inbox",
  mayors: [],
  items: [],
  selectedId: null,
  busy: false,
};

const $ = (id) => document.getElementById(id);

function fmtDate(value) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return new Intl.DateTimeFormat("ar-SA", {
    timeZone: "Asia/Riyadh",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

function sourceLabel(source) {
  return { google_news: "Google News", official: "رسمي", inoreader: "Inoreader" }[source] || source;
}

function confidenceLabel(c) {
  return { raw: "خام", merged: "مدمج", official: "مؤكد رسمي" }[c] || c;
}

function sourceState(v) {
  return v === "ready" ? "مربوط" : "غير مربوط بعد";
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
  const select = $("mayor_id");
  select.innerHTML = `<option value="">كل العمداء</option>` + mayors
    .map((m) => `<option value="${m.id}">${m.name_ar} — ${m.city_ar}</option>`)
    .join("");
}

async function loadStats() {
  const s = await api("/api/stats");
  $("stat-inbox").textContent = s.inbox;
  $("stat-approved").textContent = s.approved;
  $("stat-excluded").textContent = s.excluded;
  $("stat-dup").textContent = s.week?.duplicates || 0;
  $("src-inoreader").textContent = sourceState(s.sources.inoreader);
  $("src-inoreader").className = s.sources.inoreader === "ready" ? "pill-on" : "pill-off";
  $("src-google").textContent = "شبكة أمان · جاهز";
  $("src-official").textContent = "حسم عبر النطاق الرسمي";
  $("last-weekly").textContent = s.lastWeekly ? fmtDate(s.lastWeekly.started_at) : "لم يُنفَّذ بعد";
}

async function loadItems() {
  $("list").innerHTML = `<div class="empty">جاري التحميل…</div>`;
  const { items } = await api(`/api/items?status=${encodeURIComponent(state.status)}`);
  state.items = items;
  if (!items.length) {
    $("list").innerHTML = `<div class="empty">لا توجد عناصر في هذا القسم.</div>`;
    return;
  }
  $("list").innerHTML = items
    .map(
      (it) => `
      <button class="item ${it.id === state.selectedId ? "selected" : ""}" data-id="${it.id}">
        <h3>${escapeHtml(it.title)}</h3>
        <div class="meta">
          <span>${escapeHtml(it.name_ar)} · ${escapeHtml(it.city_ar)}</span>
          <span class="badge ${it.confidence}">${confidenceLabel(it.confidence)}</span>
          <span class="badge">${sourceLabel(it.source)}</span>
          <span>${fmtDate(it.published_at || it.created_at)}</span>
        </div>
      </button>`,
    )
    .join("");
}

async function loadDetail(id) {
  state.selectedId = id;
  const { item } = await api(`/api/items/${id}`);
  const excludeBox =
    item.status === "excluded"
      ? `<p class="muted">سبب الاستبعاد: ${escapeHtml(item.exclude_reason || "—")}</p>`
      : "";
  $("detail").innerHTML = `
    <p class="kicker">${escapeHtml(item.country_ar)} · ${escapeHtml(item.city_ar)}</p>
    <h2>${escapeHtml(item.title)}</h2>
    <p class="muted">${escapeHtml(item.name_ar)} — ${escapeHtml(item.title_ar)}</p>
    <p class="meta">
      <span class="badge">الرصد: ${escapeHtml(item.name_en)}</span>
      <span class="badge">لغة الأم: ${escapeHtml(item.native_lang_ar)} · ${escapeHtml(item.name_native)}</span>
      <span class="badge ${item.confidence}">${confidenceLabel(item.confidence)}</span>
      <span class="badge">${sourceLabel(item.source)}</span>
    </p>
    <p>${escapeHtml(item.snippet || "لا يوجد مقتطف.")}</p>
    <p><a href="${item.url}" target="_blank" rel="noopener">فتح المصدر</a></p>
    ${excludeBox}
    <div class="actions">
      ${item.status !== "approved" ? `<button class="btn-good" data-act="approved">اعتماد</button>` : ""}
      ${item.status !== "excluded" ? `<button class="btn-bad" data-act="excluded">استبعاد</button>` : ""}
      ${item.status === "excluded" ? `<button class="btn-ghost" data-act="inbox">استرجاع للوارد</button>` : ""}
    </div>
  `;
  document.querySelectorAll(".item").forEach((el) => {
    el.classList.toggle("selected", el.dataset.id === id);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function refreshAll() {
  await Promise.all([loadStats(), loadItems()]);
  if (state.selectedId) {
    try {
      await loadDetail(state.selectedId);
    } catch {
      $("detail").innerHTML = `<p class="muted">اختر خبرًا لعرض التفاصيل.</p>`;
    }
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", async () => {
    state.status = tab.dataset.status;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === tab));
    state.selectedId = null;
    $("detail").innerHTML = `<p class="muted">اختر خبرًا لعرض التفاصيل.</p>`;
    await loadItems();
  });
});

$("list").addEventListener("click", (e) => {
  const btn = e.target.closest(".item");
  if (btn) loadDetail(btn.dataset.id);
});

$("detail").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn || !state.selectedId) return;
  const status = btn.dataset.act;
  const reason = status === "excluded" ? window.prompt("سبب الاستبعاد؟", "غير مناسب للرصد") : null;
  if (status === "excluded" && reason === null) return;
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
    const errNote = result.errors?.length ? ` تنبيهات المصادر: ${result.errors.length}.` : "";
    $("detail").innerHTML = `<p>انتهى البحث اليدوي. وصل ${result.found} خبرًا جديدًا، ومُنع ${result.duplicates} تكرارًا، واستُبعد ${result.excluded} تلقائيًا.${errNote}</p>`;
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
