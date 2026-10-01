import { boundSlotWaitMs } from "../aiDispatch.js";
import { assessMayorJourney, resolveScanId } from "../journey.js";
import { listMayors } from "../mayors.js";
import {
  fetchCandidateBatch,
  pendingCandidateCount,
  pendingFetchIds,
  runScan,
} from "../pipeline.js";
import { reviewInbox } from "../reviewAgent.js";
import { ARTICLE_FETCH_BATCH, INLINE_ARTICLE_FETCH_LIMIT } from "../sources.js";
import {
  assignPendingLanes,
  briefBacklog,
  slotsWithCapacity,
  translatePending,
  verifyPending,
} from "../translate.js";
import { verificationBacklog } from "../versions.js";
import { BRIEF_BATCH_SIZE, DRAIN_MAX_BRIEFS, DRAIN_MAX_MS } from "../config.js";
import { recordSourceHealth } from "../db/items.js";
import {
  briefStage,
  continuationDelaySeconds,
  shouldContinueBriefs,
} from "./continuation.js";
import {
  enqueueArticleFetches,
  enqueueBriefPump,
  enqueueSourcePolls,
} from "./enqueue.js";
import { parseTaskResult, refreshSearchJobStatus } from "./searchJob.js";

/**
 * جمع الصفحات منفصل عن القراءة. خلطهما في نفس تشغيل العامل يستنفد حد
 * الطلبات الخمسين فيتوقف النداء ويُسجَّل اعتذارًا على الخبر.
 */
export async function finishDesk(env, scanOpts, onProgress = async () => {}) {
  const result = await runScan(env, scanOpts, onProgress);
  await recordSourceHealth(env, result.sourceHealth);
  await onProgress("merging", "يدمج التغطيات المتكررة للحدث نفسه");
  const review = await reviewInbox(env, {
    mayorId: scanOpts.mayorId || null,
    limit: 500,
    useAiMerge: false,
  });
  await onProgress("assigning", "يوزّع الأخبار على نماذج القراءة");
  const lanes = await assignPendingLanes(env, scanOpts.mayorId || null);
  const backlog = await briefBacklog(env, scanOpts.mayorId || null);
  return {
    ...result,
    review,
    assigned: lanes.assigned,
    summarized: 0,
    aiFailed: 0,
    aiDeferred: 0,
    aiPending: backlog.pending,
    aiRetryAfterSeconds: 0,
  };
}

/** يلخص دفعة صغيرة فقط، ويترك الباقي للطابور أو لمهمة التصريف الدورية. */
export async function summarizeBatch(env, mayorId, onProgress = async () => {}) {
  await onProgress("summarizing", "يقرأ الذكاء الاصطناعي نصوص الصفحات المدمجة ويدققها");
  const summary = await translatePending(env, BRIEF_BATCH_SIZE, mayorId);
  const { stage, detail } = briefStage(summary);
  await onProgress(stage, detail);
  return summary;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * مهمة التصريف الدورية: تُكمل الموجزات المعلقة بلا أي تدخل من المستخدم، وتتوقف
 * فور إغلاق الميزانية. هذه هي التي تجعل الرحلة تنتهي من تلقاء نفسها.
 */
export async function drainBriefs(env, { maxBriefs = DRAIN_MAX_BRIEFS, maxMs = DRAIN_MAX_MS } = {}) {
  const startedAt = Date.now();
  const totals = {
    summarized: 0,
    failed: 0,
    deferred: 0,
    verified: 0,
    rejected: 0,
    pending: 0,
    rounds: 0,
  };
  await assignPendingLanes(env);
  while (totals.summarized + totals.failed < maxBriefs && Date.now() - startedAt < maxMs) {
    const ready = await slotsWithCapacity(env, "brief");
    const batch = Math.max(1, Math.min(BRIEF_BATCH_SIZE, ready.length || 1));
    const summary = await translatePending(env, batch, null);
    const checked = await verifyPending(env, batch);
    totals.verified += checked.verified;
    totals.rejected += checked.rejected;
    totals.rounds += 1;
    totals.summarized += summary.summarized;
    totals.failed += summary.failed;
    totals.deferred += summary.deferred;
    totals.pending = summary.pending;
    if (summary.pending === 0 && checked.pending === 0) break;
    const still = await slotsWithCapacity(env, "brief");
    if (still.length) continue;
    const waitMs = boundSlotWaitMs(env);
    if (Date.now() - startedAt + waitMs >= maxMs) {
      if (summary.pending > 0 || checked.pending > 0) {
        await enqueueBriefPump(env, { delaySeconds: Math.max(1, Math.ceil(waitMs / 1000)) });
      }
      break;
    }
    await sleep(waitMs + 250);
  }
  await refreshOpenSearchJobs(env);
  return totals;
}

export async function persistMayorJourney(env, { mayorId, jobId, scanId = null, result = null }) {
  if (!jobId || !mayorId) return null;
  const resolvedScanId = await resolveScanId(env, { jobId, mayorId, scanId });
  const assessment = await assessMayorJourney(env, { mayorId, scanId: resolvedScanId });
  const previous = parseTaskResult(
    (
      await env.DB.prepare(
        `SELECT result_json FROM search_job_tasks WHERE job_id = ? AND mayor_id = ?`,
      )
        .bind(jobId, mayorId)
        .first()
    )?.result_json,
  );
  const merged = {
    ...previous,
    ...(result || {}),
    scanId: resolvedScanId || previous.scanId || result?.scanId || null,
    journey: {
      stage: assessment.stage,
      reading: assessment.reading,
      verifying: assessment.verifying,
      settled: assessment.settled,
      total: assessment.total,
      resumeAt: assessment.resumeAt,
    },
  };
  const terminal = assessment.status === "completed";
  await env.DB.prepare(
    `UPDATE search_job_tasks
     SET status = ?,
         stage = ?,
         detail = ?,
         finished_at = CASE WHEN ? THEN datetime('now') ELSE NULL END,
         result_json = ?,
         error = NULL
     WHERE job_id = ? AND mayor_id = ?
       AND IFNULL(status, '') <> 'failed'`,
  )
    .bind(
      assessment.status,
      assessment.stage,
      String(assessment.detail || "").slice(0, 300),
      terminal ? 1 : 0,
      JSON.stringify(merged),
      jobId,
      mayorId,
    )
    .run();
  await refreshSearchJobStatus(env, jobId);
  return assessment;
}

export async function refreshJobJourney(env, jobId) {
  if (!jobId) return;
  const { results: tasks } = await env.DB.prepare(
    `SELECT mayor_id FROM search_job_tasks
     WHERE job_id = ? AND status NOT IN ('completed', 'failed')`,
  )
    .bind(jobId)
    .all();
  for (const task of tasks || []) {
    await persistMayorJourney(env, { mayorId: task.mayor_id, jobId });
  }
}

async function refreshOpenSearchJobs(env) {
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT job_id FROM search_job_tasks
     WHERE status IN ('running', 'waiting', 'retrying')`,
  ).all();
  for (const row of results || []) {
    await refreshJobJourney(env, row.job_id);
  }
}

export async function completeMayorDesk(env, { mayorId, jobId, scanId }) {
  const review = await reviewInbox(env, { mayorId, limit: 500, useAiMerge: false });
  const lanes = await assignPendingLanes(env, mayorId);
  const backlog = await briefBacklog(env, mayorId);
  const verify = await verificationBacklog(env);
  const pending = await pendingCandidateCount(env, mayorId, scanId);
  const foundRow = scanId
    ? await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM items WHERE scan_id = ? AND mayor_id = ?`,
      )
        .bind(scanId, mayorId)
        .first()
    : { n: 0 };
  const result = {
    found: Number(foundRow?.n) || 0,
    review,
    assigned: lanes.assigned,
    aiPending: backlog.pending,
    pendingCandidates: pending,
    scanId: scanId || null,
  };
  const assessment = jobId
    ? await persistMayorJourney(env, { mayorId, jobId, scanId, result })
    : await assessMayorJourney(env, { mayorId, scanId });
  if (assessment?.status !== "completed") {
    const ready = await slotsWithCapacity(env, "brief");
    const pendingWork = (backlog.pending || 0) + (verify.pending || 0);
    if (ready.length && ((backlog.eligible || 0) > 0 || (verify.eligible || 0) > 0)) {
      await enqueueBriefPump(env, { jobId, delaySeconds: 0 });
    } else if (
      shouldContinueBriefs({
        pending: pendingWork,
        deferred: assessment?.blocked ? 1 : 0,
        nextAt: assessment?.resumeAt || backlog.nextAt || verify.nextAt,
      })
    ) {
      await enqueueBriefPump(env, {
        jobId,
        delaySeconds: continuationDelaySeconds({
          nextAt: assessment?.resumeAt || backlog.nextAt || verify.nextAt,
        }),
      });
    }
  }
  return {
    review,
    assigned: lanes.assigned,
    aiPending: backlog.pending,
    journey: assessment,
  };
}

export async function maybeFinishMayor(env, { mayorId, jobId, scanId }) {
  const polls = await env.DB.prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN status IN ('polled', 'failed') THEN 1 ELSE 0 END) AS done
     FROM scan_sources WHERE scan_id = ? AND mayor_id = ?`,
  )
    .bind(scanId, mayorId)
    .first();
  if (!polls?.n || Number(polls.done) < Number(polls.n)) return { done: false };
  const pending = await pendingCandidateCount(env, mayorId, scanId);
  if (pending > 0) {
    const ids = await pendingFetchIds(env, { mayorId, scanId, limit: ARTICLE_FETCH_BATCH * 8 });
    if (env.SCAN_QUEUE) await enqueueArticleFetches(env, { ids, mayorId, scanId, jobId });
    else await fetchCandidateBatch(env, { ids, limit: INLINE_ARTICLE_FETCH_LIMIT });
    return { done: false, pending };
  }
  await completeMayorDesk(env, { mayorId, jobId, scanId });
  return { done: true };
}

async function finishAllOffices(env, type = "weekly") {
  const results = [];
  const errors = [];
  const offices = await listMayors(env);
  for (let i = 0; i < offices.length; i += 2) {
    const chunk = offices.slice(i, i + 2);
    const settled = await Promise.allSettled(
      chunk.map((mayor) =>
        finishDesk(env, { type, query: "", mayorId: mayor.id }),
      ),
    );
    settled.forEach((result, index) => {
      if (result.status === "fulfilled") {
        results.push({ mayorId: chunk[index].id, ...result.value });
      } else {
        errors.push(`${chunk[index].id}: ${String(result.reason?.message || result.reason)}`);
      }
    }    );
  }
  await assignPendingLanes(env);
  if (env.SCAN_QUEUE) await enqueueBriefPump(env);
  else await drainBriefs(env);
  return { offices: results.length, failed: errors.length, errors, results };
}

export async function enqueueAllOffices(env, type = "weekly") {
  if (!env.SCAN_QUEUE) return finishAllOffices(env, type);
  const queued = await enqueueSourcePolls(env, {
    mayorIds: (await listMayors(env)).map((mayor) => mayor.id),
    type,
  });
  return { queued: queued.queued, type, scanId: queued.scanId };
}
