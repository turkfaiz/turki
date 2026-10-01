/**
 * حالة الأدوات والتحقق من عملها.
 *
 * `toolsOverview` رخيصة (بلا مسح لجداول الأخبار) فتُقرأ مع كل فتح للصفحة. أما
 * `testTool` فتجري فحصًا حيًا واحدًا بطلب صريح من الموظف، لأن بعضها يستهلك نداءً
 * من حصة الذكاء الاصطناعي.
 */
import { pingAiSlot } from "../aiBrief.js";
import { boundSlot } from "../aiProviders.js";
import { allSources } from "../sources.js";
import { operationalStatus, publicSlotStatus, slotOverview } from "./status.js";

export const HEARTBEAT_KEY = "last_cron";
/** المجدول يعمل كل عشر دقائق؛ بعد ثلاثة أضعاف ذلك بلا نبضة نعدّه متوقفًا. */
const CRON_WARN_MS = 25 * 60 * 1000;
const CRON_BAD_MS = 60 * 60 * 1000;

export async function recordHeartbeat(env, cron) {
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`)
    .bind(HEARTBEAT_KEY, JSON.stringify({ at: new Date().toISOString(), cron: cron || "" }))
    .run();
}

async function readHeartbeat(env) {
  const row = await env.DB.prepare(`SELECT v FROM meta WHERE k = ?`).bind(HEARTBEAT_KEY).first();
  try {
    return row?.v ? JSON.parse(row.v) : null;
  } catch {
    return null;
  }
}

const tool = (id, group, name, state, detail, extra = {}) => ({
  id,
  group,
  name,
  state,
  detail,
  testable: false,
  ...extra,
});

function schedulerTool(beat, now = Date.now()) {
  if (!beat?.at) {
    return tool(
      "scheduler",
      "infrastructure",
      "المجدول التلقائي",
      "idle",
      "لم تُسجَّل نبضة بعد. يعمل كل 10 دقائق، فتظهر خلال دقائق من أول نشر.",
      { testable: true },
    );
  }
  const age = now - Date.parse(beat.at);
  const state = age > CRON_BAD_MS ? "bad" : age > CRON_WARN_MS ? "warn" : "ok";
  const detail =
    state === "ok"
      ? "يعمل: آخر تشغيل مسجّل ضمن الفاصل المتوقع (كل 10 دقائق)."
      : "لم يُسجَّل تشغيل منذ مدة أطول من المتوقع. تحقق من Cron Triggers في Cloudflare.";
  return tool("scheduler", "infrastructure", "المجدول التلقائي", state, detail, {
    last_at: beat.at,
    testable: true,
  });
}

function slotTool(slot) {
  const b = slot.budget;
  let state = "ok";
  let detail = `بقي ${b.remaining} من ${b.dailyLimit} نداءً اليوم`;
  if (!slot.enabled) {
    state = "idle";
    detail = "موقوف من إعداد التفعيل";
  } else if (!slot.bound) {
    state = "bad";
    detail = "المفتاح غير مربوط";
  } else if (slot.blocked) {
    state = "warn";
    detail = "متوقف مؤقتًا بعد خطأ من المزوّد";
  } else if (b.remaining <= 0) {
    state = "warn";
    detail = "نفدت حصة اليوم";
  }
  return tool(`ai:${slot.id}`, "ai", `${slot.nameAr} — ${slot.model}`, state, detail, {
    testable: slot.bound && slot.enabled,
    test_cost: "نداء واحد من حصة اليوم",
    last_error: slot.lastError,
  });
}

export async function toolsOverview(env, now = Date.now()) {
  const tools = [];

  tools.push(
    env.DASHBOARD_PASSWORD
      ? tool("security", "security", "حماية الصفحة", "ok", "كلمة سر الصفحة مضبوطة، ولا تُفتح الواجهة بدونها.")
      : tool(
          "security",
          "security",
          "حماية الصفحة",
          "warn",
          "لا كلمة سر للصفحة. أي شخص يملك الرابط يفتحها ويعتمد الأخبار. اضبط DASHBOARD_PASSWORD.",
        ),
  );

  const db = await env.DB.prepare(`SELECT COUNT(*) AS n FROM mayors`).first();
  tools.push(
    tool("database", "infrastructure", "قاعدة البيانات", "ok", `متصلة · ${db?.n ?? 0} مكتبًا مسجلًا`, {
      testable: true,
    }),
  );

  const stuck = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM search_jobs
     WHERE status IN ('queued', 'running') AND created_at < datetime('now', '-45 minutes')`,
  ).first();
  tools.push(
    !env.SCAN_QUEUE
      ? tool("queue", "infrastructure", "طابور التشغيل", "bad", "الطابور غير مربوط: لا يعمل الرصد في الخلفية.")
      : Number(stuck?.n) > 0
        ? tool(
            "queue",
            "infrastructure",
            "طابور التشغيل",
            "warn",
            `${stuck.n} مهمة رصد عالقة منذ أكثر من 45 دقيقة. قد يتعثر المستهلك.`,
            { testable: true },
          )
        : tool("queue", "infrastructure", "طابور التشغيل", "ok", "مربوط ولا مهام عالقة.", { testable: true }),
  );

  tools.push(schedulerTool(await readHeartbeat(env), now));

  const ai = await slotOverview(env);
  for (const slot of ai.slots.map((entry) => publicSlotStatus(entry))) tools.push(slotTool(slot));

  const sources = await env.DB.prepare(
    `SELECT id, enabled, last_status, connect_status, last_checked_at, consecutive_failures,
            read_count, fail_reason
     FROM sources`,
  ).all();
  const known = new Set(allSources().map((source) => source.id));
  const rows = (sources.results || []).filter((row) => known.has(row.id) && Number(row.enabled) !== 0);
  const failing = rows.filter((row) =>
    ["worker_rejected", "bad_url", "failing", "feed_stalled", "feed_corrupt", "empty_parse", "needs_javascript", "not_articles"].includes(
      operationalStatus(row).code,
    ),
  );
  const unchecked = rows.filter((row) => !row.last_checked_at);
  tools.push(
    tool(
      "sources",
      "sources",
      "مواقع الرصد",
      failing.length ? "warn" : unchecked.length === rows.length ? "idle" : "ok",
      `${rows.length} موقعًا مفعّلًا · ${failing.length} متعثر · ${unchecked.length} لم يُفحص بعد`,
      { testable: true, test_cost: "فحص كل موقع بطلبات حقيقية", failing: failing.map((row) => row.id) },
    ),
  );
  const reads = rows.reduce((sum, row) => sum + (Number(row.read_count) || 0), 0);
  tools.push(
    tool(
      "reader",
      "sources",
      "قارئ الصفحات",
      reads ? "ok" : "idle",
      reads ? `قرأ ${reads} صفحة منذ التشغيل` : "لم يقرأ صفحات بعد. يبدأ مع أول رصد.",
    ),
  );

  const worst = tools.some((entry) => entry.state === "bad")
    ? "bad"
    : tools.some((entry) => entry.state === "warn")
      ? "warn"
      : "ok";
  return {
    state: worst,
    needs_attention: tools.filter((entry) => entry.state === "bad" || entry.state === "warn").length,
    tools,
  };
}

/** فحص حي لأداة واحدة. يعيد { ok, ms, detail } ولا يغيّر شيئًا إلا ما يذكره الوصف. */
export async function testTool(env, id, { fetcher = fetch } = {}) {
  const started = Date.now();
  if (id === "database") {
    const tables = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'`,
    ).first();
    await env.DB.prepare(`SELECT 1`).first();
    return { ok: true, ms: Date.now() - started, detail: `يقرأ ويجيب · ${tables?.n ?? 0} جدولًا` };
  }
  if (id === "queue") {
    if (!env.SCAN_QUEUE) return { ok: false, ms: 0, detail: "الطابور غير مربوط في إعدادات النشر." };
    const jobs = await env.DB.prepare(
      `SELECT status, COUNT(*) AS n FROM search_jobs
       WHERE created_at >= datetime('now', '-1 day') GROUP BY status`,
    ).all();
    const summary = (jobs.results || []).map((row) => `${row.status}: ${row.n}`).join(" · ") || "لا مهام آخر 24 ساعة";
    return { ok: true, ms: Date.now() - started, detail: `مربوط · ${summary}` };
  }
  if (id === "scheduler") {
    const state = schedulerTool(await readHeartbeat(env));
    return { ok: state.state === "ok", ms: Date.now() - started, detail: state.detail, last_at: state.last_at || null };
  }
  if (id.startsWith("ai:")) {
    const slot = boundSlot(env, id.slice(3));
    if (!slot) return { ok: false, ms: 0, detail: "النموذج غير مربوط أو موقوف." };
    const ping = await pingAiSlot(env, slot, fetcher);
    return {
      ok: ping.ok,
      ms: ping.ms,
      detail: ping.ok ? "ردّ النموذج صحيحًا بالمفتاح والطراز المضبوطين." : `فشل النداء: ${ping.error}`,
      error: ping.error || "",
    };
  }
  return { ok: false, ms: 0, detail: "لا اختبار حي لهذه الأداة.", unknown: true };
}
