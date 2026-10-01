/**
 * تعديل العمداء المضافين من الإعدادات وحذفهم. عمداء السجل الأساسي ثابتون.
 * الحذف يُرفض إن وُجد قرار محفوظ، فالقرارات أرشيف لا يُمحى بحذف مكتب.
 */
import { SEED_MAYOR_IDS, mayorFromRow, mayorInputMessage, parseMayorInput } from "./mayors.js";
import { refreshCustomSources } from "./db/customSources.js";

const EDITABLE = [
  "name_ar",
  "name_en",
  "name_native",
  "city_ar",
  "city_en",
  "country_ar",
  "country_code",
  "title_ar",
  "title_en",
  "native_lang",
  "native_lang_ar",
  "official_host",
];

function fail(error, message, status = 400) {
  return { ok: false, error, message, status };
}

async function audit(env, { actor, action, mayorId, before = null, after = null }) {
  await env.DB.prepare(
    `INSERT INTO settings_audit (id, actor, action, source_id, mayor_id, before_json, after_json)
     VALUES (?, ?, ?, NULL, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      actor || "unknown",
      action,
      mayorId,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
    )
    .run();
}

async function customRow(env, mayorId) {
  if (SEED_MAYOR_IDS.has(mayorId)) return { error: fail("seed_mayor", "عمداء السجل الأساسي لا يُعدَّلون ولا يُحذفون.", 403) };
  const row = await env.DB.prepare(`SELECT * FROM mayors WHERE id = ?`).bind(mayorId).first();
  if (!row) return { error: fail("mayor_not_found", "المكتب غير موجود.", 404) };
  return { row };
}

export async function updateCustomMayor(env, { mayorId, body = {}, actor } = {}) {
  const { row, error } = await customRow(env, mayorId);
  if (error) return error;
  const merged = { ...row };
  for (const key of EDITABLE) {
    if (body[key] !== undefined) merged[key] = body[key];
  }
  const parsed = parseMayorInput({ ...merged, id: row.id });
  if (parsed.error) return fail(parsed.error, mayorInputMessage(parsed));
  const next = parsed.mayor;
  await env.DB.prepare(
    `UPDATE mayors SET
       country_ar = ?, city_ar = ?, city_en = ?, title_ar = ?, title_en = ?,
       name_en = ?, name_native = ?, name_ar = ?, native_lang = ?, native_lang_ar = ?,
       country_code = ?, gn_hl = ?, gn_gl = ?, official_host = ?
     WHERE id = ?`,
  )
    .bind(
      next.country_ar,
      next.city_ar,
      next.city_en,
      next.title_ar,
      next.title_en,
      next.name_en,
      next.name_native,
      next.name_ar,
      next.native_lang,
      next.native_lang_ar,
      next.country_code,
      next.gn_hl,
      next.gn_gl,
      next.official_host || "",
      row.id,
    )
    .run();
  await audit(env, { actor, action: "mayor_updated", mayorId: row.id, before: mayorFromRow(row), after: next });
  return { ok: true, mayor: { ...next, origin: "custom" } };
}

export async function deleteCustomMayor(env, { mayorId, actor } = {}) {
  const { row, error } = await customRow(env, mayorId);
  if (error) return error;
  const decided = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM items
     WHERE mayor_id = ?
       AND (status = 'approved' OR EXISTS (SELECT 1 FROM approvals WHERE approvals.item_id = items.id))`,
  )
    .bind(row.id)
    .first();
  if (Number(decided?.n) > 0) {
    return fail(
      "has_decisions",
      "لهذا المكتب أخبار معتمدة أو قرارات محفوظة، فلا يُحذف. أوقف مواقعه بدل ذلك.",
      409,
    );
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sources WHERE mayor_id = ? AND origin = 'custom'`).bind(row.id),
    env.DB.prepare(`DELETE FROM mayors WHERE id = ?`).bind(row.id),
  ]);
  await refreshCustomSources(env, { force: true });
  await audit(env, { actor, action: "mayor_deleted", mayorId: row.id, before: mayorFromRow(row) });
  return { ok: true, id: row.id };
}
