import { assessMayorJourney } from "../journey.js";
import { resolveMayor } from "../mayors.js";
import {
  fetchCandidateBatch,
  pendingCandidateCount,
  pendingFetchIds,
  pollOneSource,
} from "../pipeline.js";
import { ARTICLE_FETCH_BATCH } from "../sources.js";
import { assignPendingLanes, briefBacklog, verifyPending } from "../translate.js";
import { verificationBacklog } from "../versions.js";
import { BRIEF_BATCH_SIZE } from "../config.js";
import { recordSourceHealth } from "../db/items.js";
import {
  continuationDelaySeconds,
  earliestIso,
  shouldContinueBriefs,
} from "./continuation.js";
import {
  finishDesk,
  maybeFinishMayor,
  persistMayorJourney,
  refreshJobJourney,
  summarizeBatch,
} from "./desk.js";
import {
  enqueueArticleFetches,
  enqueueBriefPump,
  enqueueSourcePolls,
} from "./enqueue.js";
import { refreshSearchJobStatus } from "./searchJob.js";

async function processSourcePollMessage(env, message) {
  const body = message.body || {};
  const { mayorId, sourceId, scanId, jobId, query } = body;
  if (!mayorId || !sourceId) {
    message.ack();
    return;
  }
  if (jobId) {
    await env.DB.prepare(
      `UPDATE search_job_tasks
       SET status = 'running', stage = 'source_poll',
           detail = ?, started_at = COALESCE(started_at, datetime('now'))
       WHERE job_id = ? AND mayor_id = ?`,
    )
      .bind(`يفحص المصدر ${sourceId}`, jobId, mayorId)
      .run();
  }
  await env.DB.prepare(
    `UPDATE scan_sources SET status = 'polling', detail = 'جاري فحص المصدر' WHERE scan_id = ? AND source_id = ?`,
  )
    .bind(scanId, sourceId)
    .run();
  try {
    const polled = await pollOneSource(env, { sourceId, mayorId, scanId, query });
    await recordSourceHealth(env, [{ ...polled.health, id: sourceId }]);
    await env.DB.prepare(
      `UPDATE scan_sources SET status = 'polled', detail = ? WHERE scan_id = ? AND source_id = ?`,
    )
      .bind(String(polled.health.status || "ok").slice(0, 160), scanId, sourceId)
      .run();
    if (polled.newIds?.length && env.SCAN_QUEUE) {
      await enqueueArticleFetches(env, {
        ids: polled.newIds,
        mayorId,
        scanId,
        jobId,
      });
    } else if (polled.newIds?.length) {
      await fetchCandidateBatch(env, { ids: polled.newIds, limit: ARTICLE_FETCH_BATCH });
    }
    await maybeFinishMayor(env, { mayorId, jobId, scanId });
    message.ack();
  } catch (error) {
    await env.DB.prepare(
      `UPDATE scan_sources SET status = 'failed', detail = ? WHERE scan_id = ? AND source_id = ?`,
    )
      .bind(String(error.message || error).slice(0, 160), scanId, sourceId)
      .run();
    await maybeFinishMayor(env, { mayorId, jobId, scanId });
    message.ack();
  }
}

async function processArticleFetchMessage(env, message) {
  const body = message.body || {};
  const { mayorId, scanId, jobId, candidateIds } = body;
  if (jobId && mayorId) {
    await env.DB.prepare(
      `UPDATE search_job_tasks
       SET status = 'running', stage = 'article_fetch', detail = 'يفتح المقالات المكتشفة'
       WHERE job_id = ? AND mayor_id = ?`,
    )
      .bind(jobId, mayorId)
      .run();
  }
  try {
    await fetchCandidateBatch(env, {
      ids: candidateIds || [],
      mayorId,
      limit: ARTICLE_FETCH_BATCH,
    });
    const pending = await pendingCandidateCount(env, mayorId, scanId);
    if (pending > 0 && env.SCAN_QUEUE) {
      const ids = await pendingFetchIds(env, { mayorId, scanId, limit: ARTICLE_FETCH_BATCH });
      await enqueueArticleFetches(env, { ids, mayorId, scanId, jobId });
    } else {
      await maybeFinishMayor(env, { mayorId, jobId, scanId });
    }
    message.ack();
  } catch {
    message.retry({ delaySeconds: 20 });
  }
}

async function processBriefContinuation(env, message) {
  const body = message.body || {};
  const jobId = body.jobId || null;
  try {
    await assignPendingLanes(env);
    const summary = await summarizeBatch(env, null);
    await verifyPending(env, BRIEF_BATCH_SIZE);
    await assignPendingLanes(env);
    const leftover = await briefBacklog(env);
    const verify = await verificationBacklog(env);
    if (jobId) await refreshJobJourney(env, jobId);
    const nextAt = earliestIso(leftover.nextAt, verify.nextAt);
    if ((leftover.eligible || 0) > 0 || (verify.eligible || 0) > 0) {
      await enqueueBriefPump(env, {
        jobId,
        delaySeconds: summary.summarized > 0 || summary.failed > 0 ? 0 : 5,
      });
    } else if (
      shouldContinueBriefs({
        ...summary,
        pending: (leftover.pending || 0) + (verify.pending || 0),
        nextAt,
      })
    ) {
      await enqueueBriefPump(env, {
        jobId,
        delaySeconds: continuationDelaySeconds({ ...summary, nextAt }),
      });
    }
    message.ack();
  } catch {
    message.retry({ delaySeconds: 30 });
  }
}

export async function processQueuedSearch(env, message) {
  const body = message.body || {};
  if (body.type === "brief") {
    await processBriefContinuation(env, message);
    return;
  }
  if (body.type === "source_poll") {
    await processSourcePollMessage(env, message);
    return;
  }
  if (body.type === "article_fetch") {
    await processArticleFetchMessage(env, message);
    return;
  }
  const mayorId = body.mayorId;
  const mayor = await resolveMayor(env, mayorId);
  if (!mayorId || !mayor) {
    message.ack();
    return;
  }
  if (env.SCAN_QUEUE) {
    await enqueueSourcePolls(env, {
      mayorIds: [mayorId],
      type: body.type || "weekly",
      query: body.query || "",
      jobId: body.jobId || null,
    });
    message.ack();
    return;
  }
  const jobId = body.jobId || null;
  if (jobId) {
    const task = await env.DB.prepare(
      `SELECT status FROM search_job_tasks WHERE job_id = ? AND mayor_id = ?`,
    )
      .bind(jobId, mayorId)
      .first();
    if (!task || task.status === "completed" || task.status === "failed") {
      message.ack();
      return;
    }
    await env.DB.prepare(
      `UPDATE search_job_tasks
       SET status = 'running', attempts = IFNULL(attempts, 0) + 1,
           stage = 'discovering', detail = 'يبدأ البحث المباشر بالاسم والمنصب',
           started_at = COALESCE(started_at, datetime('now')), error = NULL
       WHERE job_id = ? AND mayor_id = ?`,
    )
      .bind(jobId, mayorId)
      .run();
    await env.DB.prepare(`UPDATE search_jobs SET status = 'running' WHERE id = ?`)
      .bind(jobId)
      .run();
  }

  const onProgress = jobId
    ? async (stage, detail) => {
        await env.DB.prepare(
          `UPDATE search_job_tasks SET stage = ?, detail = ?
           WHERE job_id = ? AND mayor_id = ?`,
        )
          .bind(stage, String(detail || "").slice(0, 300), jobId, mayorId)
          .run();
      }
    : async () => {};

  try {
    const result = await finishDesk(env, {
      type: body.type || "weekly",
      query: body.query || "",
      mayorId,
    }, onProgress);
    const assessment = jobId
      ? await persistMayorJourney(env, {
          mayorId,
          jobId,
          scanId: result.scanId || null,
          result: { ...result, scanId: result.scanId || null },
        })
      : await assessMayorJourney(env, { mayorId, scanId: result.scanId || null });
    if (assessment?.status !== "completed") {
      await enqueueBriefPump(env, { jobId, delaySeconds: 0 });
    }
    message.ack();
  } catch (error) {
    if (!jobId) {
      message.retry();
      return;
    }
    const exhausted = Number(message.attempts || 1) >= 3;
    await env.DB.prepare(
      `UPDATE search_job_tasks
       SET status = ?, finished_at = CASE WHEN ? THEN datetime('now') ELSE NULL END,
           stage = ?, detail = ?, error = ?
       WHERE job_id = ? AND mayor_id = ?`,
    )
      .bind(
        exhausted ? "failed" : "retrying",
        exhausted ? 1 : 0,
        exhausted ? "failed" : "retrying",
        exhausted ? "تعذر إكمال الرصد" : "تعذر مؤقتًا وستعاد المحاولة",
        String(error.message || error).slice(0, 300),
        jobId,
        mayorId,
      )
      .run();
    await refreshSearchJobStatus(env, jobId);
    if (exhausted) message.ack();
    else message.retry({ delaySeconds: 15 });
  }
}
