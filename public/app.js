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
  return it.news_title_ar || "جارٍ إعداد النشرة الرسمية…";
}

function needsRetranslate(it) {
  return it.trans_engine !== "brief-v2" && it.trans_engine !== "brief-llm";
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
  const mayorId = $("mayor_id")?.value;
  if (mayorId) qs.set("mayor_id", mayorId);
  return `/api/items?${qs.toString()}`;
}

async function loadItems() {
  $("list").innerHTML = `<div class="empty">جاري التحميل…</div>`;
  const { items } = await api(itemsQuery());
  state.items = items;
  renderItems(items);
  if (items.some(needsRetranslate) && !state.translating) {
    state.translating = true;
    (async () => {
      try {
        for (let i = 0; i < 8; i++) {
          const r = await api("/api/translate", { method: "POST", body: "{}" });
          const again = await api(itemsQuery());
          state.items = again.items;
          renderItems(again.items);
          if (state.selectedId) {
            try {
              await loadDetail(state.selectedId);
            } catch {
              /* item may have moved during review */
            }
          }
          if (!r.translated || !(again.items || []).some(needsRetranslate)) break;
        }
      } finally {
        state.translating = false;
      }
    })();
  }
}

function renderItems(items) {
  if (!items.length) {
    $("list").innerHTML = `<div class="empty">لا توجد عناصر في هذا القسم.</div>`;
    return;
  }
  $("list").innerHTML = items
    .map((it) => `
      <button type="button" class="result ${it.id === state.selectedId ? "selected" : ""}" data-id="${it.id}">
        <p class="kicker">${escapeHtml(it.country_ar)} · ${escapeHtml(it.city_ar)} · ${escapeHtml(it.name_ar)}</p>
        <h3 class="headline">${escapeHtml(displayTitle(it))}</h3>
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
  const ar = item.news_title_ar || "جارٍ إعداد النشرة الرسمية…";
  const snippet = item.news_snippet_ar || "";
  const excludeBox =
    item.status === "excluded"
      ? `<p class="meta">سبب الاستبعاد: ${escapeHtml(item.exclude_reason || "—")}</p>`
      : "";
  $("detail").innerHTML = `
    <div class="brief-head">
      <strong>نشرة رسمية</strong>
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
      ${snippet ? `<p class="lede">${escapeHtml(snippet)}</p>` : ""}
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
      $("detail").innerHTML = `<p class="placeholder">اختر خبرًا لعرض النشرة الرسمية ثم الأصل.</p>`;
    }
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", async () => {
    state.status = tab.dataset.status;
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t === tab));
    state.selectedId = null;
    $("detail").innerHTML = `<p class="placeholder">اختر خبرًا لعرض النشرة الرسمية ثم الأصل.</p>`;
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
  await refreshAll();
});

$("mayor_id").addEventListener("change", () => {
  loadItems();
});

$("review-btn").addEventListener("click", async () => {
  if (state.busy) return;
  state.busy = true;
  const btn = $("review-btn");
  btn.disabled = true;
  btn.textContent = "جارٍ المراجعة…";
  try {
    const mayorId = $("mayor_id").value || null;
    const result = await api("/api/review", {
      method: "POST",
      body: JSON.stringify({ mayor_id: mayorId }),
    });
    state.status = "inbox";
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.status === "inbox"));
    await refreshAll();
    $("detail").innerHTML = `<p class="placeholder">المراجعة الكاملة: مجموعات <b class="num">${num(result.groups)}</b> · أُبقي <b class="num">${num(result.kept)}</b> · استُبعد <b class="num">${num(result.excluded)}</b> (غير معتمد ${num(result.untrusted)} · غير متعلق ${num(result.unrelated)} · تكرار ${num(result.duplicates)}). يمكن الاستعادة من المستبعد.</p>`;
  } catch (err) {
    $("detail").innerHTML = `<p class="error">تعذر المراجعة: ${escapeHtml(err.message)}</p>`;
  } finally {
    state.busy = false;
    btn.disabled = false;
    btn.textContent = "مراجعة كاملة";
  }
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
    $("detail").innerHTML = `<p class="placeholder">انتهى البحث (آخر 7 أيام بعد فتح المصدر). جديد: <b class="num">${num(result.found)}</b> · موجود مسبقاً: <b class="num">${num(result.held)}</b> · خارج الأسبوع: <b class="num">${num(result.skippedStale)}</b> · لم يُتحقق: <b class="num">${num(result.skippedUnverified)}</b> · خارج المنصب: <b class="num">${num(result.skippedUnrelated)}</b> · مستبعد: <b class="num">${num(result.excluded)}</b></p>`;
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
