/**
 * موزّع القراءة.
 *
 * كل خبر يُسند إلى فتحة واحدة قبل النداء. الطابور المعروض لكل نموذج هو
 * أخباره المسندة إليه، لا الطابور العام منسوخًا على كل بطاقة. السعة الحية
 * تمنع ركن العمل عند نموذج متوقف بينما الآخرون فارغون.
 */

import { budgetSettings, budgetState } from "./aiBudget.js";
import { BRIEF_STATE } from "./aiBrief.js";
import {
  AI_SLOTS,
  allSlotBindings,
  boundSlots,
  completedBriefSql,
  slotBinding,
  slotIntervalMs,
} from "./aiProviders.js";

export const MAX_BRIEF_ATTEMPTS = 5;
export const CLAIM_TIMEOUT_MINUTES = 10;

export function briefScopeSql(alias = "items") {
  return `(${alias}.status IN ('inbox', 'approved')
      OR (
        ${alias}.status = 'excluded'
        AND ${alias}.publisher_tier IN (0, 1)
        AND LENGTH(IFNULL(${alias}.article_text, '')) > 80
      ))`;
}

export function pendingBriefFilter(alias = "items") {
  return `${briefScopeSql(alias)}
    AND NOT (${completedBriefSql(alias)})
    AND IFNULL(${alias}.trans_engine, '') NOT IN ('${BRIEF_STATE.UNCONFIGURED}', '${BRIEF_STATE.FAILED}')
    AND IFNULL(${alias}.brief_attempts, 0) < ${MAX_BRIEF_ATTEMPTS}`;
}

export function liveClaimSql(alias = "items") {
  return `${alias}.brief_claim_id IS NOT NULL
    AND ${alias}.brief_claimed_at > datetime('now', '-${CLAIM_TIMEOUT_MINUTES} minutes')`;
}

/** المعلّق الذي ليس بين يدي نداء حي، فيُحسب في الطابور لا في جاري العمل. */
export function waitingBriefFilter(alias = "items") {
  return `${pendingBriefFilter(alias)}
    AND NOT (${liveClaimSql(alias)})`;
}

export function eligibleBriefFilter(alias = "items") {
  return `${waitingBriefFilter(alias)}
    AND (${alias}.brief_after IS NULL OR ${alias}.brief_after <= datetime('now'))`;
}

function openSlotIds(states) {
  return states.filter((row) => !row.blocked && row.remaining > 0).map((row) => row.providerId);
}

async function slotStates(env) {
  const bound = boundSlots(env);
  const states = [];
  for (const slot of bound) {
    states.push(await budgetState(env, slot.id));
  }
  return { bound, states };
}

async function loadCounts(env, providerIds, mayorId = null) {
  const loads = Object.fromEntries(providerIds.map((id) => [id, 0]));
  if (!providerIds.length) return loads;
  const binds = [...providerIds];
  let sql = `SELECT brief_provider AS id, COUNT(*) AS n
     FROM items
     WHERE ${pendingBriefFilter()}
       AND brief_provider IN (${providerIds.map(() => "?").join(", ")})`;
  if (mayorId) {
    sql += " AND items.mayor_id = ?";
    binds.push(mayorId);
  }
  sql += " GROUP BY brief_provider";
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  for (const row of results || []) {
    loads[row.id] = Number(row.n) || 0;
  }
  return loads;
}

function leastLoadedId(ids, loads) {
  return [...ids].sort(
    (a, b) => (loads[a] || 0) - (loads[b] || 0) || a.localeCompare(b),
  )[0];
}

/**
 * يسند غير الموزَّع، ويعيد ما رُكن عند فتحة بلا رصيد يومي إلى فتحة تملك سعة.
 * التباعد اللحظي لا يُفرّغ المسار: وإلا تنقّل الخبر بين النماذج كل بضع ثوانٍ.
 */
export async function assignPendingLanes(env, mayorId = null) {
  const { bound, states } = await slotStates(env);
  if (!bound.length) return { assigned: 0, reassigned: 0, loads: {} };

  const allIds = bound.map((slot) => slot.id);
  const openIds = openSlotIds(states);
  const targetIds = openIds.length ? openIds : allIds;
  let reassigned = 0;

  if (openIds.length && openIds.length < allIds.length) {
    const parked = allIds.filter((id) => !openIds.includes(id));
    const binds = [...parked];
    let sql = `UPDATE items SET brief_provider = NULL, brief_after = NULL, trans_engine = '${BRIEF_STATE.PENDING}'
       WHERE ${waitingBriefFilter()}
         AND brief_provider IN (${parked.map(() => "?").join(", ")})`;
    if (mayorId) {
      sql += " AND items.mayor_id = ?";
      binds.push(mayorId);
    }
    const cleared = await env.DB.prepare(sql).bind(...binds).run();
    reassigned = Number(cleared?.meta?.changes) || 0;
  }

  const binds = [];
  let sql = `SELECT id FROM items
     WHERE ${waitingBriefFilter()}
       AND (brief_provider IS NULL OR brief_provider = '')`;
  if (mayorId) {
    sql += " AND items.mayor_id = ?";
    binds.push(mayorId);
  }
  sql += " ORDER BY COALESCE(items.published_at, items.created_at) DESC LIMIT 200";
  const { results: rows } = binds.length
    ? await env.DB.prepare(sql).bind(...binds).all()
    : await env.DB.prepare(sql).all();
  const pending = rows || [];
  if (!pending.length) {
    return { assigned: 0, reassigned, loads: await loadCounts(env, allIds, mayorId) };
  }

  const loads = await loadCounts(env, targetIds, mayorId);
  const stmt = env.DB.prepare(`UPDATE items SET brief_provider = ? WHERE id = ?`);
  const batch = [];
  for (const row of pending) {
    const pick = leastLoadedId(targetIds, loads);
    loads[pick] = (loads[pick] || 0) + 1;
    batch.push(stmt.bind(pick, row.id));
  }
  if (batch.length) await env.DB.batch(batch);
  return {
    assigned: pending.length,
    reassigned,
    loads: await loadCounts(env, allIds, mayorId),
  };
}

export async function nextSlotForFailover(env, currentId) {
  const { bound, states } = await slotStates(env);
  const open = openSlotIds(states).filter((id) => id !== currentId);
  const fallback = bound.map((slot) => slot.id).filter((id) => id !== currentId);
  const pick = open[0] || fallback[0];
  return bound.find((slot) => slot.id === pick) || null;
}

export function failoverAttemptLimit(env) {
  const n = boundSlots(env).length;
  return Math.max(1, Math.min(MAX_BRIEF_ATTEMPTS, n || 1));
}

/**
 * آخر خطأ نهائي لكل فتحة. أخطاء التدوير تُكتب على الفتحة التالية وهي ما زالت
 * معلّقة، فلا تُحسب هنا حتى لا يُتهم ديبسيك برفض جيميني.
 */
export async function lastErrorsByProvider(env) {
  const { results } = await env.DB.prepare(
    `SELECT brief_provider AS id, brief_error AS code, brief_attempted_at AS at
     FROM items
     WHERE trans_engine = '${BRIEF_STATE.FAILED}'
       AND IFNULL(brief_provider, '') <> ''
       AND IFNULL(brief_error, '') <> ''
     ORDER BY brief_attempted_at DESC, rowid DESC`,
  ).all();
  const out = {};
  for (const row of results || []) {
    const id = String(row.id || "").toLowerCase();
    if (!id || out[id]) continue;
    out[id] = { code: String(row.code), at: row.at || null };
  }
  return out;
}

export function aggregateSlotBudget(slots) {
  const bound = (slots || []).filter((row) => row.bound);
  if (!bound.length) {
    return {
      remaining: 0,
      dailyLimit: 0,
      used: 0,
      mergeLimit: 0,
      minIntervalMs: 0,
      blocked: false,
      blockReason: null,
      resumesInSeconds: 0,
    };
  }
  const remaining = bound.reduce((sum, row) => sum + Number(row.budget?.remaining || 0), 0);
  const dailyLimit = bound.reduce((sum, row) => sum + Number(row.budget?.dailyLimit || 0), 0);
  const used = bound.reduce((sum, row) => sum + Number(row.budget?.used || 0), 0);
  const mergeLimit = bound.reduce((sum, row) => sum + Number(row.budget?.mergeLimit || 0), 0);
  const minIntervalMs = Math.min(
    ...bound.map((row) => Number(row.budget?.minIntervalMs ?? row.minIntervalMs ?? 0)),
  );
  const allBlocked = bound.every((row) => row.blocked || row.budget?.blocked);
  const resumesInSeconds = allBlocked
    ? Math.min(...bound.map((row) => Number(row.budget?.resumesInSeconds || 0)))
    : 0;
  const blockReason = allBlocked
    ? bound.find((row) => row.budget?.blockReason)?.budget.blockReason || "provider_cooldown"
    : null;
  return {
    remaining,
    dailyLimit,
    used,
    mergeLimit,
    minIntervalMs,
    blocked: allBlocked,
    blockReason,
    resumesInSeconds,
  };
}

/** انتظار التصريف يتبع أسرع فتحة مربوطة، لا تباعد جيميني وحده. */
export function boundSlotWaitMs(env) {
  const bound = boundSlots(env);
  const intervals = bound.length
    ? bound.map((slot) => slotIntervalMs(env, slot))
    : [budgetSettings(env).minIntervalMs];
  const fastest = Math.min(...intervals.map((value) => Number(value) || 0));
  return Math.max(fastest, 1000);
}

export async function slotRuntimeStatuses(env) {
  const errors = await lastErrorsByProvider(env);
  const statuses = [];
  for (const slot of AI_SLOTS) {
    const binding = slotBinding(env, slot);
    const budget = await budgetState(env, slot.id);
    statuses.push({
      id: binding.id,
      nameAr: binding.nameAr,
      model: binding.model,
      bound: binding.bound,
      enabled: binding.enabled,
      hasKey: binding.hasKey,
      blocked: Boolean(budget.blocked),
      budget,
      lastError: errors[slot.id] || null,
    });
  }
  return statuses;
}

/**
 * لقطة صادقة لكل فتحة. queued هنا أخبار هذه الفتحة فقط.
 */
export async function providerLaneSnapshot(env, backlog) {
  const bindings = allSlotBindings(env);
  const errors = await lastErrorsByProvider(env);
  const laneSql = AI_SLOTS.map(
    (slot) =>
      `SUM(CASE WHEN trans_engine LIKE 'brief-ai-${slot.id}-v2:%' THEN 1 ELSE 0 END) AS ${slot.id}_done,
       SUM(CASE WHEN brief_provider = '${slot.id}' AND (${liveClaimSql()}) THEN 1 ELSE 0 END) AS ${slot.id}_run,
       SUM(CASE WHEN brief_provider = '${slot.id}' AND (${waitingBriefFilter()}) THEN 1 ELSE 0 END) AS ${slot.id}_queued,
       SUM(CASE WHEN trans_engine = '${BRIEF_STATE.FAILED}' AND brief_provider = '${slot.id}' THEN 1 ELSE 0 END) AS ${slot.id}_fail`,
  ).join(",\n       ");
  const counts = await env.DB.prepare(`SELECT ${laneSql} FROM items`).first();
  const lanes = [];
  for (const binding of bindings) {
    lanes.push({
      ...binding,
      queued: Number(counts?.[`${binding.id}_queued`]) || 0,
      inProgress: Number(counts?.[`${binding.id}_run`]) || 0,
      completed: Number(counts?.[`${binding.id}_done`]) || 0,
      failed: Number(counts?.[`${binding.id}_fail`]) || 0,
      budget: await budgetState(env, binding.id),
      lastError: errors[binding.id] || null,
    });
  }
  const unassigned = Number(
    (
      await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM items
         WHERE ${waitingBriefFilter()}
           AND (brief_provider IS NULL OR brief_provider = '')`,
      ).first()
    )?.n,
  ) || 0;
  return {
    queued: backlog?.pending || 0,
    eligible: backlog?.eligible || 0,
    nextAt: backlog?.nextAt || null,
    unassigned,
    bound: bindings.filter((row) => row.bound).length,
    lanes,
  };
}
