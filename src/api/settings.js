/**
 * واجهة الإعدادات: كل ما تقرؤه صفحة الإعدادات وتكتبه في مكان واحد.
 *
 *   GET    /api/settings/overview            ملخص + مكاتب + ذكاء اصطناعي + نظام + سجل
 *   GET    /api/settings/offices             المكاتب ومصادرها
 *   POST   /api/settings/mayors              إضافة عمدة (ومعه مواقعه اختياريًا)
 *   PATCH  /api/settings/mayors/:id          تعديل عمدة مضاف
 *   DELETE /api/settings/mayors/:id          حذف عمدة مضاف (لا قرارات محفوظة)
 *   POST   /api/settings/mayors/:id/sites    إضافة موقع: فحص + تجربة + تفعيل
 *   POST   /api/settings/sources/:id         تفعيل/إيقاف مصدر { enabled }
 *   POST   /api/settings/sources/:id/check   فحص فوري لمصدر
 *   DELETE /api/settings/sources/:id         حذف موقع مضاف
 *   GET    /api/settings/audit               آخر التغييرات
 */
import { ITEM_RETENTION_DAYS, ITEM_WINDOW_DAYS } from "../config.js";
import { insertCustomMayor, listMayors, mayorInputMessage, parseMayorInput } from "../mayors.js";
import { deleteCustomMayor, updateCustomMayor } from "../mayorAdmin.js";
import { addSite, checkSite, removeSite } from "../sourceAdmin.js";
import {
  MAX_SOURCES_PER_OFFICE,
  platformLabelAr,
  registeredSourcesSql,
  sourceById,
  strategyLabelAr,
} from "../sources.js";
import { json, readBody, reviewerOf } from "./http.js";
import { operationalStatus, publicSlotStatus, slotOverview } from "./status.js";
import { testTool, toolsOverview } from "./tools.js";

/** حالات تعني أن المصدر المفعّل لا ينتج شيئًا الآن ويحتاج قرارًا من الموظف. */
const NEEDS_ATTENTION = new Set([
  "worker_rejected",
  "bad_url",
  "failing",
  "feed_stalled",
  "feed_corrupt",
  "empty_parse",
  "needs_javascript",
  "not_articles",
]);

export async function settingsOffices(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM sources WHERE ${registeredSourcesSql()} ORDER BY mayor_id, rank`,
  ).all();
  const byMayor = new Map();
  for (const row of results || []) {
    if (!byMayor.has(row.mayor_id)) byMayor.set(row.mayor_id, []);
    const registered = sourceById(row.id);
    const steps = registered?.discovery || [];
    byMayor.get(row.mayor_id).push({
      id: row.id,
      domain: row.domain,
      name: row.name,
      tier: row.tier,
      kind: row.kind,
      url: row.url,
      rank: row.rank,
      enabled: Number(row.enabled) !== 0,
      origin: row.origin === "custom" ? "custom" : "registry",
      added_by: row.added_by || null,
      platform: registered?.platform || (row.tier === 0 ? "official" : "newspaper"),
      platform_ar: platformLabelAr(registered || row),
      searches_by_name: steps.some((step) => step.supplement && step.enabled !== false),
      strategies: steps.map((step) => ({
        type: step.type,
        type_ar: strategyLabelAr(step.type),
        url: step.url || step.query_template || null,
        enabled: step.enabled !== false,
        supplement: Boolean(step.supplement),
      })),
      last_checked_at: row.last_checked_at,
      last_discovery_at: row.last_discovery_at,
      last_ok_at: row.last_ok_at,
      last_status: row.last_status,
      fail_reason: row.fail_reason,
      operational: operationalStatus(row),
    });
  }
  const catalog = await listMayors(env);
  return catalog.map((mayor) => ({
    id: mayor.id,
    origin: mayor.origin || "seed",
    name_ar: mayor.name_ar,
    name_en: mayor.name_en,
    name_native: mayor.name_native,
    city_ar: mayor.city_ar,
    city_en: mayor.city_en,
    country_ar: mayor.country_ar,
    country_code: mayor.country_code,
    title_ar: mayor.title_ar,
    title_en: mayor.title_en,
    native_lang: mayor.native_lang,
    native_lang_ar: mayor.native_lang_ar,
    official_host: mayor.official_host || "",
    platforms: byMayor.get(mayor.id) || [],
  }));
}

export async function setSourceEnabled(env, sourceId, enabled, actor) {
  const source = sourceById(sourceId);
  if (!source) return { error: "unknown_source", status: 404 };
  const before = await env.DB.prepare(`SELECT enabled FROM sources WHERE id = ?`).bind(sourceId).first();
  const next = enabled ? 1 : 0;
  await env.DB.prepare(`UPDATE sources SET enabled = ? WHERE id = ?`).bind(next, sourceId).run();
  await env.DB.prepare(
    `INSERT INTO settings_audit (id, actor, action, source_id, mayor_id, before_json, after_json)
     VALUES (?, ?, 'source_enabled', ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      actor || "unknown",
      sourceId,
      source.mayor_id,
      JSON.stringify({ enabled: Number(before?.enabled) !== 0 }),
      JSON.stringify({ enabled: Boolean(next) }),
    )
    .run();
  return { ok: true, id: sourceId, enabled: Boolean(next) };
}

async function recentAudit(env, limit = 15) {
  const { results } = await env.DB.prepare(
    `SELECT created_at, actor, action, mayor_id, source_id
     FROM settings_audit ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  )
    .bind(Math.min(Math.max(Number(limit) || 15, 1), 50))
    .all();
  return results || [];
}

function summarize(offices) {
  const summary = {
    offices: offices.length,
    custom_offices: 0,
    sources_total: 0,
    sources_active: 0,
    sources_attention: 0,
    offices_without_sources: 0,
    cap_per_office: MAX_SOURCES_PER_OFFICE,
  };
  for (const office of offices) {
    if (office.origin === "custom") summary.custom_offices += 1;
    const active = office.platforms.filter((platform) => platform.enabled);
    if (!active.length) summary.offices_without_sources += 1;
    summary.sources_total += office.platforms.length;
    summary.sources_active += active.length;
    summary.sources_attention += active.filter((platform) => NEEDS_ATTENTION.has(platform.operational?.code)).length;
  }
  return summary;
}

export async function settingsOverview(env) {
  const offices = await settingsOffices(env);
  const ai = await slotOverview(env);
  return {
    offices,
    summary: summarize(offices),
    ai: {
      configured: ai.configured,
      slots: ai.slots.map((slot) => publicSlotStatus(slot, { includeHasKey: true })),
    },
    system: {
      weekly_cron: "الأحد 06:00 بتوقيت الرياض",
      drain_cron: "كل 10 دقائق",
      queue: Boolean(env.SCAN_QUEUE),
      window_days: ITEM_WINDOW_DAYS,
      retention_days: ITEM_RETENTION_DAYS,
    },
    audit: await recentAudit(env),
  };
}

function wantedSites(body) {
  return (Array.isArray(body.sites) ? body.sites : [])
    .map((entry) => (typeof entry === "string" ? { url: entry } : entry))
    .filter((entry) => entry?.url);
}

async function createMayor(request, env) {
  const body = await readBody(request);
  if (body.domain || body.url || body.discovery || body.sources) {
    return json(
      {
        error: "use_sites",
        message: "أضف المواقع عبر الحقل المخصص لها (sites) ليجري فحصها واعتمادها تلقائيًا.",
      },
      400,
    );
  }
  const parsed = parseMayorInput(body);
  if (parsed.error) {
    return json(
      { error: parsed.error, detail: parsed.detail || null, message: mayorInputMessage(parsed) },
      400,
    );
  }
  const sites = wantedSites(body);
  if (sites.length > MAX_SOURCES_PER_OFFICE) {
    return json(
      { error: "too_many_sites", message: `الحد الأقصى ${MAX_SOURCES_PER_OFFICE} مواقع لكل مكتب.` },
      400,
    );
  }
  const existing = await env.DB.prepare(`SELECT id FROM mayors WHERE id = ?`).bind(parsed.mayor.id).first();
  if (existing) return json({ error: "duplicate_id", message: "معرّف العمدة مستخدم مسبقاً" }, 409);

  const actor = reviewerOf(request, env);
  const mayor = await insertCustomMayor(env, parsed.mayor);
  await env.DB.prepare(
    `INSERT INTO settings_audit (id, actor, action, source_id, mayor_id, before_json, after_json)
     VALUES (?, ?, 'mayor_created', NULL, ?, NULL, ?)`,
  )
    .bind(crypto.randomUUID(), actor, mayor.id, JSON.stringify(mayor))
    .run();
  const results = [];
  for (const entry of sites) {
    const added = await addSite(env, {
      mayorId: mayor.id,
      input: entry.url,
      platform: entry.platform || "newspaper",
      actor,
    });
    results.push({ input: entry.url, ...added });
  }
  return json(
    {
      ok: true,
      mayor,
      sites: results,
      note: results.length
        ? "أُضيف العمدة وفُحصت مواقعه؛ الرصد يعمل عليها تلقائيًا."
        : "أُضيفت هوية العمدة. أضف موقعًا أو أكثر ليبدأ الرصد.",
      offices: await settingsOffices(env),
    },
    201,
  );
}

/** يعيد Response إن كان المسار من الإعدادات، وإلا null ليكمل الموجّه الرئيسي. */
export async function handleSettingsApi(request, env, path, method) {
  const actor = () => reviewerOf(request, env);

  if (path === "/api/settings/overview" && method === "GET") {
    return json(await settingsOverview(env));
  }
  if (path === "/api/settings/offices" && method === "GET") {
    return json({ offices: await settingsOffices(env) });
  }
  if (path === "/api/settings/tools" && method === "GET") {
    return json(await toolsOverview(env));
  }
  // المعرّف قد يحوي «:» فيصل مشفّرًا (ai%3Agemini)؛ لا نقيّده بمحارف خام.
  const toolTest = path.match(/^\/api\/settings\/tools\/([^/]+)\/test$/i);
  if (toolTest && method === "POST") {
    const result = await testTool(env, decodeURIComponent(toolTest[1]).toLowerCase());
    return json(result, result.unknown ? 404 : 200);
  }
  if (path === "/api/settings/audit" && method === "GET") {
    const limit = new URL(request.url).searchParams.get("limit");
    return json({ audit: await recentAudit(env, limit) });
  }
  if (path === "/api/settings/mayors" && method === "POST") {
    return createMayor(request, env);
  }

  const mayorMatch = path.match(/^\/api\/settings\/mayors\/([a-z][a-z0-9-]*)$/i);
  if (mayorMatch && method === "PATCH") {
    const result = await updateCustomMayor(env, {
      mayorId: mayorMatch[1].toLowerCase(),
      body: await readBody(request),
      actor: actor(),
    });
    return json(result, result.ok ? 200 : result.status || 400);
  }
  if (mayorMatch && method === "DELETE") {
    const result = await deleteCustomMayor(env, { mayorId: mayorMatch[1].toLowerCase(), actor: actor() });
    return json(result, result.ok ? 200 : result.status || 400);
  }

  const siteMatch = path.match(/^\/api\/settings\/mayors\/([a-z][a-z0-9-]*)\/sites$/i);
  if (siteMatch && method === "POST") {
    const body = await readBody(request);
    const result = await addSite(env, {
      mayorId: siteMatch[1].toLowerCase(),
      input: body.url,
      platform: body.platform || "newspaper",
      actor: actor(),
    });
    return json(result, result.ok ? 201 : result.status || 400);
  }

  const checkMatch = path.match(/^\/api\/settings\/sources\/([^/]+)\/check$/i);
  if (checkMatch && method === "POST") {
    const result = await checkSite(env, { sourceId: decodeURIComponent(checkMatch[1]) });
    return json(result, result.ok ? 200 : result.status || 400);
  }

  const sourceMatch = path.match(/^\/api\/settings\/sources\/([^/]+)$/i);
  if (sourceMatch && method === "DELETE") {
    const result = await removeSite(env, { sourceId: decodeURIComponent(sourceMatch[1]), actor: actor() });
    return json(result, result.ok ? 200 : result.status || 400);
  }
  if (sourceMatch && method === "POST") {
    const body = await readBody(request);
    if (typeof body.enabled !== "boolean") return json({ error: "enabled_required" }, 400);
    if (body.domain || body.url) {
      return json({ error: "use_sites", detail: "المواقع تُضاف من نموذج إضافة موقع." }, 400);
    }
    const result = await setSourceEnabled(env, decodeURIComponent(sourceMatch[1]), body.enabled, actor());
    return json(result, result.error ? result.status || 400 : 200);
  }
  return null;
}
