import {
  aggregateSlotBudget,
  providerLaneSnapshot,
  slotRuntimeStatuses,
} from "../aiDispatch.js";
import { aiBriefEnabled } from "../aiProviders.js";
import { deskLaneStatSql, publicLaneStats } from "../deskLanes.js";
import { sourceStatus } from "../pipeline.js";
import { REASON } from "../reasons.js";
import { MAX_SOURCES_PER_OFFICE, allSources, registeredSourcesSql } from "../sources.js";
import { MAX_BRIEF_ATTEMPTS, briefBacklog, pendingBriefCount } from "../translate.js";
import { ITEM_RETENTION_DAYS, ITEM_WINDOW_DAYS } from "../config.js";

export function publicSlotStatus(slot, { includeHasKey = false } = {}) {
  const budget = slot.budget || {};
  const row = {
    id: slot.id,
    nameAr: slot.nameAr,
    model: slot.model,
    bound: Boolean(slot.bound),
    enabled: Boolean(slot.enabled),
    blocked: Boolean(slot.blocked),
    budget: {
      remaining: Number(budget.remaining) || 0,
      dailyLimit: Number(budget.dailyLimit) || 0,
      used: Number(budget.used) || 0,
      minIntervalMs: Number(budget.minIntervalMs) || 0,
      resumesInSeconds: Number(budget.resumesInSeconds) || 0,
      blockReason: budget.blockReason || null,
    },
    lastError: slot.lastError
      ? { code: String(slot.lastError.code), at: slot.lastError.at || null }
      : null,
  };
  if (includeHasKey) row.hasKey = Boolean(slot.hasKey);
  return row;
}

function aiToolChips(slots) {
  return slots.map((slot) => {
    const budget = slot.budget || {};
    let ok = true;
    let detail = `يقرأ الصفحة ويكتب الموجز بنداء واحد · بقي ${budget.remaining} من ${budget.dailyLimit} نداءً`;
    if (!slot.enabled) {
      ok = false;
      detail = "موقوف من إعداد التفعيل";
    } else if (!slot.bound) {
      ok = false;
      detail = "المفتاح غير مربوط";
    } else if (budget.blocked || Number(budget.remaining) <= 0) {
      ok = "warn";
      detail = budget.blocked
        ? `متوقف مؤقتًا · بقي ${budget.remaining} من ${budget.dailyLimit} نداءً`
        : `نفدت الحصة اليومية · بقي 0 من ${budget.dailyLimit} نداءً`;
    }
    if (slot.lastError?.code) {
      detail += ` · آخر خطأ: ${slot.lastError.code}`;
    }
    return {
      id: `ai-${slot.id}`,
      name: `الذكاء الاصطناعي — ${slot.nameAr} — ${slot.model}`,
      icon: "spark",
      ok,
      detail,
    };
  });
}

export async function slotOverview(env) {
  const slots = await slotRuntimeStatuses(env);
  return {
    slots,
    budget: aggregateSlotBudget(slots),
    configured: aiBriefEnabled(env),
    model: slots.find((slot) => slot.bound)?.model || null,
  };
}

export async function publicHealth(env) {
  const ai = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN trans_engine = 'brief-pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN trans_engine = 'brief-deferred' THEN 1 ELSE 0 END) AS waitingQuota,
       SUM(CASE WHEN trans_engine = 'brief-unconfigured' THEN 1 ELSE 0 END) AS unconfigured,
       SUM(CASE WHEN trans_engine = 'brief-ai-error' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN trans_engine LIKE 'brief-ai-%-v2:%' THEN 1 ELSE 0 END) AS completed
     FROM items`,
  ).first();
  const { results } = await env.DB.prepare(
    `SELECT brief_error AS code, COUNT(*) AS count
     FROM items
     WHERE brief_error IS NOT NULL
     GROUP BY brief_error
     ORDER BY count DESC
     LIMIT 5`,
  ).all();
  const overview = await slotOverview(env);
  return {
    ok: true,
    cron: "Sunday 06:00 Asia/Riyadh",
    briefDrainCron: "every 10 minutes",
    queue: Boolean(env.SCAN_QUEUE),
    ai: {
      configured: overview.configured,
      model: overview.model,
      pending: Number(ai?.pending) || 0,
      waitingQuota: Number(ai?.waitingQuota) || 0,
      unconfigured: Number(ai?.unconfigured) || 0,
      failed: Number(ai?.failed) || 0,
      completed: Number(ai?.completed) || 0,
      retryable: await pendingBriefCount(env),
      maxAttempts: MAX_BRIEF_ATTEMPTS,
      errors: results || [],
      budget: overview.budget,
      slots: overview.slots.map((slot) => publicSlotStatus(slot)),
    },
  };
}

export async function stats(env) {
  const laneSql = deskLaneStatSql("items");
  // مجاميع كل مكتب تكفي لاشتقاق المجموع الكلي، فيُلغى مسحٌ كامل ثانٍ للجدول.
  const byMayor = await env.DB.prepare(
    `SELECT mayor_id, COUNT(*) AS total,
            ${laneSql},
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
            SUM(CASE WHEN status = 'excluded' THEN 1 ELSE 0 END) AS excluded
     FROM items GROUP BY mayor_id`,
  ).all();
  const mayorRows = byMayor.results || [];
  const laneKeys = ["reading", "verifying", "decision_ready", "attention_required"];
  const row = mayorRows.reduce(
    (acc, entry) => {
      acc.approved += Number(entry.approved) || 0;
      acc.excluded += Number(entry.excluded) || 0;
      acc.total += Number(entry.total) || 0;
      for (const key of laneKeys) acc[key] += Number(entry[key]) || 0;
      return acc;
    },
    { approved: 0, excluded: 0, total: 0, reading: 0, verifying: 0, decision_ready: 0, attention_required: 0 },
  );
  const lastWeekly = await env.DB.prepare(
    `SELECT * FROM scans WHERE type = 'weekly' ORDER BY started_at DESC LIMIT 1`,
  ).first();
  const lastManual = await env.DB.prepare(
    `SELECT * FROM scans WHERE type = 'manual' ORDER BY started_at DESC LIMIT 1`,
  ).first();
  // عدّ المكرر والمكتشف في نافذة الأسبوع بمسح واحد بدل مسحين متتاليين.
  const week = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN exclude_reason = ? THEN 1 ELSE 0 END) AS duplicates,
       COUNT(*) AS found
     FROM items
     WHERE COALESCE(published_at, created_at) >= datetime('now', '-${ITEM_WINDOW_DAYS} days')`,
  )
    .bind(REASON.DUPLICATE)
    .first();
  const overview = await slotOverview(env);
  const lanes = publicLaneStats(row);
  return {
    ...lanes,
    approved: row.approved || 0,
    excluded: row.excluded || 0,
    total: row.total || 0,
    byMayor: mayorRows.map((entry) => ({
      mayor_id: entry.mayor_id,
      total: entry.total || 0,
      approved: entry.approved || 0,
      excluded: entry.excluded || 0,
      ...publicLaneStats(entry),
    })),
    lastWeekly,
    lastManual,
    week: { duplicates: week?.duplicates || 0, found: week?.found || 0 },
    sources: {
      ...sourceStatus(env),
      ai_brief: aiBriefEnabled(env) ? "ready" : "unconfigured",
    },
    ai: {
      configured: overview.configured,
      model: overview.model,
      pending: await pendingBriefCount(env),
      budget: overview.budget,
      slots: overview.slots.map((slot) => publicSlotStatus(slot)),
    },
    registry: await registrySummary(env),
  };
}

async function providerLanes(env) {
  return providerLaneSnapshot(env, await briefBacklog(env));
}

/** كل ما يشرح ما يعمل الآن ولماذا، في مكان واحد يفتحه المستخدم عند الحاجة. */
export async function diagnostics(env) {
  const brief = await env.DB.prepare(
    `SELECT
       SUM(CASE WHEN trans_engine LIKE 'brief-ai-%-v2:%' THEN 1 ELSE 0 END) AS completed,
       SUM(CASE WHEN trans_engine = 'brief-pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN trans_engine = 'brief-deferred' THEN 1 ELSE 0 END) AS waitingQuota,
       SUM(CASE WHEN trans_engine = 'brief-ai-error' THEN 1 ELSE 0 END) AS failed,
       SUM(CASE WHEN IFNULL(brief_attempts, 0) >= ${MAX_BRIEF_ATTEMPTS} THEN 1 ELSE 0 END) AS exhausted
     FROM items`,
  ).first();
  const { results: errors } = await env.DB.prepare(
    `SELECT brief_error AS code, COUNT(*) AS count, MAX(IFNULL(brief_attempts, 0)) AS attempts
     FROM items WHERE brief_error IS NOT NULL
     GROUP BY brief_error ORDER BY count DESC LIMIT 8`,
  ).all();
  const { results: sources } = await env.DB.prepare(
    `SELECT sources.mayor_id, sources.domain, sources.name, sources.tier, sources.kind,
            sources.rank, sources.last_status, sources.last_items, sources.last_ok_at,
            sources.consecutive_failures, sources.verified, sources.curated_at,
            sources.enabled, sources.connect_status, sources.http_status, sources.parse_status,
            sources.discovered_count, sources.new_count, sources.last_checked_at,
            sources.last_discovery_at, sources.fail_reason, sources.last_strategy,
            mayors.name_ar
     FROM sources JOIN mayors ON mayors.id = sources.mayor_id
     WHERE ${registeredSourcesSql("sources.")}
     ORDER BY sources.mayor_id, sources.rank`,
  ).all();
  const window = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            MIN(COALESCE(published_at, created_at)) AS oldest,
            MAX(COALESCE(published_at, created_at)) AS newest
     FROM items
     WHERE COALESCE(published_at, created_at) >= datetime('now', '-${ITEM_WINDOW_DAYS} days')`,
  ).first();
  const lastScan = await env.DB.prepare(
    `SELECT type, started_at, finished_at, found_count, duplicate_count,
            excluded_count, error_count, notes
     FROM scans ORDER BY started_at DESC LIMIT 1`,
  ).first();
  const registry = await registrySummary(env);
  const overview = await slotOverview(env);
  const budget = overview.budget;
  const mergeSlot =
    overview.slots.find((slot) => slot.id === "gemini" && slot.bound) ||
    overview.slots.find((slot) => slot.bound);
  const pageSources = allSources().filter((source) =>
    (source.discovery || []).some((step) => step.type === "newsroom"),
  ).length;
  const readerOk = Number(window?.total) > 0 || !lastScan;
  return {
    windowDays: ITEM_WINDOW_DAYS,
    retentionDays: ITEM_RETENTION_DAYS,
    tools: [
      {
        id: "registry",
        name: "سجل المصادر",
        icon: "list",
        ...registryChip(registry),
      },
      {
        id: "reader",
        name: "قارئ الصفحات",
        icon: "page",
        ok: readerOk,
        detail: `يفتح كل رابط ويستخرج نص الخبر · ${pageSources} مصدرًا يُقرأ من صفحته لعدم نشره تغذية`,
      },
      ...aiToolChips(overview.slots),
      {
        id: "merge",
        name: "دمج الأحداث",
        icon: "merge",
        ok: overview.configured,
        detail: `يوحّد تغطية الحدث نفسه عبر اللغات والمنصات · حصته ${Number(mergeSlot?.budget?.mergeLimit) || 0} نداءً يوميًا`,
      },
      {
        id: "queue",
        name: "طابور التشغيل",
        icon: "queue",
        ok: Boolean(env.SCAN_QUEUE),
        detail: Boolean(env.SCAN_QUEUE)
          ? "يشغّل البحث في الخلفية فلا تتجمد الصفحة"
          : "غير مربوط — سيعمل البحث داخل الطلب",
      },
      {
        id: "scheduler",
        name: "المجدول التلقائي",
        icon: "clock",
        ok: true,
        detail: "رصد أسبوعي الأحد 06:00 بتوقيت الرياض · تصريف الموجزات كل عشر دقائق",
      },
      {
        id: "database",
        name: "قاعدة البيانات",
        icon: "db",
        ok: true,
        detail: `تحفظ نافذة ${ITEM_WINDOW_DAYS} أيام وتحذف ما بعدها بعد ${ITEM_RETENTION_DAYS} أيام`,
      },
      {
        id: "engines",
        name: "محركات البحث",
        icon: "ban",
        ok: null,
        detail: "معطّلة بالحوكمة — روابط جوجل ملفوفة لا تُقرأ، وبينج يعيد نطاقات غير موثوقة",
      },
    ],
    window: {
      total: Number(window?.total) || 0,
      oldest: window?.oldest || null,
      newest: window?.newest || null,
    },
    brief: {
      completed: Number(brief?.completed) || 0,
      pending: Number(brief?.pending) || 0,
      waitingQuota: Number(brief?.waitingQuota) || 0,
      failed: Number(brief?.failed) || 0,
      exhausted: Number(brief?.exhausted) || 0,
      maxAttempts: MAX_BRIEF_ATTEMPTS,
      errors: errors || [],
    },
    ai: {
      configured: overview.configured,
      model: overview.model,
      budget,
      slots: overview.slots.map((slot) => publicSlotStatus(slot, { includeHasKey: true })),
    },
    verification: await env.DB.prepare(
      `SELECT
         IFNULL(SUM(CASE WHEN verify_state = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
         IFNULL(SUM(CASE WHEN verify_state = 'passed' THEN 1 ELSE 0 END), 0) AS passed,
         IFNULL(SUM(CASE WHEN verify_state = 'failed' THEN 1 ELSE 0 END), 0) AS failed
       FROM brief_versions WHERE superseded_at IS NULL`,
    ).first(),
    decisions: await env.DB.prepare(
      `SELECT COUNT(*) AS total,
              IFNULL(SUM(CASE WHEN decision = 'approved' THEN 1 ELSE 0 END), 0) AS approved
       FROM approvals`,
    ).first(),
    registry,
    sources: (sources || []).map((row) => ({ ...row, operational: operationalStatus(row) })),
    lastScan: lastScan || null,
    queue: Boolean(env.SCAN_QUEUE),
    providers: await providerLanes(env),
  };
}

export function operationalStatus(row) {
  if (Number(row?.enabled) === 0) {
    return { code: "disabled", label: "متوقفة يدويًا" };
  }
  const status = String(row?.last_status || row?.connect_status || "");
  if (!row?.last_checked_at && !status) {
    return { code: "unchecked", label: "لم تُفحص بعد في هذه البيئة" };
  }
  if (status === "ok_no_new" || (row?.ok && Number(row.new_count) === 0 && Number(row.consecutive_failures) === 0)) {
    return { code: "ok_no_new", label: "تعمل ولا توجد أخبار جديدة" };
  }
  if (status === "ok") return { code: "ok", label: "تعمل" };
  if (status === "feed_stalled") {
    return { code: "feed_stalled", label: "التغذية توقفت عن التحديث" };
  }
  if (status === "feed_corrupt") {
    return { code: "feed_corrupt", label: "التغذية فاسدة" };
  }
  if (status === "bad_url" || status === "error_page") {
    return { code: "bad_url", label: "رابط المصدر غير صحيح" };
  }
  if (status === "needs_javascript") {
    return { code: "needs_javascript", label: "الصفحة تحتاج JavaScript" };
  }
  if (status === "worker_rejected" || /403|401/.test(status)) {
    return { code: "worker_rejected", label: "الموقع يرفض العامل" };
  }
  if (status === "empty_parse" || status === "no_article_links") {
    return { code: "empty_parse", label: "التحليل لم يجد روابط" };
  }
  if (status === "not_articles") {
    return { code: "not_articles", label: "الروابط المكتشفة ليست مقالات" };
  }
  if (status === "unrelated") {
    return { code: "unrelated", label: "المقالات لا تتعلق بالعمدة" };
  }
  if (Number(row?.consecutive_failures) >= 3) {
    return { code: "failing", label: row.fail_reason || status || "متعثر" };
  }
  return { code: status || "unknown", label: row.fail_reason || status || "غير معروف" };
}

export function registryChip(registry) {
  const failing = Number(registry?.failing) || 0;
  const total = Number(registry?.total) || 0;
  const verified = Number(registry?.verified) || 0;
  const perOffice = Number(registry?.perOffice) || 3;
  if (!total) {
    return { ok: false, detail: "السجل فارغ — لا نطاقات معتمدة." };
  }
  if (failing > 0) {
    return {
      ok: "warn",
      detail:
        `السجل يعمل ولم يُوقف. ${failing} مصدرًا من ${total} تعثر ثلاث مرات متتالية عند الجلب ` +
        `(غالبًا رفض 403 أو مهلة من موقع البلدية). باقي المصادر تُقرأ كالمعتاد.`,
    };
  }
  return {
    ok: true,
    detail: `${total} نطاقًا معتمدًا · ${perOffice} لكل مكتب · مُتحقق منها بالفحص ${verified}`,
  };
}

async function registrySummary(env) {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN last_ok_at IS NOT NULL AND IFNULL(consecutive_failures, 0) = 0
                     THEN 1 ELSE 0 END) AS healthy,
            SUM(CASE WHEN IFNULL(consecutive_failures, 0) >= 3 THEN 1 ELSE 0 END) AS failing,
            SUM(CASE WHEN last_checked_at IS NULL THEN 1 ELSE 0 END) AS unchecked,
            SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) AS verified
     FROM sources WHERE ${registeredSourcesSql()}`,
  ).first();
  return {
    total: Number(row?.total) || 0,
    healthy: Number(row?.healthy) || 0,
    failing: Number(row?.failing) || 0,
    unchecked: Number(row?.unchecked) || 0,
    verified: Number(row?.verified) || 0,
    perOffice: MAX_SOURCES_PER_OFFICE,
  };
}
