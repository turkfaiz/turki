import { canonicalOriginal, detectTopic, eventMarkers } from "./brief.js";
import { tokenOverlap } from "./dedup.js";
import { isAboutMayor, mayorById } from "./mayors.js";
import { classifyItem } from "./publishers.js";
import { REASON } from "./reasons.js";
import { aiBriefEnabled, clusterWithGemini } from "./aiBrief.js";

const MAX_SOURCE_TEXT = 80000;
const MAX_MERGED_TEXT = 240000;

function clusterText(item) {
  return canonicalOriginal(item.title, item.snippet || "").headline;
}

function betterItem(a, b) {
  if ((a.status === "approved") !== (b.status === "approved")) {
    return a.status === "approved" ? a : b;
  }
  const tierA = a.publisher_tier == null ? 9 : Number(a.publisher_tier);
  const tierB = b.publisher_tier == null ? 9 : Number(b.publisher_tier);
  if (tierA !== tierB) return tierA < tierB ? a : b;
  if ((a.source === "official") !== (b.source === "official")) {
    return a.source === "official" ? a : b;
  }
  return String(b.published_at || b.created_at || "") > String(a.published_at || a.created_at || "")
    ? b
    : a;
}

function eventNumbers(text) {
  return new Set(String(text || "").match(/\b\d+\b/g) || []);
}

function compatibleNumbers(a, b) {
  const left = eventNumbers(a);
  const right = eventNumbers(b);
  if (!left.size || !right.size) return true;
  return [...left].some((number) => right.has(number));
}

export function clusterInboxItems(items) {
  const groups = [];
  for (const item of items) {
    const seed = clusterText(item);
    const blob = `${item.title} ${item.snippet || ""}`;
    const topic = detectTopic(blob);
    const markers = eventMarkers(item.title, item.snippet || "");
    let group = groups.find((g) => {
      if (g.mayor_id !== item.mayor_id) return false;
      if (item.url && g.urls.has(item.url)) return true;
      const overlap = tokenOverlap(g.seed, seed);
      if (!compatibleNumbers(g.seed, seed)) return false;
      if (overlap >= 0.68) return true;
      if (g.place && markers.place && g.place === markers.place && overlap >= 0.55) return true;
      if (
        topic &&
        g.topic_id === topic.id &&
        g.action &&
        markers.action &&
        g.action === markers.action &&
        overlap >= 0.58
      ) {
        return true;
      }
      return false;
    });
    if (!group) {
      group = {
        mayor_id: item.mayor_id,
        seed,
        topic_id: topic?.id || null,
        action: markers.action || topic?.id || "",
        place: markers.place || "",
        urls: new Set(item.url ? [item.url] : []),
        members: [],
      };
      groups.push(group);
    }
    group.members.push(item);
    if (item.url) group.urls.add(item.url);
    if (!group.topic_id && topic) group.topic_id = topic.id;
    if (!group.place && markers.place) group.place = markers.place;
    if (!group.action && markers.action) group.action = markers.action;
  }
  return groups;
}

function trustItem(item) {
  const mayor = mayorById(item.mayor_id);
  if (!mayor) {
    return { item, status: "excluded", reason: REASON.UNTRUSTED, stamp: null };
  }
  if (item.publisher_tier == 0 || item.publisher_tier == 1) {
    return {
      item: { ...item, publisher_tier: Number(item.publisher_tier) },
      status: "inbox",
      reason: null,
      stamp: null,
    };
  }
  const verdict = classifyItem(
    {
      title: item.title,
      snippet: item.snippet,
      url: item.url,
      publisher_url: item.publisher_url,
      source: item.source || "google_news",
      page_body: item.article_text,
    },
    mayor,
  );
  return {
    item: {
      ...item,
      publisher_domain: verdict.publisher_domain,
      publisher_tier: verdict.publisher_tier,
    },
    status: verdict.status,
    reason: verdict.exclude_reason,
    stamp: { id: item.id, domain: verdict.publisher_domain, tier: verdict.publisher_tier },
  };
}

/**
 * Deterministic inbox agent: no LLM, no view-counts, no junk hosts as winners.
 * Legacy Google-wrapped rows are re-identified from the outlet suffix, then:
 * 1) untrusted publishers → مصدر غير معتمد
 * 2) not about the selected mayor → غير متعلق بالعمدة المختار
 * 3) same event cluster → keep best publisher, rest تكرار لنفس الحدث
 */
export function planInboxReview(items, groupsOverride = null) {
  const exclude = [];
  const trusted = [];
  const stamps = [];

  for (const raw of items) {
    const judged = trustItem(raw);
    if (judged.stamp) stamps.push(judged.stamp);
    if (judged.status === "excluded" || judged.item.publisher_tier == null || Number(judged.item.publisher_tier) > 1) {
      exclude.push({ id: raw.id, reason: judged.reason || REASON.UNTRUSTED });
      continue;
    }
    const mayor = mayorById(raw.mayor_id);
    if (mayor && !isAboutMayor(`${raw.title} ${raw.snippet || ""} ${raw.article_text || ""}`, mayor)) {
      exclude.push({ id: raw.id, reason: REASON.UNRELATED });
      continue;
    }
    trusted.push(judged.item);
  }

  const groups = groupsOverride || clusterInboxItems(trusted);
  const kept = [];
  const merges = [];
  for (const group of groups) {
    const winner = group.members.reduce(betterItem);
    kept.push(winner.id);
    merges.push({ winnerId: winner.id, members: group.members });
    for (const member of group.members) {
      if (member.id !== winner.id) {
        exclude.push({ id: member.id, reason: REASON.DUPLICATE });
      }
    }
  }

  return {
    reviewed: items.length,
    groups: groups.length,
    kept: kept.length,
    exclude,
    merges,
    stamps,
    trusted,
    excluded: exclude.length,
    untrusted: exclude.filter((x) => x.reason === REASON.UNTRUSTED).length,
    unrelated: exclude.filter((x) => x.reason === REASON.UNRELATED).length,
    duplicates: exclude.filter((x) => x.reason === REASON.DUPLICATE).length,
  };
}

async function applyExclusions(env, exclude) {
  if (!exclude.length) return;
  const stmt = env.DB.prepare(
    `UPDATE items SET status = 'excluded', exclude_reason = ? WHERE id = ? AND status = 'inbox'`,
  );
  for (let i = 0; i < exclude.length; i += 40) {
    const chunk = exclude.slice(i, i + 40);
    await env.DB.batch(chunk.map((row) => stmt.bind(row.reason, row.id)));
  }
}

async function applyStamps(env, stamps) {
  if (!stamps.length) return;
  const stmt = env.DB.prepare(`UPDATE items SET publisher_domain = ?, publisher_tier = ? WHERE id = ?`);
  for (let i = 0; i < stamps.length; i += 40) {
    const chunk = stamps.slice(i, i + 40);
    await env.DB.batch(chunk.map((row) => stmt.bind(row.domain, row.tier, row.id)));
  }
}

function sourceRows(item) {
  let rows = [];
  try {
    const parsed = JSON.parse(item.merged_sources || "[]");
    if (Array.isArray(parsed)) rows = parsed;
  } catch {
    rows = [];
  }
  if (!rows.length) {
    rows.push({
      source: item.source,
      domain: item.publisher_domain,
      url: item.url,
      title: item.title,
      published_at: item.published_at,
    });
  }
  return rows;
}

export function mergeRecord(group) {
  const winner = group.members.find((item) => item.id === group.winnerId);
  const sources = [];
  const sourceKeys = new Set();
  const textSections = [];
  const textKeys = new Set();

  for (const item of group.members) {
    for (const source of sourceRows(item)) {
      const key = source.url || `${source.domain || ""}|${source.title || ""}`;
      if (!key || sourceKeys.has(key)) continue;
      sourceKeys.add(key);
      sources.push(source);
    }
    const text = String(item.article_text || item.snippet || "").replace(/\s+/g, " ").trim();
    const key = text.slice(0, 160).toLowerCase();
    if (!text || textKeys.has(key)) continue;
    textKeys.add(key);
    textSections.push(
      `[${item.publisher_domain || item.source || "source"}] ${item.title}\n${text.slice(0, MAX_SOURCE_TEXT)}`,
    );
  }

  return {
    id: winner.id,
    articleText: textSections.join("\n\n").slice(0, MAX_MERGED_TEXT),
    mergedSources: JSON.stringify(sources.slice(0, 20)),
    sourceCount: sources.length || 1,
  };
}

async function applyMerges(env, merges) {
  if (!merges.length) return;
  const stmt = env.DB.prepare(
    `UPDATE items
     SET article_text = ?, merged_sources = ?, source_count = ?,
         confidence = CASE WHEN source = 'official' THEN confidence ELSE ? END,
         trans_engine = CASE WHEN source_count <> ? THEN 'brief-radar' ELSE trans_engine END,
         brief_evidence = CASE WHEN source_count <> ? THEN NULL ELSE brief_evidence END,
         brief_error = NULL
     WHERE id = ?`,
  );
  const records = merges.map(mergeRecord);
  for (let i = 0; i < records.length; i += 30) {
    const chunk = records.slice(i, i + 30);
    await env.DB.batch(
      chunk.map((row) =>
        stmt.bind(
          row.articleText,
          row.mergedSources,
          row.sourceCount,
          row.sourceCount > 1 ? "merged" : "raw",
          row.sourceCount,
          row.sourceCount,
          row.id,
        ),
      ),
    );
  }
}

export async function reviewInbox(env, { mayorId = null, limit = 500 } = {}) {
  const clauses = ["status IN ('inbox', 'approved')"];
  const binds = [];
  if (mayorId) {
    clauses.push("mayor_id = ?");
    binds.push(mayorId);
  }
  binds.push(limit);
  const { results } = await env.DB.prepare(
    `SELECT id, mayor_id, title, snippet, article_text, merged_sources, source_count, status,
            source, url, publisher_tier, publisher_domain, published_at, created_at
     FROM items WHERE ${clauses.join(" AND ")}
     ORDER BY COALESCE(published_at, created_at) DESC
     LIMIT ?`,
  )
    .bind(...binds)
    .all();

  let plan = planInboxReview(results || []);
  if (aiBriefEnabled(env) && plan.trusted.length > 1) {
    const byMayor = new Map();
    for (const item of plan.trusted) {
      if (!byMayor.has(item.mayor_id)) byMayor.set(item.mayor_id, []);
      byMayor.get(item.mayor_id).push(item);
    }
    const groups = [];
    for (const [id, items] of byMayor) {
      if (items.length < 2) {
        groups.push({ members: items });
        continue;
      }
      try {
        groups.push(...((await clusterWithGemini(env, items, mayorById(id))) || clusterInboxItems(items)));
      } catch {
        groups.push(...clusterInboxItems(items));
      }
    }
    plan = planInboxReview(results || [], groups);
  }
  await applyStamps(env, plan.stamps);
  await applyMerges(env, plan.merges);
  await applyExclusions(env, plan.exclude);
  return {
    reviewed: plan.reviewed,
    groups: plan.groups,
    kept: plan.kept,
    excluded: plan.excluded,
    untrusted: plan.untrusted,
    unrelated: plan.unrelated,
    duplicates: plan.duplicates,
  };
}
