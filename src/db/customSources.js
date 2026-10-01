/**
 * مصادر الإعدادات: تُحفظ في جدول sources بـ origin='custom' وتُحمَّل إلى ذاكرة
 * العامل. التحميل مؤقت بمدة قصيرة حتى لا يقرأ كل طلب الجدول، ويُبطَل فورًا في
 * العامل الذي أجرى الإضافة. أما بقية العمال فتلحق خلال المدة المحددة.
 */
import { setCustomSources } from "../sources.js";

export const CUSTOM_SOURCES_TTL_MS = 60_000;

let loadedFor = null;
let loadedAt = 0;

export async function refreshCustomSources(env, { force = false } = {}) {
  if (!env?.DB) return;
  const fresh = loadedFor === env.DB && Date.now() - loadedAt < CUSTOM_SOURCES_TTL_MS;
  if (fresh && !force) return;
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, mayor_id, domain, name, tier, platform, rank, url, discovery_json, curated_at
       FROM sources WHERE origin = 'custom'`,
    ).all();
    setCustomSources(results || []);
    loadedFor = env.DB;
    loadedAt = Date.now();
  } catch (error) {
    // قاعدة لم تكتمل ترحيلها: نُبقي ما حُمّل سابقًا بدل كسر كل الطلبات.
    console.warn("custom_sources_refresh_failed", String(error?.message || error));
  }
}

