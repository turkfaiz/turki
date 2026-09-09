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
  return { google_news: "Google News", official: "Official", inoreader: "Inoreader", gdelt: "GDELT" }[source] || source;
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

function factItems(snippet) {
  return String(snippet || "")
    .split(/\n+/)
    .flatMap((line) => line.split(/\s*[•📌·]\s*/))
    .map((s) => s.replace(/^[•📌·]\s*/, "").trim())
    .filter((s) => s.length >= 4);
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
  btn.disabled = state.busy || !selectedMayorId();
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
    `<option value="">اختر مكتب العمدة</option>` +
    mayors.map((m) => `<option value="${m.id}">${m.name_ar} — ${m.city_ar}</option>`).join("");
  syncSearchEnabled();
}

function applyPlatform(on, ledId, textId) {
  setLed(ledId, on);
  $(textId).textContent = on ? "يعمل" : "متوقف";
}

async function loadStats() {
  const s = await api("/api/stats");
  $("stat-inbox").textContent = num(s.inbox);
  $("stat-approved").textContent = num(s.approved);
  $("stat-excluded").textContent = num(s.excluded);
  $("stat-dup").textContent = num(s.week?.duplicates);
  applyPlatform(s.sources.inoreader === "ready" || s.sources.inoreader?.on, "led-inoreader", "src-inoreader");
  applyPlatform(s.sources.google_news === "ready" || s.sources.google_news?.on !== false, "led-google", "src-google");
  applyPlatform(s.sources.official === "ready" || s.sources.official?.on !== false, "led-official", "src-official");
  $("last-weekly").textContent = s.lastWeekly ? fmtDate(s.lastWeekly.started_at) : "—";
}

function itemsQuery() {
  const qs = new URLSearchParams({ status: state.status });
  const mayorId = selectedMayorId();
  if (mayorId) qs.set("mayor_id", mayorId);
  return `/api/items?${qs.toString()}`;
}

async function loadItems() {
  if (!selectedMayorId()) {
    state.items = [];
    renderItems([]);
    return;
  }
  $("list").innerHTML = `<div class="empty">جاري التحميل…</div>`;
  const { items } = await api(itemsQuery());
  state.items = items;
  renderItems(items);
}

function renderItems(items) {
  if (!items.length) {
    const waitingMayor = !selectedMayorId();
    $("list").innerHTML = waitingMayor
      ? `<div class="empty">اختر مكتب العمدة ثم اضغط بحث. النظام يفتح المصدر ويدمج الحدث ويكتب النشرة قبل أن يظهر هنا.</div>`
      : `<div class="empty">لا توجد بطاقات في هذا القسم.</div>`;
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
        <span class="badge">${confidenceLabel(item.confidence)}</span>
        <span class="badge">الرصد: ${escapeHtml(item.name_en)}</span>
        <span class="num">${fmtDate(item.published_at || item.created_at)}</span>
      </div>
      ${facts.length ? `<ul class="facts">${facts.map((f) => `<li>${escapeHtml(f)}</li>`).join("")}</ul>` : ""}
      <p class="source-line">المصدر: ${escapeHtml(item.publisher_domain || sourceLabel(item.source))}</p>
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
  loadItems();
});

$("search-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (state.busy) return;
  const mayorId = selectedMayorId();
  if (!mayorId) {
    setDeskStatus("اختر مكتب العمدة أولًا. البحث لمكتب واحد.");
    return;
  }
  state.busy = true;
  syncSearchEnabled();
  const btn = $("search-btn");
  btn.textContent = "جارٍ المسار…";
  setDeskStatus("النظام يفتح المصدر ويدمج الحدث ويكتب النشرة…");
  try {
    const result = await api("/api/search", {
      method: "POST",
      body: JSON.stringify({
        q: $("q").value.trim(),
        mayor_id: mayorId,
      }),
    });
    state.status = "inbox";
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.status === "inbox"));
    state.selectedId = null;
    await refreshAll();
    const ready = (state.items || []).length;
    setDeskStatus(
      `اكتمل المسار. جديد ${num(result.found)} · كان موجودًا ${num(result.held)} · دُمج ${num(result.review?.duplicates || 0)} · بانتظار القرار ${num(ready)}.`,
    );
    if (state.items[0]) {
      await loadDetail(state.items[0].id);
    } else {
      $("detail").innerHTML = `<p class="placeholder">اكتمل المسار ولم تُضف بطاقات جديدة هذا الأسبوع بعد التحقق.</p>`;
    }
  } catch (err) {
    $("detail").innerHTML = `<p class="error">تعذر إكمال المسار: ${escapeHtml(err.message)}</p>`;
    setDeskStatus("تعذر إكمال المسار. أعد المحاولة على المكتب نفسه.");
  } finally {
    state.busy = false;
    btn.textContent = "بحث";
    syncSearchEnabled();
  }
});

loadMayors().then(refreshAll).catch((err) => {
  $("list").innerHTML = `<div class="error">تعذر تحميل الصفحة: ${escapeHtml(err.message)}</div>`;
});
