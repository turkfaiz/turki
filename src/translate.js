import { arabicRatio, decodeEntities, splitHeadline } from "./text.js";
import { availableAiCalls } from "./aiBudget.js";
import {
  BRIEF_STATE,
  aiBriefEnabled,
  aiBriefEngine,
  isDeferredAiError,
  pendingAiBrief,
  summarizeWithGemini,
  transientAiError,
} from "./aiBrief.js";

export { arabicRatio, decodeEntities, splitHeadline };

export const MAX_BRIEF_ATTEMPTS = 5;
const BRIEF_STATE_TITLES = {
  unconfigured: "مفتاح الذكاء الاصطناعي غير مربوط بالعامل — ",
};
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

/** المؤهل للتنفيذ الآن: معلّق وحلّ وقت استئنافه. */
export function eligibleBriefFilter(alias = "items") {
  return `${pendingBriefFilter(alias)}
    AND (${alias}.brief_after IS NULL OR ${alias}.brief_after <= datetime('now'))`;
}

/**
 * يفصل ما ينتظر عن ما يمكن تنفيذه الآن، ويعيد أقرب وقت صالح، فلا تُجدول رسائل
 * لا عمل لها ولا يُقرأ الانتظار كأنه تعذر.
 */
export async function briefBacklog(env, mayorId = null) {
  const binds = [aiBriefEngine(env)];
  let sql = `SELECT
       COUNT(*) AS pending,
       SUM(CASE WHEN items.brief_after IS NULL OR items.brief_after <= datetime('now')
                THEN 1 ELSE 0 END) AS eligible,
       MIN(CASE WHEN items.brief_after IS NULL OR items.brief_after <= datetime('now')
                THEN NULL ELSE items.brief_after END) AS next_at
     FROM items WHERE ${pendingBriefFilter()}`;
  if (mayorId) {
    sql += " AND items.mayor_id = ?";
    binds.push(mayorId);
  }
  const row = await env.DB.prepare(sql).bind(...binds).first();
  return {
    pending: Number(row?.pending) || 0,
    eligible: Number(row?.eligible) || 0,
    nextAt: row?.next_at || null,
  };
}

export async function pendingBriefCount(env, mayorId = null) {
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
 * يحجز الصفوف قبل نداء الذكاء الاصطناعي حتى لا يدفع تشغيلان متزامنان ثمن
 * الخبر نفسه. الترتيب يوزّع الحصة على المكاتب بالتناوب: المكتب الأقل موجزات
 * مكتملة يأخذ الدور أولًا، فلا يبتلع مكتب واحد حصة اليوم كلها.
 */
async function claimBriefRows(env, limit, mayorId, targetEngine) {
  const claimId = crypto.randomUUID();
  const binds = [claimId, targetEngine];
  let where = `${eligibleBriefFilter()}
    AND (items.brief_claimed_at IS NULL
      OR items.brief_claimed_at <= datetime('now', '-${CLAIM_TIMEOUT_MINUTES} minutes'))
    AND (items.brief_error IS NULL
      OR items.brief_attempted_at IS NULL
      OR items.brief_attempted_at <= datetime('now', '-${RETRY_BACKOFF_MINUTES} minutes'))`;
  if (mayorId) {
    where += " AND items.mayor_id = ?";
    binds.push(mayorId);
  }
  /**
   * التناوب بين المكاتب لا معنى له عند تحديد مكتب واحد، وبند ترتيب ثابت يشوّش
   * الترتيب المقصود، فيُحذف بدل تمرير قيمة صورية.
   */
  const fairness = mayorId
    ? ""
    : `(SELECT COUNT(*) FROM items done
        WHERE done.mayor_id = items.mayor_id AND done.trans_engine = ?) ASC,`;
  if (!mayorId) binds.push(targetEngine);
  binds.push(limit);

  await env.DB.prepare(
    `UPDATE items
     SET brief_claim_id = ?, brief_claimed_at = datetime('now')
     WHERE id IN (
       SELECT items.id FROM items
       WHERE ${where}
       ORDER BY CASE WHEN items.brief_error IS NULL THEN 0 ELSE 1 END,
                ${fairness}
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

async function releaseClaims(env, ids) {
  if (!ids.length) return;
  const stmt = env.DB.prepare(
    `UPDATE items SET brief_claim_id = NULL, brief_claimed_at = NULL WHERE id = ?`,
  );
  await env.DB.batch(ids.map((id) => stmt.bind(id)));
}

async function storeBrief(env, row, brief) {
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
}

/**
 * نفاد الحصة ليس خطأ في الخبر، فلا يُحتسب محاولة ولا يستهلك رصيد إعادة
 * المحاولة. الأخطاء العابرة تُحتسب لكنها تبقى قابلة للاستئناف، والأخطاء
 * الحقيقية في المحتوى وحدها هي التي تنتهي بحالة تعذّر.
 */
async function storeBriefProblem(env, row, error) {
  const deferred = isDeferredAiError(error);
  const transient = deferred || transientAiError(error);
  const state = pendingAiBrief(row, transient ? BRIEF_STATE.DEFERRED : BRIEF_STATE.FAILED);
  const note = String(error?.message || error).slice(0, 240);

  if (deferred) {
    /**
     * انتظار الميزانية قرار جدولة لا عيب في الخبر. تسجيله خطأً كان يُخضعه
     * لتراجع الأخطاء الطويل، فيُحجب ربع ساعة بسبب انتظار ثوانٍ.
     */
    const wait = Math.max(1, Math.round(Number(error?.retryAfterSeconds) || 30));
    await env.DB.prepare(
      `UPDATE items
       SET title_ar = ?, snippet_ar = ?, trans_engine = ?,
           brief_error = NULL, brief_after = datetime('now', ?),
           brief_claim_id = NULL, brief_claimed_at = NULL
       WHERE id = ?`,
    )
      .bind(state.title_ar, state.snippet_ar, state.engine, `+${wait} seconds`, row.id)
      .run();
    return { deferred: true, transient: true, waitSeconds: wait };
  }

  await env.DB.prepare(
    `UPDATE items
     SET title_ar = ?, snippet_ar = ?, trans_engine = ?,
         brief_evidence = NULL, brief_error = ?,
         brief_attempted_at = datetime('now'),
         brief_attempts = IFNULL(brief_attempts, 0) + 1,
         brief_claim_id = NULL, brief_claimed_at = NULL
     WHERE id = ?`,
  )
    .bind(state.title_ar, state.snippet_ar, state.engine, note, row.id)
    .run();
  return { deferred: false, transient };
}

/**
 * بلا مفتاح لا يمكن التلخيص، لكن الصمت أسوأ من التعذر: تُوسم الأخبار بحالة
 * صريحة تقول إن المفتاح غير مربوط، بدل بقائها على «بانتظار القراءة» أبدًا
 * بينما يبلّغ النظام أن لا شيء معلّق.
 */
async function markUnconfigured(env, mayorId) {
  const binds = [aiBriefEngine(env)];
  let sql = `UPDATE items
     SET trans_engine = '${BRIEF_STATE.UNCONFIGURED}', snippet_ar = '',
         title_ar = '${BRIEF_STATE_TITLES.unconfigured}' ||
           COALESCE((SELECT name_ar FROM mayors WHERE mayors.id = items.mayor_id), items.mayor_id)
     WHERE ${briefScopeSql()}
       AND (items.trans_engine IS NULL OR items.trans_engine <> ?)
       AND IFNULL(items.trans_engine, '') <> '${BRIEF_STATE.UNCONFIGURED}'`;
  if (mayorId) {
    sql += " AND items.mayor_id = ?";
    binds.push(mayorId);
  }
  await env.DB.prepare(sql).bind(...binds).run();
}

export async function translatePending(env, limit = 2, mayorId = null, fetcher = undefined) {
  if (!aiBriefEnabled(env)) {
    await markUnconfigured(env, mayorId);
    return {
      summarized: 0,
      failed: 0,
      deferred: 0,
      unconfigured: true,
      pending: await pendingBriefCount(env, mayorId),
      retryAfterSeconds: 0,
    };
  }
  const targetEngine = aiBriefEngine(env);
  const capacity = await availableAiCalls(env, "brief");
  if (capacity <= 0) {
    const backlog = await briefBacklog(env, mayorId);
    return {
      summarized: 0,
      failed: 0,
      deferred: backlog.eligible > 0 ? 1 : 0,
      pending: backlog.pending,
      eligible: backlog.eligible,
      nextAt: backlog.nextAt,
      retryAfterSeconds: 0,
    };
  }
  const rows = await claimBriefRows(env, Math.min(limit, capacity), mayorId, targetEngine);

  let summarized = 0;
  let failed = 0;
  let deferred = 0;
  let retryAfterSeconds = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    try {
      await storeBrief(env, row, await summarizeWithGemini(env, row, row, fetcher));
      summarized += 1;
    } catch (error) {
      const outcome = await storeBriefProblem(env, row, error);
      retryAfterSeconds = Math.max(retryAfterSeconds, Number(error?.retryAfterSeconds) || 0);
      if (outcome.deferred) {
        deferred += 1;
        // الميزانية مغلقة الآن؛ إبقاء بقية الصفوف حرة لتشغيل لاحق.
        await releaseClaims(env, rows.slice(index + 1).map((rest) => rest.id));
        break;
      }
      failed += 1;
    }
  }

  const backlog = await briefBacklog(env, mayorId);
  return {
    summarized,
    failed,
    deferred,
    retryAfterSeconds,
    pending: backlog.pending,
    eligible: backlog.eligible,
    nextAt: backlog.nextAt,
  };
}
