import { arabicRatio, decodeEntities, splitHeadline } from "./text.js";
import { writeOfficialBrief } from "./brief.js";
import {
  aiBriefEnabled,
  aiBriefEngine,
  summarizeWithGemini,
} from "./aiBrief.js";

export { arabicRatio, decodeEntities, splitHeadline };

export async function translatePending(env, limit = 24, mayorId = null) {
  const aiReady = aiBriefEnabled(env);
  const targetEngine = aiBriefEngine(env);
  const clauses = ["items.status = 'inbox'"];
  const binds = [];
  if (aiReady) {
    clauses.push("(items.trans_engine IS NULL OR items.trans_engine <> ?)");
    binds.push(targetEngine);
  } else {
    clauses.push(
      "(items.trans_engine IS NULL OR items.trans_engine NOT IN ('brief-radar', 'brief-llm') AND items.trans_engine NOT LIKE 'brief-ai-%')",
    );
  }
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
     ORDER BY COALESCE(items.published_at, items.created_at) DESC
     LIMIT ?`,
  )
    .bind(...binds)
    .all();
  const rows = results || [];
  let completed = 0;
  for (const row of rows) {
    if (aiReady) {
      try {
        const brief = await summarizeWithGemini(env, row, row);
        await env.DB.prepare(
          `UPDATE items
           SET title_ar = ?, snippet_ar = ?, trans_engine = ?,
               brief_evidence = ?, brief_error = NULL
           WHERE id = ?`,
        )
          .bind(brief.title_ar, brief.snippet_ar, brief.engine, brief.evidence, row.id)
          .run();
        completed += 1;
        continue;
      } catch (error) {
        const message = String(error?.message || error).slice(0, 240);
        if (row.title_ar) {
          await env.DB.prepare(`UPDATE items SET brief_error = ? WHERE id = ?`)
            .bind(message, row.id)
            .run();
          continue;
        }
        const fallback = writeOfficialBrief(row, row.title, row.snippet || "", row.article_text || "");
        await env.DB.prepare(
          `UPDATE items
           SET title_ar = ?, snippet_ar = ?, trans_engine = ?, brief_error = ?
           WHERE id = ?`,
        )
          .bind(fallback.title_ar, fallback.snippet_ar, fallback.engine, message, row.id)
          .run();
        continue;
      }
    }

    const brief = writeOfficialBrief(row, row.title, row.snippet || "", row.article_text || "");
    await env.DB.prepare(
      `UPDATE items
       SET title_ar = ?, snippet_ar = ?, trans_engine = ?, brief_error = NULL
       WHERE id = ?`,
    )
      .bind(brief.title_ar, brief.snippet_ar, brief.engine, row.id)
      .run();
    completed += 1;
  }
  return completed;
}
