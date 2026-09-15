/**
 * جلب محكوم: لا يُتبع التحويل أعمى، ولا يُفتح نطاق خارج السجل، ولا عناوين داخلية.
 */
import { approvedSourceFor, isApprovedUrl } from "./sources.js";

export const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

export const MAX_REDIRECTS = 5;
export const DEFAULT_TIMEOUT_MS = 12000;

const ERROR_LOCATION =
  /errpage|errorpage|aspxerrorpath|\/404\b|\/error\b|access[-_]?denied/i;

export function hostOf(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

export function isBlockedHost(hostname) {
  const host = String(hostname || "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  if (!host) return true;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "0.0.0.0" || host === "0") return true;
  if (host === "metadata.google.internal" || host === "metadata.google.com") return true;
  if (host === "169.254.169.254" || /^169\.254\./.test(host)) return true;
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^0\./.test(host)) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  if (host.includes(":") && (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"))) {
    return true;
  }
  return false;
}

export function isPublicHttpUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (isBlockedHost(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function classifyHttpStatus(status) {
  const code = Number(status) || 0;
  if (code === 304) return "not_modified";
  if ([401, 403, 407, 451].includes(code)) return "worker_rejected";
  if ([404, 410].includes(code)) return "bad_url";
  if ([429, 503, 502, 504].includes(code)) return "transient";
  if (code >= 500) return "server_error";
  if (code >= 400) return "http_error";
  return "ok";
}

export function looksLikeErrorPage(html, httpStatus = 200, url = "") {
  if (httpStatus && httpStatus >= 400) {
    return { error: true, reason: classifyHttpStatus(httpStatus) };
  }
  if (ERROR_LOCATION.test(String(url || ""))) {
    return { error: true, reason: "error_page" };
  }
  const text = String(html || "");
  const title = (
    text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || []
  )[1]
    ?.replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase() || "";
  if (
    /access denied|404|not found|page not found|página no encontrada|pagina no encontrada|ページが見つかりません|ошибка|object moved|gateway_timeout|just a moment|human verification|internal server error|dominio no declarado|خطأ|تعذر/.test(
      title,
    )
  ) {
    return { error: true, reason: "error_page" };
  }
  if (/dominio no declarado|iis \d+\.\d+ detailed error/i.test(text.slice(0, 2000))) {
    return { error: true, reason: "error_page" };
  }
  if (text.length < 500 && /error|denied|not found|404/i.test(text)) {
    return { error: true, reason: "error_page" };
  }
  return { error: false, reason: "" };
}

export function looksLikeJsShell(html) {
  const text = String(html || "");
  if (text.length > 8000) return false;
  const links = (text.match(/<a\b[^>]*href/gi) || []).length;
  if (links >= 8) return false;
  return (
    /<div id=["'](?:root|app|__next)["']/i.test(text) ||
    /enable javascript|requires javascript|you need to enable javascript/i.test(text)
  );
}

function header(headers, name) {
  if (!headers) return "";
  if (typeof headers.get === "function") return headers.get(name) || "";
  return headers[name] || headers[name.toLowerCase()] || "";
}

export async function governedFetch(url, opts = {}) {
  const fetchImpl = opts.fetch || globalThis.fetch;
  const mayorId = opts.mayorId || null;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  if (!isPublicHttpUrl(url)) {
    const error = new Error("blocked_host");
    error.code = "blocked_host";
    throw error;
  }
  if (mayorId && !isApprovedUrl(url, mayorId)) {
    const error = new Error("redirect_outside_registry");
    error.code = "redirect_outside_registry";
    throw error;
  }

  let current = url;
  const chain = [current];
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    if (!isPublicHttpUrl(current)) {
      const error = new Error("blocked_host");
      error.code = "blocked_host";
      throw error;
    }
    if (mayorId && !isApprovedUrl(current, mayorId)) {
      const error = new Error("redirect_outside_registry");
      error.code = "redirect_outside_registry";
      error.url = current;
      throw error;
    }

    const headers = {
      "User-Agent": opts.userAgent || BROWSER_UA,
      Accept:
        opts.accept ||
        "text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,ar;q=0.8,es;q=0.7,it;q=0.6,el;q=0.5,ja;q=0.5",
      ...(opts.headers || {}),
    };
    if (opts.etag) headers["If-None-Match"] = opts.etag;
    if (opts.lastModified) headers["If-Modified-Since"] = opts.lastModified;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(current, {
        method: opts.method || "GET",
        headers,
        body: opts.body,
        redirect: "manual",
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const status = Number(res.status) || 0;
    if ([301, 302, 303, 307, 308].includes(status)) {
      const location = header(res.headers, "Location");
      if (!location) {
        const error = new Error("redirect_missing_location");
        error.code = "redirect_missing_location";
        throw error;
      }
      if (ERROR_LOCATION.test(location)) {
        const error = new Error("error_page");
        error.code = "error_page";
        error.httpStatus = status;
        error.url = location;
        throw error;
      }
      let next;
      try {
        next = new URL(location, current).toString();
      } catch {
        const error = new Error("redirect_invalid");
        error.code = "redirect_invalid";
        throw error;
      }
      if (!isPublicHttpUrl(next)) {
        const error = new Error("blocked_host");
        error.code = "blocked_host";
        error.url = next;
        throw error;
      }
      if (mayorId && !isApprovedUrl(next, mayorId)) {
        const error = new Error("redirect_outside_registry");
        error.code = "redirect_outside_registry";
        error.url = next;
        throw error;
      }
      chain.push(next);
      current = next;
      continue;
    }

    const etag = header(res.headers, "ETag");
    const lastModified = header(res.headers, "Last-Modified");
    const body = opts.raw ? res : await res.text();
    return {
      ok: status >= 200 && status < 300,
      notModified: status === 304,
      status,
      url: current,
      chain,
      body,
      etag,
      lastModified,
      source: mayorId ? approvedSourceFor(current, mayorId) : null,
    };
  }

  const error = new Error("too_many_redirects");
  error.code = "too_many_redirects";
  throw error;
}

export function assertCanonicalApproved(canonical, mayorId, fallbackUrl) {
  const url = canonical || fallbackUrl;
  if (!url) return { ok: false, reason: "missing_canonical" };
  if (!isPublicHttpUrl(url)) return { ok: false, reason: "blocked_host" };
  if (mayorId && !isApprovedUrl(url, mayorId)) {
    return { ok: false, reason: "canonical_outside_registry", url };
  }
  return { ok: true, url };
}
