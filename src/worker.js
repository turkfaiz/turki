import { MAYORS } from "./mayors.js";
import { runScan, sourceStatus } from "./collect.js";
import { translatePending } from "./translate.js";
import { PUBLISHERS } from "./publishers.js";
import { reviewInbox } from "./reviewAgent.js";
import { REASON } from "./reasons.js";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS mayors (
    id TEXT PRIMARY KEY,
    country_ar TEXT NOT NULL,
    city_ar TEXT NOT NULL,
    city_en TEXT NOT NULL,
    title_ar TEXT NOT NULL,
    title_en TEXT NOT NULL,
    name_en TEXT NOT NULL,
    name_native TEXT NOT NULL,
    name_ar TEXT NOT NULL,
    native_lang TEXT NOT NULL,
    native_lang_ar TEXT NOT NULL,
    country_code TEXT NOT NULL,
    gn_hl TEXT NOT NULL,
    gn_gl TEXT NOT NULL,
    official_host TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    query TEXT,
    mayor_id TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    found_count INTEGER DEFAULT 0,
    duplicate_count INTEGER DEFAULT 0,
    excluded_count INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    notes TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    mayor_id TEXT NOT NULL,
    scan_id TEXT,
    source TEXT NOT NULL,
    title TEXT NOT NULL,
    title_normalized TEXT NOT NULL,
    url TEXT NOT NULL,
    published_at TEXT,
    snippet TEXT,
    title_ar TEXT,
    snippet_ar TEXT,
    language TEXT,
    confidence TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'inbox',
    exclude_reason TEXT,
    fingerprint TEXT NOT NULL,
    trans_engine TEXT,
    publisher_domain TEXT,
    publisher_tier INTEGER,
    article_text TEXT,
    source_documents TEXT,
    merged_sources TEXT,
    source_count INTEGER DEFAULT 1,
    brief_evidence TEXT,
    brief_error TEXT,
    brief_attempted_at TEXT,
    brief_attempts INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_items_mayor ON items(mayor_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_items_fingerprint ON items(fingerprint)`,
  `CREATE INDEX IF NOT EXISTS idx_scans_started ON scans(started_at DESC)`,
  `CREATE TABLE IF NOT EXISTS publishers (
    id TEXT PRIMARY KEY,
    domain TEXT NOT NULL,
    name TEXT NOT NULL,
    tier INTEGER NOT NULL,
    country_code TEXT,
    mayor_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_publishers_domain ON publishers(domain)`,
  `CREATE TABLE IF NOT EXISTS meta (
    k TEXT PRIMARY KEY,
    v TEXT
  )`,
];

let ready = false;
const BOOTSTRAP_VERSION = "bootstrap-v5";

async function upsertRows(env, prefix, rows, width, chunkSize) {
  const tuple = `(${Array.from({ length: width }, () => "?").join(", ")})`;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await env.DB.prepare(`${prefix} VALUES ${chunk.map(() => tuple).join(", ")}`)
      .bind(...chunk.flat())
      .run();
  }
}

async function ensureDb(env) {
  if (ready) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`).run();
  const bootstrapped = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'bootstrap_version'`).first();
  if (bootstrapped?.v === BOOTSTRAP_VERSION) {
    ready = true;
    return;
  }
  for (const sql of SCHEMA_STATEMENTS) {
    await env.DB.prepare(sql).run();
  }
  await upsertRows(
    env,
    `INSERT OR REPLACE INTO mayors (
      id, country_ar, city_ar, city_en, title_ar, title_en, name_en, name_native, name_ar,
      native_lang, native_lang_ar, country_code, gn_hl, gn_gl, official_host
    )`,
    MAYORS.map((m) => [
      m.id,
      m.country_ar,
      m.city_ar,
      m.city_en,
      m.title_ar,
      m.title_en,
      m.name_en,
      m.name_native,
      m.name_ar,
      m.native_lang,
      m.native_lang_ar,
      m.country_code,
      m.gn_hl,
      m.gn_gl,
      m.official_host,
    ]),
    15,
    6,
  );
  await upsertRows(
    env,
    `INSERT OR REPLACE INTO publishers (id, domain, name, tier, country_code, mayor_id)`,
    PUBLISHERS.map((p) => [
      p.id,
      p.domain,
      p.name,
      p.tier,
      p.country_code,
      p.mayor_id,
    ]),
    6,
    15,
  );
  await migrateItems(env);
  await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('bootstrap_version', ?)`)
    .bind(BOOTSTRAP_VERSION)
    .run();
  ready = true;
}

async function migrateItems(env) {
  const info = await env.DB.prepare(`PRAGMA table_info(items)`).all();
  const names = new Set((info.results || []).map((col) => col.name));
  if (!names.has("title_ar")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN title_ar TEXT`).run();
  }
  if (!names.has("snippet_ar")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN snippet_ar TEXT`).run();
  }
  if (!names.has("trans_engine")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN trans_engine TEXT`).run();
  }
  if (!names.has("publisher_domain")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN publisher_domain TEXT`).run();
  }
  if (!names.has("publisher_tier")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN publisher_tier INTEGER`).run();
  }
  if (!names.has("article_text")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN article_text TEXT`).run();
  }
  if (!names.has("source_documents")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN source_documents TEXT`).run();
  }
  if (!names.has("merged_sources")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN merged_sources TEXT`).run();
  }
  if (!names.has("source_count")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN source_count INTEGER DEFAULT 1`).run();
  }
  if (!names.has("brief_evidence")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN brief_evidence TEXT`).run();
  }
  if (!names.has("brief_error")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN brief_error TEXT`).run();
  }
  if (!names.has("brief_attempted_at")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN brief_attempted_at TEXT`).run();
  }
  if (!names.has("brief_attempts")) {
    await env.DB.prepare(`ALTER TABLE items ADD COLUMN brief_attempts INTEGER DEFAULT 0`).run();
  }
  await env.DB.prepare(
    `UPDATE items SET exclude_reason = ?
     WHERE status = 'excluded'
       AND IFNULL(exclude_reason, '') NOT IN (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      REASON.MANUAL,
      REASON.MANUAL,
      REASON.UNTRUSTED,
      REASON.UNRELATED,
      REASON.DUPLICATE,
      REASON.REVIEW,
      REASON.STALE,
    )
    .run();
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)`,
  ).run();
  const epoch = "week-verify-v1";
  const current = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'data_epoch'`).first();
  if (current?.v !== epoch) {
    await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('data_epoch', ?)`).bind(epoch).run();
  }
  const briefEpoch = "grounded-ai-v3";
  const currentBrief = await env.DB.prepare(`SELECT v FROM meta WHERE k = 'brief_epoch'`).first();
  if (currentBrief?.v !== briefEpoch) {
    await env.DB.prepare(
      `UPDATE items
       SET title_ar = 'بانتظار قراءة الذكاء الاصطناعي — ' ||
             COALESCE((SELECT name_ar FROM mayors WHERE mayors.id = items.mayor_id), mayor_id),
           snippet_ar = '', trans_engine = 'brief-pending',
           brief_evidence = NULL, brief_error = NULL
       WHERE status IN ('inbox', 'approved')
         AND IFNULL(trans_engine, '') NOT LIKE 'brief-ai-gemini-v2:%'`,
    ).run();
    await env.DB.prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES ('brief_epoch', ?)`)
      .bind(briefEpoch)
      .run();
  }
}

const ITEM_FIELDS = `items.id, items.mayor_id, items.scan_id, items.source, items.title,
  items.title_ar AS news_title_ar, items.snippet, items.snippet_ar AS news_snippet_ar,
  items.title_normalized, items.url, items.published_at, items.language, items.confidence,
  items.status, items.exclude_reason, items.fingerprint, items.created_at, items.trans_engine,
  items.publisher_domain, items.publisher_tier, items.merged_sources, items.source_count,
  items.brief_evidence, items.brief_error, items.brief_attempted_at, items.brief_attempts,
  mayors.name_ar, mayors.name_en, mayors.name_native, mayors.city_ar, mayors.country_ar,
  mayors.title_ar AS office_ar, mayors.title_en, mayors.official_host, mayors.native_lang_ar`;

/** مسار المكتب الوحيد: جمع → تحقق → دمج المصادر → تلخيص AI → قرار الموظف. */
async function finishDesk(env, scanOpts) {
  const result = await runScan(env, scanOpts);
  const review = await reviewInbox(env, { mayorId: scanOpts.mayorId || null, limit: 500 });
  const summarized = await translatePending(env, 12, scanOpts.mayorId || null);
  return { ...result, review, summarized };
}

async function finishAllOffices(env, type = "weekly") {
  const results = [];
  const errors = [];
  for (let i = 0; i < MAYORS.length; i += 2) {
    const chunk = MAYORS.slice(i, i + 2);
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
    });
  }
  return { offices: results.length, failed: errors.length, errors, results };
}

async function enqueueAllOffices(env, type = "weekly") {
  if (!env.SCAN_QUEUE) return finishAllOffices(env, type);
  await env.SCAN_QUEUE.sendBatch(
    MAYORS.map((mayor) => ({
      body: { type, mayorId: mayor.id },
      contentType: "json",
    })),
  );
  return { queued: MAYORS.length, type };
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function authorized(request, env) {
  if (!env.DASHBOARD_PASSWORD) return !env.GEMINI_API_KEY;
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const user = env.DASHBOARD_USER || "mayorwatch";
    return decoded === `${user}:${env.DASHBOARD_PASSWORD}`;
  } catch {
    return false;
  }
}

function authRequired() {
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="MayorWatch"',
      "Cache-Control": "no-store",
    },
  });
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function stats(env) {
  const row = await env.DB.prepare(
    `SELECT
      SUM(CASE WHEN status = 'inbox' THEN 1 ELSE 0 END) AS inbox,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
      SUM(CASE WHEN status = 'excluded' THEN 1 ELSE 0 END) AS excluded,
      COUNT(*) AS total
     FROM items`,
  ).first();
  const byMayor = await env.DB.prepare(
    `SELECT mayor_id, COUNT(*) AS total,
            SUM(CASE WHEN status = 'inbox' THEN 1 ELSE 0 END) AS inbox,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
            SUM(CASE WHEN status = 'excluded' THEN 1 ELSE 0 END) AS excluded
     FROM items GROUP BY mayor_id`,
  ).all();
  const lastWeekly = await env.DB.prepare(
    `SELECT * FROM scans WHERE type = 'weekly' ORDER BY started_at DESC LIMIT 1`,
  ).first();
  const lastManual = await env.DB.prepare(
    `SELECT * FROM scans WHERE type = 'manual' ORDER BY started_at DESC LIMIT 1`,
  ).first();
  const weekDup = await env.DB.prepare(
    `SELECT COUNT(*) AS duplicates
     FROM items
     WHERE exclude_reason = ?
       AND COALESCE(published_at, created_at) >= datetime('now', '-7 days')`,
  )
    .bind(REASON.DUPLICATE)
    .first();
  const weekFound = await env.DB.prepare(
    `SELECT COUNT(*) AS found
     FROM items
     WHERE COALESCE(published_at, created_at) >= datetime('now', '-7 days')`,
  ).first();
  return {
    inbox: row?.inbox || 0,
    approved: row?.approved || 0,
    excluded: row?.excluded || 0,
    total: row?.total || 0,
    byMayor: byMayor.results || [],
    lastWeekly,
    lastManual,
    week: { duplicates: weekDup?.duplicates || 0, found: weekFound?.found || 0 },
    sources: {
      ...sourceStatus(env),
      ai_brief: env.GEMINI_API_KEY ? "ready" : "unconfigured",
    },
  };
}

async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/health" && method === "GET") {
    return json({ ok: true, cron: "Sunday 06:00 Asia/Riyadh" });
  }

  if (path === "/api/mayors" && method === "GET") {
    const { results } = await env.DB.prepare(`SELECT * FROM mayors ORDER BY country_ar, city_ar`).all();
    return json({ mayors: results });
  }

  if (path === "/api/stats" && method === "GET") {
    return json(await stats(env));
  }

  if (path === "/api/scans" && method === "GET") {
    const { results } = await env.DB.prepare(`SELECT * FROM scans ORDER BY started_at DESC LIMIT 20`).all();
    return json({ scans: results });
  }

  if (path === "/api/items" && method === "GET") {
    const status = url.searchParams.get("status") || "inbox";
    const mayorId = url.searchParams.get("mayor_id");
    const q = url.searchParams.get("q");
    const clauses = ["status = ?"];
    const binds = [status];
    if (mayorId) {
      clauses.push("mayor_id = ?");
      binds.push(mayorId);
    }
    if (q) {
      clauses.push("(title LIKE ? OR snippet LIKE ?)");
      binds.push(`%${q}%`, `%${q}%`);
    }
    const sql = `SELECT ${ITEM_FIELDS}
                 FROM items JOIN mayors ON mayors.id = items.mayor_id
                 WHERE ${clauses.join(" AND ")}
                 ORDER BY COALESCE(items.published_at, items.created_at) DESC
                 LIMIT 200`;
    const { results } = await env.DB.prepare(sql).bind(...binds).all();
    return json({ items: results });
  }

  const itemMatch = path.match(/^\/api\/items\/([0-9a-f-]+)$/i);
  if (itemMatch && method === "GET") {
    const row = await env.DB.prepare(
      `SELECT ${ITEM_FIELDS}
       FROM items JOIN mayors ON mayors.id = items.mayor_id WHERE items.id = ?`,
    )
      .bind(itemMatch[1])
      .first();
    if (!row) return json({ error: "not_found" }, 404);
    return json({ item: row });
  }

  const statusMatch = path.match(/^\/api\/items\/([0-9a-f-]+)\/status$/i);
  if (statusMatch && method === "POST") {
    const body = await readBody(request);
    const status = body.status;
    if (!["inbox", "approved", "excluded"].includes(status)) {
      return json({ error: "bad_status" }, 400);
    }
    const reason = status === "excluded" ? REASON.MANUAL : null;
    await env.DB.prepare(`UPDATE items SET status = ?, exclude_reason = ? WHERE id = ?`)
      .bind(status, reason, statusMatch[1])
      .run();
    return json({ ok: true });
  }

  if (path === "/api/review" && method === "POST") {
    const body = await readBody(request);
    const result = await reviewInbox(env, { mayorId: body.mayor_id || null, limit: 500 });
    const translated = await translatePending(env, 12, body.mayor_id || null);
    return json({ ok: true, translated, ...result });
  }

  if (path === "/api/search" && method === "POST") {
    const body = await readBody(request);
    const mayorId = body.mayor_id || null;
    if (!mayorId) {
      return json({ error: "mayor_required", message: "اختر مكتب عمدة ثم ابحث. المسار اليدوي لمكتب واحد." }, 400);
    }
    const result = await finishDesk(env, {
      type: "manual",
      query: body.q || "",
      mayorId,
    });
    return json({ ok: true, ...result });
  }

  if (path === "/api/scan/weekly" && method === "POST") {
    const result = await enqueueAllOffices(env);
    return json({ ok: true, ...result });
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
    if (!authorized(request, env)) return authRequired();
    await ensureDb(env);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await handleApi(request, env);
      } catch (err) {
        return json({ error: "server_error", message: String(err.message || err) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(enqueueAllOffices(env));
  },

  async queue(batch, env) {
    await ensureDb(env);
    for (const message of batch.messages) {
      try {
        const body = message.body || {};
        const mayorId = body.mayorId;
        if (!mayorId || !MAYORS.some((mayor) => mayor.id === mayorId)) {
          message.ack();
          continue;
        }
        await finishDesk(env, {
          type: body.type || "weekly",
          query: "",
          mayorId,
        });
        message.ack();
      } catch {
        message.retry();
      }
    }
  },
};
