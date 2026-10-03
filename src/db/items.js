import { protectedItemsSql } from "../versions.js";
import { ITEM_RETENTION_DAYS } from "../config.js";

/** يسجّل ما حدث فعلًا لكل مصدر حتى تكون الحوكمة مبنية على واقع الإنتاج. */
/**
 * المكتب أسبوعي، فلا معنى لتخزين ما خرج من النافذة. التقليم يمنع تراكم أخبار
 * قديمة تظهر في القوائم وتشوّه الإحصاءات.
 */
export async function pruneOldItems(env, days = ITEM_RETENTION_DAYS) {
  /**
   * نافذة الرصد للعرض، أما القرارات فأرشيف. أي خبر يحمل قرارًا محفوظًا يبقى
   * هو وأدلته ونسخه، وإلا صار الأرشيف رهينة نافذة سبعة أيام.
   */
  const result = await env.DB.prepare(
    `DELETE FROM items
     WHERE COALESCE(published_at, created_at) < datetime('now', ?)
       AND NOT ${protectedItemsSql()}
       AND status <> 'approved'`,
  )
    .bind(`-${days} days`)
    .run();
  return Number(result?.meta?.changes) || 0;
}

/** الأخبار التي يمسحها «بدء من جديد»: كل ما لا يحمل قرارًا محفوظًا ولا اعتمادًا. */
const UNDECIDED_SQL = `NOT ${protectedItemsSql()} AND status <> 'approved'`;

export const CLEAR_CONFIRMATION = "احذف كل الأخبار";

/** ما سيُمسح وما سيبقى، لتعرضه الواجهة قبل التأكيد. */
export async function clearPreview(env) {
  const row = await env.DB.prepare(
    `SELECT SUM(CASE WHEN ${UNDECIDED_SQL} THEN 1 ELSE 0 END) AS removable,
            SUM(CASE WHEN NOT (${UNDECIDED_SQL}) THEN 1 ELSE 0 END) AS kept
     FROM items`,
  ).first();
  const candidates = await env.DB.prepare(`SELECT COUNT(*) AS n FROM candidates`).first();
  return {
    removable_items: Number(row?.removable) || 0,
    kept_items: Number(row?.kept) || 0,
    candidates: Number(candidates?.n) || 0,
  };
}

/**
 * يبدأ رصدًا جديدًا من الصفر: يمسح الأخبار غير المقررة وما يتصل بها، ويُبقي كل ما
 * يحمل قرارًا. لا يمس المكاتب ولا المواقع ولا الإعدادات ولا حصص الذكاء.
 *
 * المرشحون يُمسحون أيضًا: رابط معروف سابقًا يُتجاهل عند الاكتشاف، فبقاؤهم يجعل
 * الرصد الجديد لا يجد شيئًا. ونسخ الموجزات تُعلَّم متقادمة لا تُحذف، فلا يُدقَّق
 * موجز خبر محذوف ولا تُهدر عليه نداءات.
 */
export async function clearUndecided(env) {
  const before = await clearPreview(env);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE brief_versions SET superseded_at = COALESCE(superseded_at, datetime('now'))
       WHERE item_id IN (SELECT id FROM items WHERE ${UNDECIDED_SQL})`,
    ),
    env.DB.prepare(`DELETE FROM items WHERE ${UNDECIDED_SQL}`),
    env.DB.prepare(`DELETE FROM candidates`),
    env.DB.prepare(`DELETE FROM scan_sources`),
    env.DB.prepare(`DELETE FROM search_job_tasks`),
    env.DB.prepare(`DELETE FROM search_jobs`),
    env.DB.prepare(`DELETE FROM scans`),
  ]);
  return { removed_items: before.removable_items, removed_candidates: before.candidates, kept_items: before.kept_items };
}

export async function recordSourceHealth(env, rows) {
  if (!rows?.length) return;
  const stmt = env.DB.prepare(
    `UPDATE sources
     SET last_checked_at = datetime('now'),
         last_ok_at = CASE WHEN ? THEN datetime('now') ELSE last_ok_at END,
         last_success_at = CASE WHEN ? THEN datetime('now') ELSE last_success_at END,
         last_discovery_at = CASE WHEN ? > 0 THEN datetime('now') ELSE last_discovery_at END,
         last_fresh_at = CASE WHEN ? > 0 THEN datetime('now') ELSE last_fresh_at END,
         last_status = ?, last_items = ?,
         connect_status = ?, http_status = ?, parse_status = ?,
         discovered_count = ?, new_count = ?,
         fail_reason = ?, last_strategy = ?, last_discovered_url = ?,
         etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified),
         consecutive_failures = CASE WHEN ? THEN 0 ELSE IFNULL(consecutive_failures, 0) + 1 END
     WHERE id = ?`,
  );
  for (let i = 0; i < rows.length; i += 20) {
    await env.DB.batch(
      rows.slice(i, i + 20).map((row) => {
        const ok = Boolean(row.ok);
        const discovered = Number(row.discovered ?? row.items) || 0;
        const fresh = Number(row.new_count) || 0;
        return stmt.bind(
          ok ? 1 : 0,
          ok ? 1 : 0,
          discovered,
          fresh,
          String(row.status || "").slice(0, 160),
          Number(row.items) || 0,
          String(row.connect_status || row.status || "").slice(0, 80),
          row.http_status ?? null,
          String(row.parse_status || "").slice(0, 80),
          discovered,
          fresh,
          String(row.fail_reason || "").slice(0, 160),
          String(row.last_strategy || "").slice(0, 40),
          String(row.last_discovered_url || "").slice(0, 500),
          row.etag || null,
          row.last_modified || null,
          ok ? 1 : 0,
          row.id,
        );
      }),
    );
  }
}
