import { journeyFunnel } from "../journey.js";
import { MAYORS, listMayors } from "../mayors.js";
import { sourceById } from "../sources.js";

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

/** ما يلزم الواجهة من نتيجة المهمة: رحلة المكتب وأخطاء مصادره، بلا حمولة كاملة. */
function taskDigest(task) {
  const result = parseTaskResult(task.result_json);
  const journey = result.journey || {};
  return {
    scan_id: result.scanId || null,
    journey: {
      stage: journey.stage || null,
      total: Number(journey.total) || 0,
      settled: Number(journey.settled) || 0,
      reading: Number(journey.reading) || 0,
      verifying: Number(journey.verifying) || 0,
      resume_at: journey.resumeAt || null,
    },
    source_errors: Array.isArray(result.errors) ? result.errors.slice(0, 6).map(String) : [],
  };
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
    kind: job.kind || "manual",
    created_at: job.created_at || null,
    finished_at: job.finished_at || null,
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
      started_at: task.started_at || null,
      finished_at: task.finished_at || null,
      ...taskDigest(task),
    })),
  };
}

const TASK_COLUMNS = `mayor_id, status, stage, detail, attempts, result_json, error, started_at, finished_at`;

/** مصادر هذه المهمة وحالة كل منها (queued → polling → polled | failed). */
async function jobSources(env, jobId) {
  const { results } = await env.DB.prepare(
    `SELECT scan_id, source_id, mayor_id, status, detail FROM scan_sources WHERE job_id = ?`,
  )
    .bind(jobId)
    .all();
  return (results || []).map((row) => {
    const source = sourceById(row.source_id);
    return {
      scan_id: row.scan_id,
      mayor_id: row.mayor_id,
      source_id: row.source_id,
      domain: source?.domain || String(row.source_id).split(":").slice(1).join(":"),
      name: source?.name || "",
      tier: source?.tier ?? null,
      status: row.status,
      detail: row.detail || "",
    };
  });
}

/**
 * لقطة المهمة. مع detail تُضاف المصادر والقمع، وهما أثقل قليلًا، فتُطلبان بوتيرة
 * أبطأ من لقطة التقدم الأساسية.
 */
export async function readSearchJob(env, jobId, { detail = false } = {}) {
  const job = await env.DB.prepare(`SELECT * FROM search_jobs WHERE id = ?`).bind(jobId).first();
  if (!job) return null;
  const { results } = await env.DB.prepare(
    `SELECT ${TASK_COLUMNS} FROM search_job_tasks WHERE job_id = ? ORDER BY mayor_id`,
  )
    .bind(jobId)
    .all();
  const snapshot = searchJobSnapshot(job, results || [], await listMayors(env));
  if (!detail) return snapshot;
  const sources = await jobSources(env, jobId);
  const scanIds = [...sources.map((row) => row.scan_id), ...snapshot.tasks.map((task) => task.scan_id)];
  return { ...snapshot, sources, funnel: await journeyFunnel(env, scanIds) };
}

export async function latestSearchJobId(env) {
  const row = await env.DB.prepare(`SELECT id FROM search_jobs ORDER BY created_at DESC, rowid DESC LIMIT 1`).first();
  return row?.id || null;
}

/** آخر مهام الرصد، لسجل الرحلات. لقطات خفيفة بلا مصادر ولا قمع. */
export async function recentSearchJobs(env, limit = 8) {
  const take = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const { results: jobs } = await env.DB.prepare(
    `SELECT * FROM search_jobs ORDER BY created_at DESC, rowid DESC LIMIT ?`,
  )
    .bind(take)
    .all();
  if (!jobs?.length) return [];
  const ids = jobs.map((job) => job.id);
  const { results: tasks } = await env.DB.prepare(
    `SELECT job_id, ${TASK_COLUMNS} FROM search_job_tasks WHERE job_id IN (${ids.map(() => "?").join(", ")})`,
  )
    .bind(...ids)
    .all();
  const mayors = await listMayors(env);
  return jobs.map((job) => {
    const snapshot = searchJobSnapshot(job, (tasks || []).filter((task) => task.job_id === job.id), mayors);
    const light = { ...snapshot, offices: snapshot.tasks.length };
    delete light.tasks;
    return light;
  });
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
