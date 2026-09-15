import { arabicRatio, decodeEntities, splitHeadline } from "./text.js";
import { availableAiCalls } from "./aiBudget.js";
import { readSourceDocuments } from "./sourceDocuments.js";
import { boundSlots, completedBriefSql } from "./aiProviders.js";
import {
  assignPendingLanes,
  briefScopeSql,
  eligibleBriefFilter,
  failoverAttemptLimit,
  nextSlotForFailover,
  pendingBriefFilter,
  waitingBriefFilter,
} from "./aiDispatch.js";
import {
  claimVerifications,
  deferVerification,
  recordVerificationFailure,
  recordVerificationPass,
  saveBriefVersion,
  sourceHash,
  verificationBacklog,
} from "./versions.js";
import {
  BRIEF_STATE,
  aiBriefEnabled,
  isDeferredAiError,
  pendingAiBrief,
  summarizeWithGemini,
  transientAiError,
  verifyBriefSemantics,
  workerLimitError,
} from "./aiBrief.js";

export { arabicRatio, decodeEntities, splitHeadline };
export {
  assignPendingLanes,
  briefScopeSql,
  eligibleBriefFilter,
  MAX_BRIEF_ATTEMPTS,
  pendingBriefFilter,
} from "./aiDispatch.js";

const BRIEF_STATE_TITLES = {
  unconfigured: "مفتاح الذكاء الاصطناعي غير مربوط بالعامل — ",
};

/**
 * يفصل ما ينتظر عن ما يمكن تنفيذه الآن، ويعيد أقرب وقت صالح، فلا تُجدول رسائل
 * لا عمل لها ولا يُقرأ الانتظار كأنه تعذر.
 */
export async function briefBacklog(env, mayorId = null) {
  const binds = [];
  let sql = `SELECT
       COUNT(*) AS pending,
       SUM(CASE WHEN items.brief_after IS NULL OR items.brief_after <= datetime('now')
                THEN 1 ELSE 0 END) AS eligible,
       MIN(CASE WHEN items.brief_after IS NULL OR items.brief_after <= datetime('now')
                THEN NULL ELSE items.brief_after END) AS next_at
     FROM items WHERE ${waitingBriefFilter()}`;
  if (mayorId) {
    sql += " AND items.mayor_id = ?";
    binds.push(mayorId);
  }
  const row = binds.length
    ? await env.DB.prepare(sql).bind(...binds).first()
    : await env.DB.prepare(sql).first();
  return {
    pending: Number(row?.pending) || 0,
    eligible: Number(row?.eligible) || 0,
    nextAt: row?.next_at || null,
  };
}

export async function pendingBriefCount(env, mayorId = null) {
  const binds = [];
  let sql = `SELECT COUNT(*) AS pending FROM items WHERE ${pendingBriefFilter()}`;
  if (mayorId) {
    sql += " AND items.mayor_id = ?";
    binds.push(mayorId);
  }
  const row = binds.length
    ? await env.DB.prepare(sql).bind(...binds).first()
    : await env.DB.prepare(sql).first();
  return Number(row?.pending) || 0;
}

/**
 * يحجز الصفوف قبل نداء الذكاء الاصطناعي حتى لا يدفع تشغيلان متزامنان ثمن
 * الخبر نفسه. الترتيب يوزّع الحصة على المكاتب بالتناوب: المكتب الأقل موجزات
 * مكتملة يأخذ الدور أولًا، فلا يبتلع مكتب واحد حصة اليوم كلها.
 */
async function claimBriefRows(env, limit, mayorId, slot) {
  const claimId = crypto.randomUUID();
  const binds = [claimId, slot.id, BRIEF_STATE.WORKING, slot.id];
  let where = `${eligibleBriefFilter()}
    AND items.brief_provider = ?`;
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
        WHERE done.mayor_id = items.mayor_id AND ${completedBriefSql("done")}) ASC,`;
  binds.push(limit);

  await env.DB.prepare(
    `UPDATE items
     SET brief_claim_id = ?, brief_claimed_at = datetime('now'),
         brief_provider = ?, trans_engine = ?
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
            items.published_at, items.publisher_domain, items.source,
            items.source_documents, items.merged_sources,
            items.approved_version_id, items.source_hash,
            items.brief_provider, items.brief_attempts,
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
    `UPDATE items
     SET brief_claim_id = NULL, brief_claimed_at = NULL,
         trans_engine = CASE WHEN trans_engine = '${BRIEF_STATE.WORKING}'
           THEN '${BRIEF_STATE.PENDING}' ELSE trans_engine END
     WHERE id = ?`,
  );
  await env.DB.batch(ids.map((id) => stmt.bind(id)));
}

/**
 * يُحفظ الموجز فور إنتاجه كنسخة مستقلة، قبل أي تدقيق، فلا يُفقد ولا يُعاد
 * إنتاجه إن تعذّر النداء الثاني. والنسخة المعتمدة سابقًا لا تُمسّ: إن تغيّر
 * المصدر نشأت نسخة جديدة تحتاج مراجعة، وبقي المعتمد وأدلته كما هما.
 */
async function storeBrief(env, row, brief) {
  const hash = await sourceHash(brief.sourceText || row.article_text || "");
  const versionId = await saveBriefVersion(env, {
    itemId: row.id,
    brief,
    hash,
    sent: brief.sent,
  });
  const changedUnderApproval = Boolean(row.approved_version_id) && row.source_hash !== hash;

  await env.DB.prepare(
    `UPDATE items
     SET title_ar = ?, snippet_ar = ?, trans_engine = ?,
         brief_evidence = ?, brief_error = NULL,
         brief_attempted_at = datetime('now'),
         brief_attempts = IFNULL(brief_attempts, 0) + 1,
         brief_after = NULL, brief_claim_id = NULL, brief_claimed_at = NULL,
         current_version_id = ?, source_hash = ?,
         needs_review = CASE WHEN ? THEN 1 ELSE IFNULL(needs_review, 0) END
     WHERE id = ?`,
  )
    .bind(
      brief.title_ar,
      brief.snippet_ar,
      brief.engine,
      brief.evidence,
      versionId,
      hash,
      changedUnderApproval ? 1 : 0,
      row.id,
    )
    .run();
  return versionId;
}

/**
 * مرحلة التدقيق: تعمل على نسخ محفوظة، فتأجيلها لا يُفقد شيئًا ولا يعيد إنتاج
 * الموجز. النتيجة تُكتب على النسخة نفسها مع وقت استئناف عند التأجيل.
 */
export async function verifyPending(env, limit = 1, fetcher = undefined) {
  if (!aiBriefEnabled(env)) {
    return { verified: 0, rejected: 0, deferred: 0, ...(await verificationBacklog(env)) };
  }
  const ready = await slotsWithCapacity(env, "brief");
  if (!ready.length) {
    const backlog = await verificationBacklog(env);
    return { verified: 0, rejected: 0, deferred: backlog.eligible > 0 ? 1 : 0, ...backlog };
  }
  const rows = await claimVerifications(env, Math.min(limit, ready.length));
  const runOne = async (version) => {
    try {
      const checked = await verifyBriefSemantics(
        env,
        {
          title_ar: version.title_ar,
          snippet_ar: version.snippet_ar,
          evidence: version.evidence,
          engine: version.engine,
        },
        fetcher,
      );
      await recordVerificationPass(env, version.id, checked.snippet_ar, checked.evidence);
      await env.DB.prepare(
        `UPDATE items SET snippet_ar = ?, brief_evidence = ?
         WHERE id = ? AND current_version_id = ?`,
      )
        .bind(checked.snippet_ar, checked.evidence, version.item_id, version.id)
        .run();
      return "verified";
    } catch (error) {
      if (isDeferredAiError(error) || transientAiError(error)) {
        await deferVerification(
          env,
          version.id,
          Number(error?.retryAfterSeconds) || 60,
          String(error?.message || error),
        );
        return "deferred";
      }
      await recordVerificationFailure(env, version.id, String(error?.message || error));
      return "rejected";
    }
  };

  const outcomes = rows.length ? await Promise.all(rows.map((version) => runOne(version))) : [];
  return {
    verified: outcomes.filter((row) => row === "verified").length,
    rejected: outcomes.filter((row) => row === "rejected").length,
    deferred: outcomes.filter((row) => row === "deferred").length,
    ...(await verificationBacklog(env)),
  };
}

/**
 * نفاد الحصة وحدّ طلبات العامل قرارا تشغيل، لا عيب في الخبر. أخطاء المحتوى
 * تنتقل لفتحة أخرى مرة واحدة لكل نموذج، ولا تُغلق الصفحة قبل أن تُقرأ.
 */
async function storeBriefProblem(env, row, error, slot = null) {
  const deferred = isDeferredAiError(error) || transientAiError(error);
  const note = String(error?.message || error).slice(0, 240);

  if (deferred) {
    const wait = workerLimitError(error)
      ? 5
      : Math.max(1, Math.round(Number(error?.retryAfterSeconds) || 30));
    const state = pendingAiBrief(row, BRIEF_STATE.DEFERRED);
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

  const tries = (Number(row.brief_attempts) || 0) + 1;
  const currentId = row.brief_provider || slot?.id || null;
  const next = await nextSlotForFailover(env, currentId);
  const canRotate = Boolean(next) && tries < failoverAttemptLimit(env);
  if (canRotate) {
    const state = pendingAiBrief(row, BRIEF_STATE.PENDING);
    await env.DB.prepare(
      `UPDATE items
       SET title_ar = ?, snippet_ar = ?, trans_engine = ?,
           brief_evidence = NULL, brief_error = ?,
           brief_attempted_at = datetime('now'),
           brief_attempts = ?, brief_after = NULL,
           brief_claim_id = NULL, brief_claimed_at = NULL,
           brief_provider = ?
       WHERE id = ?`,
    )
      .bind(state.title_ar, state.snippet_ar, state.engine, note, tries, next.id, row.id)
      .run();
    return { deferred: false, transient: false, rotated: true };
  }

  const state = pendingAiBrief(row, BRIEF_STATE.FAILED);
  await env.DB.prepare(
    `UPDATE items
     SET title_ar = ?, snippet_ar = ?, trans_engine = ?,
         brief_evidence = NULL, brief_error = ?,
         brief_attempted_at = datetime('now'),
         brief_attempts = ?,
         brief_claim_id = NULL, brief_claimed_at = NULL
     WHERE id = ?`,
  )
    .bind(state.title_ar, state.snippet_ar, state.engine, note, tries, row.id)
    .run();
  return { deferred: false, transient: false, rotated: false };
}

/**
 * بلا مفتاح لا يمكن التلخيص، لكن الصمت أسوأ من التعذر: تُوسم الأخبار بحالة
 * صريحة تقول إن المفتاح غير مربوط، بدل بقائها على «بانتظار القراءة» أبدًا
 * بينما يبلّغ النظام أن لا شيء معلّق.
 */
async function markUnconfigured(env, mayorId) {
  const binds = [];
  let sql = `UPDATE items
     SET trans_engine = '${BRIEF_STATE.UNCONFIGURED}', snippet_ar = '',
         title_ar = '${BRIEF_STATE_TITLES.unconfigured}' ||
           COALESCE((SELECT name_ar FROM mayors WHERE mayors.id = items.mayor_id), items.mayor_id)
     WHERE ${briefScopeSql()}
       AND NOT (${completedBriefSql()})
       AND IFNULL(items.trans_engine, '') <> '${BRIEF_STATE.UNCONFIGURED}'`;
  if (mayorId) {
    sql += " AND items.mayor_id = ?";
    binds.push(mayorId);
  }
  const stmt = env.DB.prepare(sql);
  if (binds.length) await stmt.bind(...binds).run();
  else await stmt.run();
}

export async function slotsWithCapacity(env, purpose = "brief") {
  const ready = [];
  for (const slot of boundSlots(env)) {
    const n = await availableAiCalls(env, purpose, slot.id);
    if (n > 0) ready.push({ slot, n });
  }
  ready.sort((a, b) => b.n - a.n);
  return ready;
}

async function processClaimedRow(env, row, slot, fetcher) {
  const documents = readSourceDocuments(row);
  await storeBrief(env, row, await summarizeWithGemini(env, row, row, fetcher, documents, slot));
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
  await assignPendingLanes(env, mayorId);
  const ready = await slotsWithCapacity(env, "brief");
  if (!ready.length) {
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

  let summarized = 0;
  let failed = 0;
  let deferred = 0;
  let retryAfterSeconds = 0;

  const noteOutcome = async (row, error, slot, restIds) => {
    const outcome = await storeBriefProblem(env, row, error, slot);
    retryAfterSeconds = Math.max(retryAfterSeconds, Number(error?.retryAfterSeconds) || 0);
    if (outcome.deferred) {
      deferred += 1;
      if (restIds?.length) await releaseClaims(env, restIds);
      return true;
    }
    failed += 1;
    return false;
  };

  if (ready.length === 1) {
    const { slot, n } = ready[0];
    const rows = await claimBriefRows(env, Math.min(limit, n), mayorId, slot);
    for (let index = 0; index < rows.length; index += 1) {
      try {
        await processClaimedRow(env, rows[index], slot, fetcher);
        summarized += 1;
      } catch (error) {
        const stop = await noteOutcome(
          rows[index],
          error,
          slot,
          rows.slice(index + 1).map((rest) => rest.id),
        );
        if (stop) break;
      }
    }
  } else {
    const jobs = [];
    for (const { slot } of ready.slice(0, limit)) {
      const rows = await claimBriefRows(env, 1, mayorId, slot);
      if (rows[0]) jobs.push({ row: rows[0], slot });
    }
    const outcomes = await Promise.all(
      jobs.map(async (job) => {
        try {
          await processClaimedRow(env, job.row, job.slot, fetcher);
          return { ok: true };
        } catch (error) {
          return { ok: false, row: job.row, slot: job.slot, error };
        }
      }),
    );
    for (const outcome of outcomes) {
      if (outcome.ok) summarized += 1;
      else await noteOutcome(outcome.row, outcome.error, outcome.slot);
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
