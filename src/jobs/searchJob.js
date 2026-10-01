import { MAYORS, listMayors } from "../mayors.js";

const SEARCH_TOTAL_KEYS = [
  "found",
  "held",
  "updated",
  "skippedStale",
  "skippedUnverified",
  "skippedUnrelated",
  "skippedUntrusted",
  "discovered",
  "opened",
  "skippedTopic",
  "summarized",
  "aiPending",
  "aiFailed",
];

export function parseTaskResult(value) {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function searchJobSnapshot(job, tasks, mayors = MAYORS) {
  const totals = Object.fromEntries(SEARCH_TOTAL_KEYS.map((key) => [key, 0]));
  totals.duplicates = 0;
  totals.sourceErrors = 0;
  let completed = 0;
  let failed = 0;
  let running = 0;
  for (const task of tasks) {
    if (task.status === "completed") {
      completed += 1;
      const result = parseTaskResult(task.result_json);
      SEARCH_TOTAL_KEYS.forEach((key) => {
        totals[key] += Number(result[key]) || 0;
      });
      totals.duplicates += Number(result.review?.duplicates) || 0;
      totals.sourceErrors += Array.isArray(result.errors) ? result.errors.length : 0;
    } else if (task.status === "failed") {
      failed += 1;
    } else if (
      task.status === "running" ||
      task.status === "retrying" ||
      task.status === "waiting"
    ) {
      running += 1;
    }
  }
  const total = tasks.length;
  const terminal = total > 0 && completed + failed === total;
  const status = terminal
    ? failed === total
      ? "failed"
      : failed
        ? "partial"
        : "completed"
    : running
      ? "running"
      : "queued";
  return {
    id: job.id,
    status,
    query: job.query || "",
    mayor_id: job.mayor_id || null,
    total,
    completed,
    failed,
    running,
    totals,
    tasks: tasks.map((task) => ({
      mayor_id: task.mayor_id,
      mayor_name: mayors.find((mayor) => mayor.id === task.mayor_id)?.name_ar || task.mayor_id,
      status: task.status,
      stage: task.stage || task.status,
      detail: task.detail || "",
      attempts: Number(task.attempts) || 0,
      error: task.error || null,
    })),
  };
}

export async function readSearchJob(env, jobId) {
  const job = await env.DB.prepare(`SELECT * FROM search_jobs WHERE id = ?`).bind(jobId).first();
  if (!job) return null;
  const { results } = await env.DB.prepare(
    `SELECT mayor_id, status, stage, detail, attempts, result_json, error
     FROM search_job_tasks WHERE job_id = ? ORDER BY mayor_id`,
  )
    .bind(jobId)
    .all();
  return searchJobSnapshot(job, results || [], await listMayors(env));
}

export async function refreshSearchJobStatus(env, jobId) {
  const snapshot = await readSearchJob(env, jobId);
  if (!snapshot) return;
  await env.DB.prepare(
    `UPDATE search_jobs
     SET status = ?, finished_at = CASE WHEN ? IN ('completed', 'partial', 'failed')
       THEN datetime('now') ELSE NULL END
     WHERE id = ?`,
  )
    .bind(snapshot.status, snapshot.status, jobId)
    .run();
}
