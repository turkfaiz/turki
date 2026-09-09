import { arabicRatio, decodeEntities, splitHeadline } from "./text.js";
import { writeOfficialBrief } from "./brief.js";

export { arabicRatio, decodeEntities, splitHeadline };

export async function translatePending(env, limit = 24) {
  const { results } = await env.DB.prepare(
    `SELECT items.id, items.title, items.snippet,
            mayors.name_ar, mayors.name_en, mayors.name_native,
            mayors.title_ar, mayors.city_ar, mayors.city_en
     FROM items
     JOIN mayors ON mayors.id = items.mayor_id
     WHERE items.trans_engine IS NULL OR items.trans_engine NOT IN ('brief-radar', 'brief-llm')
     ORDER BY COALESCE(items.published_at, items.created_at) DESC
     LIMIT ?`,
  )
    .bind(limit)
    .all();
  const rows = results || [];
  for (const row of rows) {
    const brief = writeOfficialBrief(row, row.title, row.snippet || "");
    await env.DB.prepare(
      `UPDATE items SET title_ar = ?, snippet_ar = ?, trans_engine = ? WHERE id = ?`,
    )
      .bind(brief.title_ar, brief.snippet_ar, brief.engine, row.id)
      .run();
  }
  return rows.length;
}
