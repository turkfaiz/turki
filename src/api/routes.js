import {
  attentionReasonCaseSql,
  deskLaneCaseSql,
  deskLanePredicateSql,
  inDisplayWindowSql,
  planDeskLaneMigration,
  resolveDeskQuery,
} from "../deskLanes.js";
import {
  insertCustomMayor,
  listMayors,
  mayorInputMessage,
  parseMayorInput,
} from "../mayors.js";
import { REASON } from "../reasons.js";
import { reviewInbox } from "../reviewAgent.js";
import { MAX_SOURCES_PER_OFFICE, registeredSourcesSql } from "../sources.js";
import { assignPendingLanes, briefBacklog, translatePending } from "../translate.js";
import {
  currentVersion,
  decisionsFor,
  isReadyForApproval,
  protectedItemsSql,
  recordDecision,
} from "../versions.js";
import { json, readBody, reviewerOf } from "./http.js";
import {
  diagnostics,
  publicSlotStatus,
  setSourceEnabled,
  settingsOffices,
  slotOverview,
  stats,
} from "./status.js";
import { shouldContinueBriefs } from "../jobs/continuation.js";
import { drainBriefs, enqueueAllOffices } from "../jobs/desk.js";
import {
  enqueueBriefContinuation,
  enqueueBriefPump,
  enqueueManualSearch,
} from "../jobs/enqueue.js";
import { readSearchJob } from "../jobs/searchJob.js";

const ITEM_FIELDS = `items.id, items.mayor_id, items.scan_id, items.source, items.title,
  items.title_ar AS news_title_ar, items.snippet, items.snippet_ar AS news_snippet_ar,
  items.title_normalized, items.url, items.published_at, items.language, items.confidence,
  items.status, items.exclude_reason, items.fingerprint, items.created_at, items.trans_engine,
  items.publisher_domain, items.publisher_tier, items.merged_sources, items.source_count,
  items.brief_evidence, items.brief_error, items.brief_attempted_at, items.brief_attempts,
  items.brief_provider, items.current_version_id, items.approved_version_id, items.needs_review,
  (SELECT verify_state FROM brief_versions
    WHERE brief_versions.id = items.current_version_id) AS verify_state,
  (SELECT verify_detail FROM brief_versions
    WHERE brief_versions.id = items.current_version_id) AS verify_detail,
  ${deskLaneCaseSql("items")} AS desk_lane,
  ${attentionReasonCaseSql("items")} AS attention_reason,
  mayors.name_ar, mayors.name_en, mayors.name_native, mayors.city_ar, mayors.country_ar,
  mayors.title_ar AS office_ar, mayors.title_en, mayors.official_host, mayors.native_lang_ar`;

export async function handleApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === "/api/mayors" && method === "GET") {
    return json({ mayors: await listMayors(env) });
  }

  if (path === "/api/diagnostics" && method === "GET") {
    return json(await diagnostics(env));
  }

  const retryMatch = path.match(/^\/api\/items\/([0-9a-f-]+)\/retry-brief$/i);
  if (retryMatch && method === "POST") {
    await env.DB.prepare(
      `UPDATE items
       SET brief_attempts = 0, brief_error = NULL, brief_attempted_at = NULL,
           brief_claim_id = NULL, brief_claimed_at = NULL, brief_provider = NULL,
           trans_engine = 'brief-pending'
       WHERE id = ?`,
    )
      .bind(retryMatch[1])
      .run();
    const summary = await translatePending(env, 1, null);
    if (shouldContinueBriefs(summary)) await enqueueBriefContinuation(env, null, null);
    return json({ ok: true, ai: summary });
  }

  if (path === "/api/sources" && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT sources.*, mayors.name_ar, mayors.city_ar
       FROM sources JOIN mayors ON mayors.id = sources.mayor_id
       WHERE ${registeredSourcesSql("sources.id")}
       ORDER BY sources.mayor_id, sources.rank`,
    ).all();
    return json({ sources: results || [], perOffice: MAX_SOURCES_PER_OFFICE });
  }

  if (path === "/api/settings/offices" && method === "GET") {
    return json({ offices: await settingsOffices(env) });
  }

  const toggleMatch = path.match(/^\/api\/settings\/sources\/([^/]+)$/i);
  if (toggleMatch && method === "POST") {
    const body = await readBody(request);
    if (typeof body.enabled !== "boolean") {
      return json({ error: "enabled_required" }, 400);
    }
    if (body.domain || body.url) {
      return json({ error: "registry_closed", detail: "لا تُضاف النطاقات من الواجهة." }, 403);
    }
    const result = await setSourceEnabled(
      env,
      decodeURIComponent(toggleMatch[1]),
      body.enabled,
      reviewerOf(request, env),
    );
    if (result.error) return json(result, result.status || 400);
    return json(result);
  }

  if (path === "/api/settings/mayors" && method === "POST") {
    const body = await readBody(request);
    if (body.domain || body.url || body.discovery || body.sources) {
      return json(
        {
          error: "registry_closed",
          message: "لا يمكن إضافة منصة أو نطاق رصد من الواجهة — أضف هوية العمدة فقط.",
        },
        403,
      );
    }
    const parsed = parseMayorInput(body);
    if (parsed.error) {
      return json(
        { error: parsed.error, detail: parsed.detail || null, message: mayorInputMessage(parsed) },
        400,
      );
    }
    const existing = await env.DB.prepare(`SELECT id FROM mayors WHERE id = ?`)
      .bind(parsed.mayor.id)
      .first();
    if (existing) {
      return json({ error: "duplicate_id", message: "معرّف العمدة مستخدم مسبقاً" }, 409);
    }
    const mayor = await insertCustomMayor(env, parsed.mayor);
    await env.DB.prepare(
      `INSERT INTO settings_audit (id, actor, action, source_id, mayor_id, before_json, after_json)
       VALUES (?, ?, 'mayor_created', NULL, ?, NULL, ?)`,
    )
      .bind(crypto.randomUUID(), reviewerOf(request, env), mayor.id, JSON.stringify(mayor))
      .run();
    return json(
      {
        ok: true,
        mayor,
        note: "أُضيفت هوية العمدة فقط. المنصات تُفعَّل من السجل المغلق في الكود إن وُجدت.",
        offices: await settingsOffices(env),
      },
      201,
    );
  }

  if (path === "/api/admin/migrations/desk-lanes" && method === "GET") {
    const stored = await env.DB.prepare(
      `SELECT v FROM meta WHERE k = 'desk_lane_migration_report'`,
    ).first();
    let lastApplied = null;
    try {
      lastApplied = stored?.v ? JSON.parse(stored.v) : null;
    } catch {
      lastApplied = null;
    }
    return json({
      dryRun: true,
      plan: await planDeskLaneMigration(env),
      lastApplied,
    });
  }

  if (path === "/api/stats" && method === "GET") {
    return json(await stats(env));
  }

  if (path === "/api/scans" && method === "GET") {
    const { results } = await env.DB.prepare(`SELECT * FROM scans ORDER BY started_at DESC LIMIT 20`).all();
    return json({ scans: results });
  }

  const jobMatch = path.match(/^\/api\/search-jobs\/([0-9a-f-]+)$/i);
  if (jobMatch && method === "GET") {
    const job = await readSearchJob(env, jobMatch[1]);
    if (!job) return json({ error: "not_found" }, 404);
    return json({ job });
  }

  if (path === "/api/items" && method === "GET") {
    const rawStatus = url.searchParams.get("status") || "inbox";
    const laneParam = url.searchParams.get("lane");
    const resolved = resolveDeskQuery(rawStatus, laneParam);
    if (resolved.kind === "invalid") {
      return json({ error: "bad_status", requested: resolved.requested }, 400);
    }
    const mayorId = url.searchParams.get("mayor_id");
    const q = url.searchParams.get("q");
    const clauses = [];
    const binds = [];
    if (resolved.kind === "lane") {
      clauses.push("items.status = 'inbox'");
      clauses.push(inDisplayWindowSql("items"));
      clauses.push(deskLanePredicateSql(resolved.value, "items"));
    } else {
      clauses.push("items.status = ?");
      binds.push(resolved.value);
      clauses.push(inDisplayWindowSql("items"));
    }
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
    return json({
      items: results,
      lane: resolved.kind === "lane" ? resolved.value : null,
      status: resolved.kind === "status" ? resolved.value : "inbox",
    });
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
    const itemId = statusMatch[1];
    const version = await currentVersion(env, itemId);

    /**
     * الاعتماد قرار على محتوى بعينه. موجز لم يجتز التدقيق الدلالي ليس جاهزًا،
     * فمنعه هنا أصدق من عرضه ثم تبرير قرار بُني على ادعاء غير مثبت.
     */
    if (status === "approved" && !isReadyForApproval(version)) {
      return json(
        {
          error: "brief_not_verified",
          verify_state: version?.verify_state || "missing",
          detail: version
            ? "لم يجتز الموجز التدقيق الدلالي بعد."
            : "لا يوجد موجز محفوظ لهذا الخبر.",
        },
        409,
      );
    }

    const reason = status === "excluded" ? REASON.MANUAL : null;
    await env.DB.prepare(`UPDATE items SET status = ?, exclude_reason = ? WHERE id = ?`)
      .bind(status, reason, itemId)
      .run();

    if (version && status !== "inbox") {
      const source = await env.DB.prepare(`SELECT article_text FROM items WHERE id = ?`)
        .bind(itemId)
        .first();
      await recordDecision(env, {
        itemId,
        version,
        decision: status,
        reviewer: reviewerOf(request, env),
        note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
        sourceText: source?.article_text || "",
      });
    }
    return json({ ok: true, version_id: version?.id || null });
  }

  const decisionsMatch = path.match(/^\/api\/items\/([0-9a-f-]+)\/decisions$/i);
  if (decisionsMatch && method === "GET") {
    return json({ decisions: await decisionsFor(env, decisionsMatch[1]) });
  }

  if (path === "/api/review" && method === "POST") {
    const body = await readBody(request);
    const mayorId = body.mayor_id || null;
    const result = await reviewInbox(env, { mayorId, limit: 500, useAiMerge: false });
    await assignPendingLanes(env, mayorId);
    const backlog = await briefBacklog(env, mayorId);
    if (backlog.pending > 0) await enqueueBriefPump(env);
    return json({ ok: true, ...result, ai: backlog });
  }

  if (path === "/api/admin/reset" && method === "POST") {
    const body = await readBody(request);
    if (body.confirm !== "احذف كل الأخبار") {
      return json(
        {
          error: "confirmation_required",
          detail: 'أرسل confirm بالقيمة "احذف كل الأخبار" لتأكيد الحذف.',
        },
        400,
      );
    }
    // القرارات المحفوظة أرشيف، فلا يمسّها إجراء تنظيف الأخبار.
    const removed = await env.DB.prepare(
      `DELETE FROM items WHERE NOT ${protectedItemsSql()}`,
    ).run();
    await env.DB.prepare(`DELETE FROM scans`).run();
    await env.DB.prepare(`DELETE FROM search_job_tasks`).run();
    await env.DB.prepare(`DELETE FROM search_jobs`).run();
    return json({
      ok: true,
      removedItems: Number(removed?.meta?.changes) || 0,
      keptDecided: Number(
        (await env.DB.prepare(`SELECT COUNT(*) AS n FROM items`).first())?.n || 0,
      ),
      by: reviewerOf(request, env),
    });
  }

  if (path === "/api/briefs/drain" && method === "POST") {
    const drained = await drainBriefs(env);
    const overview = await slotOverview(env);
    return json({
      ok: true,
      ...drained,
      budget: overview.budget,
      slots: overview.slots.map((slot) => publicSlotStatus(slot)),
    });
  }

  if (path === "/api/search" && method === "POST") {
    const body = await readBody(request);
    const result = await enqueueManualSearch(env, {
      mayorId: body.mayor_id || null,
      query: body.q || "",
    });
    return json({ ok: true, ...result }, 202);
  }

  if (path === "/api/scan/weekly" && method === "POST") {
    const result = await enqueueAllOffices(env);
    return json({ ok: true, ...result });
  }

  return json({ error: "not_found" }, 404);
}
