import { canonicalOriginal, detectTopic } from "./brief.js";
import { isRelevant, tokenOverlap } from "./dedup.js";
import { mayorById, relevanceTokens } from "./mayors.js";
import { REASON } from "./reasons.js";

function clusterText(item) {
  return canonicalOriginal(item.title, item.snippet || "").headline;
}

function betterItem(a, b) {
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

export function clusterInboxItems(items) {
  const groups = [];
  for (const item of items) {
    const seed = clusterText(item);
    const topic = detectTopic(`${item.title} ${item.snippet || ""}`);
    let group = groups.find((g) => {
      if (g.mayor_id !== item.mayor_id) return false;
      const overlap = tokenOverlap(g.seed, seed);
      if (overlap >= 0.55) return true;
      if (topic && g.topic_id === topic.id && overlap >= 0.32) return true;
      return false;
    });
    if (!group) {
      group = {
        mayor_id: item.mayor_id,
        seed,
        topic_id: topic?.id || null,
        members: [],
      };
      groups.push(group);
    }
    group.members.push(item);
    if (!group.topic_id && topic) group.topic_id = topic.id;
  }
  return groups;
}

/**
 * Deterministic inbox agent: no LLM, no view-counts, no junk hosts as winners.
 * 1) leftover untrusted publishers → مصدر غير معتمد
 * 2) not about the selected mayor → غير متعلق بالعمدة المختار
 * 3) same event cluster → keep best publisher, rest تكرار لنفس الحدث
 */
export function planInboxReview(items) {
  const exclude = [];
  const trusted = [];

  for (const item of items) {
    const tier = item.publisher_tier;
    if (tier == null || Number(tier) > 1) {
      exclude.push({ id: item.id, reason: REASON.UNTRUSTED });
      continue;
    }
    const mayor = mayorById(item.mayor_id);
    const tokens = mayor ? relevanceTokens(mayor) : [];
    if (mayor && !isRelevant(`${item.title} ${item.snippet || ""}`, tokens)) {
      exclude.push({ id: item.id, reason: REASON.UNRELATED });
      continue;
    }
    trusted.push(item);
  }

  const groups = clusterInboxItems(trusted);
  const kept = [];
  for (const group of groups) {
    const winner = group.members.reduce(betterItem);
    kept.push(winner.id);
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

export async function reviewInbox(env, { mayorId = null, limit = 200 } = {}) {
  const clauses = ["status = 'inbox'"];
  const binds = [];
  if (mayorId) {
    clauses.push("mayor_id = ?");
    binds.push(mayorId);
  }
  binds.push(limit);
  const { results } = await env.DB.prepare(
    `SELECT id, mayor_id, title, snippet, source, publisher_tier, publisher_domain,
            published_at, created_at
     FROM items WHERE ${clauses.join(" AND ")}
     ORDER BY COALESCE(published_at, created_at) DESC
     LIMIT ?`,
  )
    .bind(...binds)
    .all();

  const plan = planInboxReview(results || []);
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
