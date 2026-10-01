/**
 * إضافة موقع لمكتب أو حذفه من الإعدادات.
 *
 * الإضافة = فحص + تفعيل: يُكتشف أسلوب القراءة تلقائيًا، ثم يُسجَّل المصدر ويُجرَّب
 * بنفس محرك الرصد الفعلي. فإن لم يعمل يُلغى التسجيل ولا يبقى أثر. السقف ثلاثة
 * مواقع مفعّلة لكل مكتب حتى لا تكثر الأخبار بلا فائدة.
 */
import { refreshCustomSources } from "./db/customSources.js";
import { recordSourceHealth } from "./db/items.js";
import { discoverSource } from "./discovery.js";
import { isAboutMayor, resolveMayor } from "./mayors.js";
import { enabledSources } from "./pipeline.js";
import { MAX_SOURCES_PER_OFFICE, sourceById, sourcesFor } from "./sources.js";
import { detectStrategies, normalizeSiteInput } from "./sourceProbe.js";

const PLATFORMS = { official: 0, newspaper: 1, agency: 1 };

function fail(error, message, status = 400, extra = {}) {
  return { ok: false, error, message, status, ...extra };
}

async function audit(env, { actor, action, sourceId, mayorId, before = null, after = null }) {
  await env.DB.prepare(
    `INSERT INTO settings_audit (id, actor, action, source_id, mayor_id, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      actor || "unknown",
      action,
      sourceId,
      mayorId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
    )
    .run();
}

export async function addSite(env, { mayorId, input, platform = "newspaper", actor, fetch } = {}) {
  const mayor = await resolveMayor(env, mayorId);
  if (!mayor) return fail("mayor_not_found", "المكتب غير موجود.", 404);
  if (!(platform in PLATFORMS)) return fail("bad_platform", "نوع الموقع: رسمي أو صحيفة أو وكالة.");

  const site = normalizeSiteInput(input);
  if (!site.ok) return fail(site.error, site.message);

  const id = `${mayor.id}:${site.domain}`;
  if (sourceById(id) || sourcesFor(mayor.id).some((source) => source.domain === site.domain)) {
    return fail("duplicate_domain", "هذا الموقع مضاف لهذا المكتب مسبقًا.", 409);
  }
  const active = await enabledSources(env, mayor.id);
  if (active.length >= MAX_SOURCES_PER_OFFICE) {
    return fail(
      "office_full",
      `لهذا المكتب ${MAX_SOURCES_PER_OFFICE} مواقع مفعّلة. أوقف موقعًا أو احذفه ثم أضف الجديد.`,
      409,
    );
  }

  const detected = await detectStrategies(site, mayor, { fetch });
  if (!detected.ok) return fail(detected.error, detected.message, 422, { notes: detected.notes });

  const rankRow = await env.DB.prepare(`SELECT IFNULL(MAX(rank), 0) + 1 AS next FROM sources WHERE mayor_id = ?`)
    .bind(mayor.id)
    .first();
  const tier = PLATFORMS[platform];
  const primary = detected.steps.find((step) => !step.supplement);
  await env.DB.prepare(
    `INSERT INTO sources (
       id, mayor_id, domain, name, tier, kind, url, rank, verified, curated_at,
       enabled, origin, discovery_json, platform, added_by
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, date('now'), 1, 'custom', ?, ?, ?)`,
  )
    .bind(
      id,
      mayor.id,
      site.domain,
      detected.name,
      tier,
      primary.type === "rss" ? "feed" : primary.type === "api" ? "api" : "page",
      primary.url,
      Number(rankRow?.next) || 1,
      JSON.stringify(detected.steps),
      platform,
      actor || "unknown",
    )
    .run();
  await refreshCustomSources(env, { force: true });

  // تجربة فعلية بنفس محرك الرصد: بوابة النطاق، والتحويلات، وشرط التاريخ.
  const source = sourceById(id);
  let trial;
  try {
    trial = await discoverSource(source, mayor, { fetch });
  } catch (error) {
    trial = { rows: [], health: { ok: false, status: String(error.message || error).slice(0, 80) } };
  }
  if (!trial.health.ok) {
    await env.DB.prepare(`DELETE FROM sources WHERE id = ?`).bind(id).run();
    await refreshCustomSources(env, { force: true });
    return fail(
      "trial_failed",
      `وُجدت طريقة قراءة لكن التجربة الفعلية لم تنجح (${trial.health.fail_reason || trial.health.status}). لم يُضف الموقع.`,
      422,
      { notes: detected.notes },
    );
  }

  const about = trial.rows.filter((row) => isAboutMayor(`${row.title || ""} ${row.snippet || ""}`, mayor));
  await audit(env, {
    actor,
    action: "source_added",
    sourceId: id,
    mayorId: mayor.id,
    after: { domain: site.domain, platform, steps: detected.steps.map((step) => step.type) },
  });
  return {
    ok: true,
    id,
    domain: site.domain,
    name: detected.name,
    platform,
    steps: detected.steps.map((step) => ({ type: step.type, supplement: Boolean(step.supplement) })),
    notes: detected.notes,
    trial: {
      recent_links: trial.rows.length,
      about_mayor: about.length,
      supplement_found: trial.health.supplement_found || 0,
      samples: about.slice(0, 3).map((row) => ({ title: String(row.title || "").slice(0, 120), url: row.url })),
    },
  };
}

export async function removeSite(env, { sourceId, actor } = {}) {
  const row = await env.DB.prepare(`SELECT id, mayor_id, domain, origin FROM sources WHERE id = ?`)
    .bind(sourceId)
    .first();
  if (!row) return fail("unknown_source", "المصدر غير موجود.", 404);
  if (row.origin !== "custom") {
    return fail("registry_source", "مصادر السجل الأساسي لا تُحذف؛ أوقفها فقط.", 403);
  }
  await env.DB.prepare(`DELETE FROM sources WHERE id = ? AND origin = 'custom'`).bind(sourceId).run();
  await refreshCustomSources(env, { force: true });
  await audit(env, {
    actor,
    action: "source_removed",
    sourceId,
    mayorId: row.mayor_id,
    before: { domain: row.domain },
  });
  return { ok: true, id: sourceId };
}

/**
 * فحص فوري لمصدر واحد (من السجل أو مضاف) بمحرك الرصد نفسه، وتسجيل حالته.
 * لا يحفظ أخبارًا؛ غرضه أن يرى الموظف هل يعمل المصدر الآن وماذا يلتقط.
 */
export async function checkSite(env, { sourceId, fetch } = {}) {
  const source = sourceById(sourceId);
  if (!source) return fail("unknown_source", "المصدر غير موجود.", 404);
  const mayor = await resolveMayor(env, source.mayor_id);
  if (!mayor) return fail("mayor_not_found", "المكتب غير موجود.", 404);
  let trial;
  try {
    trial = await discoverSource(source, mayor, { fetch });
  } catch (error) {
    trial = { rows: [], health: { id: source.id, ok: false, status: String(error.message || error).slice(0, 80) } };
  }
  await recordSourceHealth(env, [{ ...trial.health, id: source.id, mayor_id: mayor.id }]);
  const about = trial.rows.filter((row) => isAboutMayor(`${row.title || ""} ${row.snippet || ""}`, mayor));
  return {
    ok: true,
    id: source.id,
    works: Boolean(trial.health.ok),
    status: trial.health.status,
    fail_reason: trial.health.fail_reason || "",
    strategy: trial.health.last_strategy || "",
    recent_links: trial.rows.length,
    about_mayor: about.length,
    supplement_found: trial.health.supplement_found || 0,
    samples: about.slice(0, 3).map((row) => ({ title: String(row.title || "").slice(0, 120), url: row.url })),
  };
}
