import { arabicRatio, decodeEntities, splitHeadline } from "./text.js";
import {
  aiBriefEnabled,
  aiBriefEngine,
  pendingAiBrief,
  summarizeWithGemini,
} from "./aiBrief.js";

export { arabicRatio, decodeEntities, splitHeadline };

async function mapLimit(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length || 1) }, () => worker()),
  );
  return results;
}

export async function translatePending(env, limit = 100, mayorId = null) {
  const aiReady = aiBriefEnabled(env);
  if (!aiReady) return 0;
  const targetEngine = aiBriefEngine(env);
  const clauses = [
    "items.status IN ('inbox', 'approved')",
    "(items.brief_error IS NULL OR items.brief_attempted_at IS NULL OR items.brief_attempted_at <= datetime('now', '-30 minutes'))",
  ];
  const binds = [];
  clauses.push("(items.trans_engine IS NULL OR items.trans_engine <> ?)");
  binds.push(targetEngine);
  if (mayorId) {
    clauses.push("items.mayor_id = ?");
    binds.push(mayorId);
  }
  binds.push(limit);

  const { results } = await env.DB.prepare(
    `SELECT items.id, items.title, items.snippet, items.article_text, items.url,
            items.published_at, items.publisher_domain, items.title_ar, items.snippet_ar,
            mayors.name_ar, mayors.name_en, mayors.name_native,
            mayors.title_ar, mayors.city_ar, mayors.city_en
     FROM items
     JOIN mayors ON mayors.id = items.mayor_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY CASE WHEN items.brief_error IS NULL THEN 0 ELSE 1 END,
              COALESCE(items.published_at, items.created_at) DESC
     LIMIT ?`,
  )
    .bind(...binds)
    .all();
  const rows = results || [];
  const completed = await mapLimit(rows, 3, async (row) => {
    try {
      const brief = await summarizeWithGemini(env, row, row);
      await env.DB.prepare(
        `UPDATE items
         SET title_ar = ?, snippet_ar = ?, trans_engine = ?,
             brief_evidence = ?, brief_error = NULL,
             brief_attempted_at = datetime('now'),
             brief_attempts = IFNULL(brief_attempts, 0) + 1
         WHERE id = ?`,
      )
        .bind(brief.title_ar, brief.snippet_ar, brief.engine, brief.evidence, row.id)
        .run();
      return true;
    } catch (error) {
      const message = String(error?.message || error).slice(0, 240);
      const failed = pendingAiBrief(row, true);
      await env.DB.prepare(
        `UPDATE items
         SET title_ar = ?, snippet_ar = ?, trans_engine = ?,
             brief_evidence = NULL, brief_error = ?,
             brief_attempted_at = datetime('now'),
             brief_attempts = IFNULL(brief_attempts, 0) + 1
         WHERE id = ?`,
      )
        .bind(failed.title_ar, failed.snippet_ar, failed.engine, message, row.id)
        .run();
      return false;
    }
  });
  return completed.filter(Boolean).length;
}
