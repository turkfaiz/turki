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
