import { applyDeskLaneMigration } from "../deskLanes.js";
import { MAYORS } from "../mayors.js";
import { PUBLISHERS } from "../publishers.js";
import { migrateVersions } from "../versions.js";
import {
  migrateAiProviderBudget,
  migrateItems,
  migrateSearchJobs,
  seedSources,
  upsertRows,
} from "./migrations.js";
import { refreshCustomSources } from "./customSources.js";
import { REQUIRED_TABLES, SCHEMA_STATEMENTS } from "./schema.js";

const bootstrapped = new WeakSet();

const BOOTSTRAP_VERSION = "bootstrap-v20";

/**
 * الاعتماد على ختم النسخة وحده يفترض أن كل تغيير في المخطط رفع الختم. حين
 * يُنسى ذلك تعمل القاعدة الفارغة وتنكسر القاعدة القائمة. فحص وجود الجداول
 * يجعل التهيئة تشفي نفسها بدل أن تثق بافتراض.
 */
async function schemaComplete(env) {
  const placeholders = REQUIRED_TABLES.map(() => "?").join(", ");
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM sqlite_master
     WHERE type = 'table' AND name IN (${placeholders})`,
  )
    .bind(...REQUIRED_TABLES)
    .first();
  return Number(row?.n) === REQUIRED_TABLES.length;
}

/**
 * يُنشئ الفهارس الساخنة على قاعدة مُهيّأة سابقًا دون إعادة التهيئة الكاملة، حتى
 * تستفيد قواعد الإنتاج القائمة من الفهرس فورًا بلا ترحيل مدمّر أو إعادة زرع.
 * `CREATE INDEX IF NOT EXISTS` عملية ذرية رخيصة تُنفَّذ مرة واحدة فعليًا.
 */
async function ensureHotIndexes(env) {
  const info = await env.DB.prepare(`PRAGMA table_info(items)`).all();
  const names = new Set((info.results || []).map((column) => column.name));
  // على جدول قديم بلا العمود، تتكفّل تهيئة الترحيل بإضافة العمود ثم الفهرس.
  if (!names.has("brief_claim_id")) return;
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_items_claim ON items(brief_claim_id)`,
  ).run();
}

export async function ensureDb(env) {
  if (bootstrapped.has(env.DB)) {
    await refreshCustomSources(env);
    return;
  }
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`).run();
  await ensureHotIndexes(env);
  const stamp = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'bootstrap_version'`).first();
  if (stamp?.v === BOOTSTRAP_VERSION && (await schemaComplete(env))) {
    bootstrapped.add(env.DB);
    await refreshCustomSources(env, { force: true });
    return;
  }
  for (const sql of SCHEMA_STATEMENTS) {
    await env.DB.prepare(sql).run();
  }
  await migrateSearchJobs(env);
  await upsertRows(
    env,
    `INSERT OR REPLACE INTO mayors (
      id, country_ar, city_ar, city_en, title_ar, title_en, name_en, name_native, name_ar,
      native_lang, native_lang_ar, country_code, gn_hl, gn_gl, official_host
    )`,
    MAYORS.map((m) => [
      m.id,
      m.country_ar,
      m.city_ar,
      m.city_en,
      m.title_ar,
      m.title_en,
      m.name_en,
      m.name_native,
      m.name_ar,
      m.native_lang,
      m.native_lang_ar,
      m.country_code,
      m.gn_hl,
      m.gn_gl,
      m.official_host,
    ]),
    15,
    6,
  );
  await upsertRows(
    env,
    `INSERT OR REPLACE INTO publishers (id, domain, name, tier, country_code, mayor_id)`,
    PUBLISHERS.map((p) => [
      p.id,
      p.domain,
      p.name,
      p.tier,
      p.country_code,
      p.mayor_id,
    ]),
    6,
    15,
  );
  await seedSources(env);
  await migrateItems(env);
  await migrateAiProviderBudget(env);
  await migrateVersions(env);
  await applyDeskLaneMigration(env, { dryRun: false });
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('bootstrap_version', ?)`)
    .bind(BOOTSTRAP_VERSION)
    .run();
  bootstrapped.add(env.DB);
  await refreshCustomSources(env, { force: true });
}
