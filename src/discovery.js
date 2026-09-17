/**
 * اكتشاف مصدر واحد: RSS ثم الغرفة ثم Sitemap/API ثم بحث داخلي مختبر ثم المتصفح.
 * عدم وجود خبر جديد ليس عطلًا. فشل الاتصال أو فساد التغذية أو توقفها ينقل للاستراتيجية التالية.
 */
import { isWithinWeek, parseDate } from "./time.js";
import { parseFeed } from "./rss.js";
import { extractArticleLinks, inspectListingPage, parseWpJson, materializeHashParams } from "./newsroom.js";
import { childSitemaps, isSitemapIndex, parseSitemap } from "./sitemap.js";
import {
  FEED_STALE_DAYS,
  SOURCE_POLL_MAX_REQUESTS,
  isApprovedUrl,
  sourceById,
} from "./sources.js";
import { governedFetch, looksLikeErrorPage } from "./governedFetch.js";

export const STAGES = {
  SOURCE_POLL: "source_poll",
  CANDIDATE_DISCOVERED: "candidate_discovered",
  ARTICLE_FETCH: "article_fetch",
  RELEVANCE_CHECK: "relevance_check",
  DEDUPLICATION: "deduplication",
  AI_BRIEF: "ai_brief",
  SEMANTIC_VERIFICATION: "semantic_verification",
  STAFF_REVIEW: "staff_review",
};

function emptyHealth(source) {
  return {
    id: source.id,
    mayor_id: source.mayor_id,
    ok: false,
    status: "unchecked",
    connect_status: "unchecked",
    http_status: null,
    parse_status: "",
    items: 0,
    discovered: 0,
    new_count: 0,
    read_count: 0,
    relevant_count: 0,
    fail_reason: "",
    last_strategy: "",
    last_discovered_url: "",
    etag: "",
    last_modified: "",
    ms: 0,
  };
}

function rowFromLink(source, mayor, link, discoveryType) {
  const url = materializeHashParams(link.url);
  return {
    title: link.title || url,
    url,
    snippet: link.snippet || "",
    published_at: link.published_at || "",
    source: source.tier === 0 ? "official" : `approved_${discoveryType}`,
    language: mayor.native_lang,
    publisher_url: url,
    registry_id: source.id,
    discovery_type: discoveryType,
  };
}

function newestDate(items) {
  let newest = null;
  for (const item of items) {
    const parsed = parseDate(item.published_at);
    if (!parsed) continue;
    if (!newest || parsed > newest) newest = parsed;
  }
  return newest;
}

function feedIsStalled(items, now = Date.now()) {
  const newest = newestDate(items);
  if (!newest) return false;
  return now - newest.getTime() > FEED_STALE_DAYS * 24 * 60 * 60 * 1000;
}

async function fetchListing(url, mayorId, state, extra = {}) {
  if (state.requests >= SOURCE_POLL_MAX_REQUESTS) {
    const error = new Error("request_budget");
    error.code = "request_budget";
    throw error;
  }
  state.requests += 1;
  const cond = extra.cond && (!extra.condUrl || extra.condUrl === url) ? extra.cond : {};
  return governedFetch(url, {
    mayorId,
    source: extra.source,
    timeoutMs: extra.timeoutMs || 15000,
    fetch: extra.fetch,
    etag: cond.etag,
    lastModified: cond.lastModified,
  });
}

function isDatedThisWeek(row) {
  const dated = parseDate(row.published_at);
  return Boolean(dated) && isWithinWeek(dated) === true;
}

function filterApproved(rows, mayorId, source) {
  return rows.filter(
    (row) =>
      row.url && isApprovedUrl(row.url, mayorId, source ? [source] : []) && isDatedThisWeek(row),
  );
}

async function runRss(strategy, source, mayor, state, extra) {
  const fetched = await fetchListing(strategy.url, mayor.id, state, extra);
  if (fetched.notModified) {
    return {
      ok: true,
      status: "ok_no_new",
      connect_status: "ok",
      parse_status: "not_modified",
      rows: [],
      http_status: 304,
      etag: fetched.etag,
      last_modified: fetched.lastModified,
      stalled: false,
      fallback: false,
    };
  }
  if (fetched.status === 202 || fetched.status === 403 || fetched.status === 401) {
    return {
      ok: false,
      status: "worker_rejected",
      connect_status: "worker_rejected",
      parse_status: "failed",
      rows: [],
      http_status: fetched.status,
      fallback: true,
      fail_reason: `http_${fetched.status}`,
    };
  }
  const pageError = looksLikeErrorPage(fetched.body, fetched.status, fetched.url);
  if (!fetched.ok || pageError.error) {
    return {
      ok: false,
      status: pageError.reason || "http_error",
      connect_status: pageError.reason || "http_error",
      parse_status: "failed",
      rows: [],
      http_status: fetched.status,
      fallback: true,
      fail_reason: pageError.reason || `http_${fetched.status}`,
    };
  }
  const parsed = parseFeed(fetched.body);
  if (parsed.corrupt) {
    return {
      ok: false,
      status: "feed_corrupt",
      connect_status: "ok",
      parse_status: parsed.reason || "feed_corrupt",
      rows: [],
      http_status: fetched.status,
      fallback: true,
      fail_reason: parsed.reason || "feed_corrupt",
    };
  }
  if (!parsed.items.length) {
    return {
      ok: true,
      status: "ok_no_new",
      connect_status: "ok",
      parse_status: "empty",
      rows: [],
      http_status: fetched.status,
      fallback: false,
      etag: fetched.etag,
      last_modified: fetched.lastModified,
    };
  }
  if (feedIsStalled(parsed.items)) {
    return {
      ok: false,
      status: "feed_stalled",
      connect_status: "ok",
      parse_status: "stalled",
      rows: parsed.items.map((item) => rowFromLink(source, mayor, item, "rss")),
      http_status: fetched.status,
      fallback: true,
      fail_reason: "feed_stalled",
      etag: fetched.etag,
      last_modified: fetched.lastModified,
    };
  }
  const rows = parsed.items.map((item) => rowFromLink(source, mayor, item, "rss"));
  return {
    ok: true,
    status: "ok",
    connect_status: "ok",
    parse_status: "ok",
    rows,
    http_status: fetched.status,
    fallback: false,
    etag: fetched.etag,
    last_modified: fetched.lastModified,
  };
}

async function runNewsroom(strategy, source, mayor, state, extra) {
  const urls = [strategy.url, ...(strategy.also || [])].filter(Boolean).slice(0, 3);
  const collected = [];
  let httpStatus = null;
  let lastBody = "";
  let lastUrl = strategy.url;
  for (const url of urls) {
    if (state.requests >= SOURCE_POLL_MAX_REQUESTS) break;
    const fetched = await fetchListing(url, mayor.id, state, extra);
    httpStatus = fetched.status;
    lastBody = fetched.body;
    lastUrl = fetched.url;
    if (fetched.notModified) {
      return {
        ok: true,
        status: "ok_no_new",
        connect_status: "ok",
        parse_status: "not_modified",
        rows: [],
        http_status: 304,
        fallback: false,
      };
    }
    const listing = inspectListingPage(fetched.body, fetched.status, fetched.url);
    if (!fetched.ok || !listing.ok) {
      return {
        ok: false,
        status: listing.reason || "http_error",
        connect_status: fetched.ok ? "ok" : listing.reason || "http_error",
        parse_status: listing.reason || "failed",
        rows: [],
        http_status: fetched.status,
        fallback: true,
        fail_reason: listing.reason || `http_${fetched.status}`,
      };
    }
    const links = extractArticleLinks(fetched.body, fetched.url, strategy.adapter || source.adapter);
    collected.push(...links);
  }
  if (!collected.length) {
    const js = inspectListingPage(lastBody, httpStatus || 200, lastUrl);
    return {
      ok: false,
      status: js.reason === "needs_javascript" ? "needs_javascript" : "empty_parse",
      connect_status: "ok",
      parse_status: js.reason === "needs_javascript" ? "needs_javascript" : "no_article_links",
      rows: [],
      http_status: httpStatus,
      fallback: true,
      fail_reason: js.reason === "needs_javascript" ? "needs_javascript" : "empty_parse",
    };
  }
  return {
    ok: true,
    status: "ok",
    connect_status: "ok",
    parse_status: "ok",
    rows: collected.map((link) => rowFromLink(source, mayor, link, "newsroom")),
    http_status: httpStatus,
    fallback: false,
  };
}

async function runSitemap(strategy, source, mayor, state, extra) {
  const fetched = await fetchListing(strategy.url, mayor.id, state, extra);
  if (!fetched.ok) {
    return {
      ok: false,
      status: classifyOrHttp(fetched.status),
      connect_status: classifyOrHttp(fetched.status),
      parse_status: "failed",
      rows: [],
      http_status: fetched.status,
      fallback: true,
      fail_reason: `http_${fetched.status}`,
    };
  }
  let xml = fetched.body;
  if (isSitemapIndex(xml)) {
    const children = childSitemaps(xml);
    const wanted = children.find((url) =>
      (strategy.include_patterns || []).some((pat) => new RegExp(pat, "i").test(url)),
    ) || children[0];
    if (wanted && state.requests < SOURCE_POLL_MAX_REQUESTS) {
      const child = await fetchListing(wanted, mayor.id, state, extra);
      if (child.ok) xml = child.body;
    }
  }
  const links = parseSitemap(xml, { includePatterns: strategy.include_patterns || [] });
  if (!links.length) {
    return {
      ok: false,
      status: "empty_parse",
      connect_status: "ok",
      parse_status: "no_article_links",
      rows: [],
      http_status: fetched.status,
      fallback: true,
      fail_reason: "empty_parse",
    };
  }
  return {
    ok: true,
    status: "ok",
    connect_status: "ok",
    parse_status: "ok",
    rows: links.map((link) => rowFromLink(source, mayor, link, "sitemap")),
    http_status: fetched.status,
    fallback: false,
  };
}

function classifyOrHttp(status) {
  if (status === 403 || status === 401) return "worker_rejected";
  if (status === 404) return "bad_url";
  return `http_${status}`;
}

async function runApi(strategy, source, mayor, state, extra) {
  const fetched = await fetchListing(strategy.url, mayor.id, state, extra);
  if (!fetched.ok) {
    return {
      ok: false,
      status: classifyOrHttp(fetched.status),
      connect_status: classifyOrHttp(fetched.status),
      parse_status: "failed",
      rows: [],
      http_status: fetched.status,
      fallback: true,
      fail_reason: `http_${fetched.status}`,
    };
  }
  const links = strategy.format === "wp-json" ? parseWpJson(fetched.body) : [];
  if (!links.length) {
    return {
      ok: false,
      status: "empty_parse",
      connect_status: "ok",
      parse_status: "no_article_links",
      rows: [],
      http_status: fetched.status,
      fallback: true,
      fail_reason: "empty_parse",
    };
  }
  return {
    ok: true,
    status: "ok",
    connect_status: "ok",
    parse_status: "ok",
    rows: links.map((link) => rowFromLink(source, mayor, link, "api")),
    http_status: fetched.status,
    fallback: false,
  };
}

async function runInternalSearch(strategy, source, mayor, state, extra) {
  if (!strategy.enabled || !strategy.query_template) {
    return { ok: false, status: "disabled", rows: [], fallback: true, fail_reason: "disabled" };
  }
  const query = encodeURIComponent(`${mayor.name_en} ${mayor.name_native}`.trim());
  const url = strategy.query_template.replace("{query}", query);
  return runNewsroom({ ...strategy, url, adapter: strategy.adapter || source.adapter }, source, mayor, state, extra);
}

async function runBrowser(strategy, source, mayor, extra) {
  if (!strategy.enabled) {
    return { ok: false, status: "disabled", rows: [], fallback: false, fail_reason: "browser_disabled" };
  }
  if (!extra.browser) {
    return {
      ok: false,
      status: "needs_javascript",
      connect_status: "ok",
      parse_status: "needs_javascript",
      rows: [],
      fallback: false,
      fail_reason: "browser_unbound",
    };
  }
  const html = await extra.browser(strategy.url || source.url);
  if (!html) {
    return {
      ok: false,
      status: "needs_javascript",
      rows: [],
      fallback: false,
      fail_reason: "browser_empty",
    };
  }
  const listing = inspectListingPage(html, 200, strategy.url || source.url);
  if (!listing.ok) {
    return { ok: false, status: listing.reason, rows: [], fallback: false, fail_reason: listing.reason };
  }
  const links = extractArticleLinks(html, strategy.url || source.url, strategy.adapter || source.adapter);
  return {
    ok: links.length > 0,
    status: links.length ? "ok" : "empty_parse",
    connect_status: "ok",
    parse_status: links.length ? "ok" : "no_article_links",
    rows: links.map((link) => rowFromLink(source, mayor, link, "browser")),
    http_status: 200,
    fallback: false,
  };
}

const RUNNERS = {
  rss: runRss,
  newsroom: runNewsroom,
  sitemap: runSitemap,
  api: runApi,
  internal_search: runInternalSearch,
  browser: runBrowser,
};

/**
 * يشغّل استراتيجيات المصدر بالترتيب. نجاح بلا عناصر جديدة يوقف السلسلة.
 * العطل الحقيقي فقط ينتقل للتالية.
 */
export async function discoverSource(source, mayor, extra = {}) {
  const started = Date.now();
  const health = emptyHealth(source);
  const state = { requests: 0 };
  const steps = (source.discovery || []).filter((entry) => entry && entry.enabled !== false);
  extra = { ...extra, source };
  if (!steps.length) {
    health.status = "bad_url";
    health.fail_reason = "no_discovery_strategy";
    health.ms = Date.now() - started;
    return { source, rows: [], health };
  }

  let last = null;
  let retained = [];
  let retainedStatus = "";
  for (const strategy of steps) {
    const runner = RUNNERS[strategy.type];
    if (!runner) continue;
    try {
      last = await runner(strategy, source, mayor, state, extra);
    } catch (error) {
      const code = error.code || String(error.message || error).slice(0, 80);
      last = {
        ok: false,
        status: code,
        connect_status: code === "redirect_outside_registry" ? "redirect_outside_registry" : "failed",
        parse_status: "failed",
        rows: [],
        fallback: strategy.type !== "browser",
        fail_reason: code,
        http_status: error.httpStatus || null,
      };
    }
    health.last_strategy = strategy.type;
    health.http_status = last.http_status ?? health.http_status;
    health.connect_status = last.connect_status || health.connect_status;
    health.parse_status = last.parse_status || health.parse_status;
    health.etag = last.etag || health.etag;
    health.last_modified = last.last_modified || health.last_modified;
    if (last.rows?.length) {
      retained = last.rows;
      retainedStatus = last.status;
    }
    if (last.ok) {
      const rows = filterApproved(last.rows || [], mayor.id, source);
      health.ok = true;
      health.status = rows.length ? last.status || "ok" : "ok_no_new";
      health.fail_reason = "";
      health.discovered = rows.length;
      health.items = rows.length;
      health.last_discovered_url = rows[0]?.url || "";
      health.ms = Date.now() - started;
      health.requests = state.requests;
      return { source, rows, health, used: strategy.type };
    }
    health.fail_reason = last.fail_reason || last.status;
    health.status = last.status;
    if (!last.fallback) break;
  }

  const leftover = filterApproved(retained, mayor.id, source);
  health.ok = false;
  health.items = leftover.length;
  health.discovered = leftover.length;
  health.last_discovered_url = leftover[0]?.url || "";
  /**
   * تغذية متوقفة تبقى عطل مصدر حتى لو أسقطنا روابطها لأنها خارج الأسبوع.
   * إسقاط الصفوف يمنع الكتابة، لا يحوّل العطل إلى empty_parse.
   */
  if (retainedStatus) health.status = retainedStatus;

  health.ms = Date.now() - started;
  health.requests = state.requests;
  return { source, rows: leftover, health };
}

export async function discoverById(sourceId, mayor, extra = {}) {
  const source = sourceById(sourceId);
  if (!source) {
    return {
      source: { id: sourceId },
      rows: [],
      health: { id: sourceId, ok: false, status: "bad_url", fail_reason: "unknown_source" },
    };
  }
  return discoverSource(source, mayor, extra);
}
