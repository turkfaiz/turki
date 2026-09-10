import { arabicRatio, decodeEntities, splitHeadline } from "./text.js";
import {
  aiBriefEnabled,
  aiBriefEngine,
  pendingAiBrief,
  summarizeWithGemini,
} from "./aiBrief.js";

export { arabicRatio, decodeEntities, splitHeadline };

export const MAX_BRIEF_ATTEMPTS = 5;
const CLAIM_TIMEOUT_MINUTES = 10;
const RETRY_BACKOFF_MINUTES = 15;

/** الصفوف التي تنتظر تلخيصًا موثوقًا: الوارد والمعتمد والمستبعد الموثوق المقروء. */
export function briefScopeSql(alias = "items") {
  return `(${alias}.status IN ('inbox', 'approved')
      OR (
        ${alias}.status = 'excluded'
        AND ${alias}.publisher_tier IN (0, 1)
        AND LENGTH(IFNULL(${alias}.article_text, '')) > 80
      ))`;
}

export function pendingBriefFilter(alias = "items") {
  return `${briefScopeSql(alias)}
    AND (${alias}.trans_engine IS NULL OR ${alias}.trans_engine <> ?)
    AND IFNULL(${alias}.brief_attempts, 0) < ${MAX_BRIEF_ATTEMPTS}`;
}

export async function pendingBriefCount(env, mayorId = null) {
  if (!aiBriefEnabled(env)) return 0;
  const binds = [aiBriefEngine(env)];
  let sql = `SELECT COUNT(*) AS pending FROM items WHERE ${pendingBriefFilter()}`;
  if (mayorId) {
    sql += " AND items.mayor_id = ?";
    binds.push(mayorId);
  }
  const row = await env.DB.prepare(sql).bind(...binds).first();
  return Number(row?.pending) || 0;
}

/**
 * Claims rows before calling Gemini so overlapping manual, review, and weekly
 * runs cannot bill the same article twice.
 */
async function claimBriefRows(env, limit, mayorId, targetEngine) {
  const claimId = crypto.randomUUID();
  const binds = [claimId, targetEngine];
  let where = `${pendingBriefFilter()}
    AND (items.brief_claimed_at IS NULL
      OR items.brief_claimed_at <= datetime('now', '-${CLAIM_TIMEOUT_MINUTES} minutes'))
    AND (items.brief_error IS NULL
      OR items.brief_attempted_at IS NULL
      OR items.brief_attempted_at <= datetime('now', '-${RETRY_BACKOFF_MINUTES} minutes'))`;
  if (mayorId) {
    where += " AND items.mayor_id = ?";
    binds.push(mayorId);
  }
  binds.push(limit);

  await env.DB.prepare(
    `UPDATE items
     SET brief_claim_id = ?, brief_claimed_at = datetime('now')
     WHERE id IN (
       SELECT items.id FROM items
       WHERE ${where}
       ORDER BY CASE WHEN items.brief_error IS NULL THEN 0 ELSE 1 END,
                IFNULL(items.brief_attempts, 0) ASC,
                COALESCE(items.published_at, items.created_at) DESC
       LIMIT ?
     )`,
  )
    .bind(...binds)
    .run();

  const { results } = await env.DB.prepare(
    `SELECT items.id, items.title, items.snippet, items.article_text, items.url,
            items.published_at, items.publisher_domain,
            mayors.name_ar, mayors.name_en, mayors.name_native,
            mayors.title_ar, mayors.city_ar, mayors.city_en
     FROM items
     JOIN mayors ON mayors.id = items.mayor_id
     WHERE items.brief_claim_id = ?`,
  )
    .bind(claimId)
    .all();
  return results || [];
}

export async function translatePending(env, limit = 3, mayorId = null) {
  if (!aiBriefEnabled(env)) {
    return { summarized: 0, failed: 0, pending: 0, retryAfterSeconds: 0 };
  }
  const targetEngine = aiBriefEngine(env);
  const rows = await claimBriefRows(env, limit, mayorId, targetEngine);

  let summarized = 0;
  let failed = 0;
  let retryAfterSeconds = 0;
  for (const row of rows) {
    try {
      const brief = await summarizeWithGemini(env, row, row);
      await env.DB.prepare(
        `UPDATE items
         SET title_ar = ?, snippet_ar = ?, trans_engine = ?,
             brief_evidence = ?, brief_error = NULL,
             brief_attempted_at = datetime('now'),
             brief_attempts = IFNULL(brief_attempts, 0) + 1,
             brief_claim_id = NULL, brief_claimed_at = NULL
         WHERE id = ?`,
      )
        .bind(brief.title_ar, brief.snippet_ar, brief.engine, brief.evidence, row.id)
        .run();
      summarized += 1;
    } catch (error) {
      const message = String(error?.message || error).slice(0, 240);
      retryAfterSeconds = Math.max(retryAfterSeconds, Number(error?.retryAfterSeconds) || 0);
      const state = pendingAiBrief(row, true);
      await env.DB.prepare(
        `UPDATE items
         SET title_ar = ?, snippet_ar = ?, trans_engine = ?,
             brief_evidence = NULL, brief_error = ?,
             brief_attempted_at = datetime('now'),
             brief_attempts = IFNULL(brief_attempts, 0) + 1,
             brief_claim_id = NULL, brief_claimed_at = NULL
         WHERE id = ?`,
      )
        .bind(state.title_ar, state.snippet_ar, state.engine, message, row.id)
        .run();
      failed += 1;
    }
  }

  return {
    summarized,
    failed,
    retryAfterSeconds,
    pending: await pendingBriefCount(env, mayorId),
  };
}
