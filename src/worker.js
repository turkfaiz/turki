import { MAYORS } from "./mayors.js";
import { runScan, sourceStatus } from "./collect.js";
import { translatePending } from "./translate.js";

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
    created_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_items_mayor ON items(mayor_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_items_fingerprint ON items(fingerprint)`,
  `CREATE INDEX IF NOT EXISTS idx_scans_started ON scans(started_at DESC)`,
];

let ready = false;

async function ensureDb(env) {
  if (ready) return;
  for (const sql of SCHEMA_STATEMENTS) {
    await env.DB.prepare(sql).run();
  }
  const stmt = env.DB.prepare(
    `INSERT OR REPLACE INTO mayors (
      id, country_ar, city_ar, city_en, title_ar, title_en, name_en, name_native, name_ar,
      native_lang, native_lang_ar, country_code, gn_hl, gn_gl, official_host
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const batch = MAYORS.map((m) =>
    stmt.bind(
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
    ),
  );
  await env.DB.batch(batch);
  await migrateItems(env);
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
}

const ITEM_FIELDS = `items.id, items.mayor_id, items.scan_id, items.source, items.title,
  items.title_ar AS news_title_ar, items.snippet, items.snippet_ar AS news_snippet_ar,
  items.title_normalized, items.url, items.published_at, items.language, items.confidence,
  items.status, items.exclude_reason, items.fingerprint, items.created_at, items.trans_engine,
  mayors.name_ar, mayors.name_en, mayors.name_native, mayors.city_ar, mayors.country_ar,
  mayors.title_ar AS office_ar, mayors.title_en, mayors.official_host, mayors.native_lang_ar`;

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
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
    `SELECT COALESCE(SUM(duplicate_count), 0) AS duplicates,
            COALESCE(SUM(found_count), 0) AS found
     FROM scans WHERE started_at >= datetime('now', '-7 days')`,
  ).first();
  return {
    inbox: row?.inbox || 0,
    approved: row?.approved || 0,
    excluded: row?.excluded || 0,
    total: row?.total || 0,
    byMayor: byMayor.results || [],
    lastWeekly,
    lastManual,
    week: weekDup,
    sources: sourceStatus(env),
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
    const reason = status === "excluded" ? body.reason || "استبعاد يدوي من الموظف" : null;
    await env.DB.prepare(`UPDATE items SET status = ?, exclude_reason = ? WHERE id = ?`)
      .bind(status, reason, statusMatch[1])
      .run();
    return json({ ok: true });
  }

  if (path === "/api/translate" && method === "POST") {
    const n = await translatePending(env, 10);
    return json({ ok: true, translated: n });
  }

  if (path === "/api/search" && method === "POST") {
    const body = await readBody(request);
    const result = await runScan(env, {
      type: "manual",
      query: body.q || "",
      mayorId: body.mayor_id || null,
    });
    return json({ ok: true, ...result });
  }

  if (path === "/api/scan/weekly" && method === "POST") {
    const result = await runScan(env, { type: "weekly", query: "", mayorId: null });
    return json({ ok: true, ...result });
  }

  return json({ error: "not_found" }, 404);
}

export default {
  async fetch(request, env) {
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
    ctx.waitUntil(
      (async () => {
        await ensureDb(env);
        await runScan(env, { type: "weekly", query: "", mayorId: null });
      })(),
    );
  },
};
