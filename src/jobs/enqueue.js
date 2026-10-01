import { listMayors } from "../mayors.js";
import { enabledSources } from "../pipeline.js";
import { ARTICLE_FETCH_BATCH } from "../sources.js";
import { continuationDelaySeconds } from "./continuation.js";
import { refreshSearchJobStatus } from "./searchJob.js";

export async function enqueueBriefPump(env, { jobId = null, delaySeconds = 0 } = {}) {
  if (!env.SCAN_QUEUE) return false;
  await env.SCAN_QUEUE.send(
    { type: "brief", mayorId: null, jobId },
    { contentType: "json", delaySeconds: Math.max(0, Number(delaySeconds) || 0) },
  );
  return true;
}

export async function enqueueBriefContinuation(env, mayorId, jobId, retryAfterSeconds = 0) {
  return enqueueBriefPump(env, {
    jobId,
    delaySeconds: continuationDelaySeconds({ retryAfterSeconds }),
  });
}

export async function enqueueSourcePolls(env, { mayorIds, type, query = "", jobId = null }) {
  const scanId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO scans (id, type, query, mayor_id, started_at, found_count, duplicate_count, excluded_count, error_count)
     VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)`,
  )
    .bind(scanId, type, query || null, mayorIds.length === 1 ? mayorIds[0] : null, new Date().toISOString())
    .run();

  const messages = [];
  for (const mayorId of mayorIds) {
    const sources = await enabledSources(env, mayorId);
    if (!sources.length) {
      if (jobId) {
        await env.DB.prepare(
          `UPDATE search_job_tasks
           SET status = 'completed', finished_at = datetime('now'),
               stage = 'completed', detail = 'لا منصات رصد مفعّلة لهذا المكتب',
               result_json = ?, error = NULL
           WHERE job_id = ? AND mayor_id = ?`,
        )
          .bind(JSON.stringify({ found: 0, pendingCandidates: 0 }), jobId, mayorId)
          .run();
        await refreshSearchJobStatus(env, jobId);
      }
      continue;
    }
    const insert = env.DB.prepare(
      `INSERT OR REPLACE INTO scan_sources (scan_id, source_id, mayor_id, job_id, status, detail)
       VALUES (?, ?, ?, ?, 'queued', 'بانتظار فحص المصدر')`,
    );
    await env.DB.batch(
      sources.map((source) => insert.bind(scanId, source.id, mayorId, jobId)),
    );
    for (const source of sources) {
      messages.push({
        body: { type: "source_poll", mayorId, sourceId: source.id, scanId, jobId, query },
        contentType: "json",
      });
    }
  }
  for (let i = 0; i < messages.length; i += 100) {
    await env.SCAN_QUEUE.sendBatch(messages.slice(i, i + 100));
  }
  return { scanId, queued: messages.length };
}

export async function enqueueArticleFetches(env, { ids, mayorId, scanId, jobId }) {
  if (!env.SCAN_QUEUE) return 0;
  const batches = [];
  for (let i = 0; i < ids.length; i += ARTICLE_FETCH_BATCH) {
    batches.push({
      body: {
        type: "article_fetch",
        mayorId,
        scanId,
        jobId,
        candidateIds: ids.slice(i, i + ARTICLE_FETCH_BATCH),
      },
      contentType: "json",
    });
  }
  for (let i = 0; i < batches.length; i += 100) {
    await env.SCAN_QUEUE.sendBatch(batches.slice(i, i + 100));
  }
  return batches.length;
}

export async function enqueueManualSearch(env, { mayorId = null, query = "" } = {}) {
  if (!env.SCAN_QUEUE) throw new Error("scan_queue_unavailable");
  const catalog = await listMayors(env);
  const targets = mayorId ? catalog.filter((mayor) => mayor.id === mayorId) : catalog;
  if (!targets.length) throw new Error("mayor_not_found");
  const jobId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO search_jobs (id, query, mayor_id, status) VALUES (?, ?, ?, 'queued')`,
  )
    .bind(jobId, query || null, mayorId)
    .run();
  const taskStmt = env.DB.prepare(
    `INSERT INTO search_job_tasks (job_id, mayor_id, status, stage, detail)
     VALUES (?, ?, 'queued', 'queued', 'بانتظار بدء الرصد')`,
  );
  await env.DB.batch(targets.map((mayor) => taskStmt.bind(jobId, mayor.id)));
  try {
    const queued = await enqueueSourcePolls(env, {
      mayorIds: targets.map((mayor) => mayor.id),
      type: "manual",
      query,
      jobId,
    });
    return { jobId, queued: queued.queued || targets.length, scanId: queued.scanId };
  } catch (error) {
    await env.DB.prepare(
      `UPDATE search_job_tasks SET status = 'failed', error = ? WHERE job_id = ?`,
    )
      .bind(String(error.message || error).slice(0, 300), jobId)
      .run();
    await refreshSearchJobStatus(env, jobId);
    throw error;
  }
}
