/**
 * فحص موقع يضيفه الموظف من الإعدادات واكتشاف أفضل طريقة لقراءته تلقائيًا.
 *
 * الترتيب من الأدق إلى الأوسع: تغذية RSS/Atom، ثم واجهة ووردبريس، ثم صفحة الأخبار
 * نفسها. وإن وُجد بحث داخلي يعمل أُضيف خطوةً تكميلية تبحث باسم العمدة، لأن آخر
 * العناوين وحدها تفوّت خبر العمدة بين مئات الأخبار.
 *
 * هذا الملف لا يكتب في قاعدة البيانات، ولا يفتح إلا نطاق الموقع المُدخل.
 */
import { isAggregatorHost, publisherDomain } from "./domain.js";
import { governedFetch, isBlockedHost, looksLikeErrorPage } from "./governedFetch.js";
import { extractArticleLinks, parseWpJson } from "./newsroom.js";
import { parseFeed } from "./rss.js";
import { searchNames } from "./discovery.js";

export const MAX_PROBE_REQUESTS = 12;
const COMMON_FEED_PATHS = ["/feed", "/feed/", "/rss", "/rss.xml", "/feed.xml", "/atom.xml"];

/** منصات عامة تستضيف آلاف المواقع: قبول نطاقها يفتح كل ما تحته، فلا تُعتمد. */
const SHARED_PLATFORMS = new Set([
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "linkedin.com",
  "t.me",
  "telegram.org",
  "whatsapp.com",
  "reddit.com",
  "medium.com",
  "blogspot.com",
  "wordpress.com",
  "substack.com",
  "github.io",
  "wixsite.com",
  "weebly.com",
  "wikipedia.org",
  "archive.org",
  "pinterest.com",
]);

const IP_LITERAL = /^(?:\d{1,3}\.){3}\d{1,3}$|^\[|:/;

/** يحوّل ما كتبه الموظف إلى عنوان آمن، أو يعيد سبب الرفض بالعربية. */
export function normalizeSiteInput(input) {
  const raw = String(input || "").trim();
  if (!raw) return { ok: false, error: "empty", message: "اكتب رابط الموقع." };
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, error: "bad_url", message: "الرابط غير صالح." };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, error: "bad_scheme", message: "يُقبل رابط http أو https فقط." };
  }
  if (url.username || url.password) {
    return { ok: false, error: "credentials_in_url", message: "لا يُقبل رابط يحمل اسم مستخدم أو كلمة سر." };
  }
  const host = url.hostname.replace(/^www\./i, "").toLowerCase();
  if (!host.includes(".") || IP_LITERAL.test(host) || isBlockedHost(host)) {
    return { ok: false, error: "bad_host", message: "الموقع يجب أن يكون اسم نطاق عامًا، لا عنوان IP ولا شبكة داخلية." };
  }
  const registrable = publisherDomain(host);
  if (isAggregatorHost(host) || isAggregatorHost(registrable)) {
    return { ok: false, error: "aggregator", message: "محركات البحث والمجمّعات لا تُعتمد مصدرًا." };
  }
  if ([...SHARED_PLATFORMS].some((platform) => host === platform || host.endsWith(`.${platform}`))) {
    return { ok: false, error: "shared_platform", message: "منصات التواصل والمدونات العامة لا تُعتمد؛ أضف موقع الجهة نفسه." };
  }
  url.hash = "";
  return { ok: true, url, domain: host, origin: `${url.protocol}//${url.host}` };
}

function siteName(html, fallback) {
  const og = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']{2,80})["']/i)?.[1];
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const raw = og || (title ? title.split(/[|–—-]/).pop() : "") || fallback;
  return raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || fallback;
}

function isSameSite(finalUrl, domain) {
  try {
    const host = new URL(finalUrl).hostname.replace(/^www\./i, "").toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function fetchFailureReason(error, status) {
  if (status === 401 || status === 403) return "الموقع يرفض الطلبات الآلية";
  if (status) return `استجاب الموقع بالحالة ${status}`;
  if (error === "blocked_host") return "العنوان داخلي أو غير مسموح";
  if (/abort|timeout/i.test(String(error))) return "انتهت مهلة الاتصال";
  return "لا يمكن الوصول إلى الموقع، تأكد من كتابة الرابط";
}

/**
 * يكتشف خطوات القراءة المناسبة لموقع. يعيد { ok, steps, name, notes, error }.
 * `fetch` قابل للحقن للاختبار؛ والحدّ الأعلى للطلبات ثابت حتى لا يصير الفحص عبئًا.
 */
export async function detectStrategies(site, mayor, { fetch } = {}) {
  let requests = 0;
  const get = async (url) => {
    if (requests >= MAX_PROBE_REQUESTS) return null;
    requests += 1;
    try {
      return await governedFetch(url, { timeoutMs: 12000, fetch });
    } catch (error) {
      return { ok: false, status: 0, body: "", url, error: error.code || String(error.message || error) };
    }
  };
  const notes = [];
  const steps = [];

  const first = await get(site.url.toString());
  if (!first || !first.ok) {
    const status = first?.status || 0;
    const reason = fetchFailureReason(first?.error, status);
    return { ok: false, error: "unreachable", message: `تعذر فتح الموقع: ${reason}.`, notes, requests };
  }
  if (!isSameSite(first.url, site.domain)) {
    return {
      ok: false,
      error: "redirects_elsewhere",
      message: `الموقع يحوّل إلى نطاق آخر (${new URL(first.url).hostname}). أضف ذلك النطاق مباشرة.`,
      notes,
      requests,
    };
  }
  const html = String(first.body || "");
  const name = siteName(html, site.domain);

  // 1) الرابط نفسه تغذية؟
  const asFeed = parseFeed(html);
  if (!asFeed.corrupt && asFeed.items.length) {
    steps.push({ type: "rss", url: first.url });
    notes.push("الرابط المُدخل تغذية RSS.");
  }

  // 2) تغذية معلنة في الصفحة، ثم المسارات الشائعة.
  if (!steps.length) {
    const declared = [
      ...html.matchAll(
        /<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi,
      ),
    ]
      .map((m) => m[0].match(/href=["']([^"']+)["']/i)?.[1])
      .filter(Boolean)
      .map((href) => {
        try {
          return new URL(href, first.url).toString();
        } catch {
          return "";
        }
      })
      .filter((href) => href && isSameSite(href, site.domain));
    const candidates = [...new Set([...declared.slice(0, 2), ...COMMON_FEED_PATHS.map((p) => `${site.origin}${p}`)])];
    for (const candidate of candidates.slice(0, 5)) {
      const res = await get(candidate);
      if (!res?.ok || !isSameSite(res.url, site.domain)) continue;
      const parsed = parseFeed(String(res.body || ""));
      if (!parsed.corrupt && parsed.items.length) {
        steps.push({ type: "rss", url: res.url });
        notes.push("وُجدت تغذية RSS.");
        break;
      }
    }
  }

  // 3) ووردبريس: واجهة JSON تعطي تاريخ كل خبر، وتدعم البحث.
  let wordpress = false;
  if (/wp-json|wp-content|wp-includes/i.test(html)) {
    const listUrl = `${site.origin}/wp-json/wp/v2/posts?per_page=20&orderby=date`;
    const res = await get(listUrl);
    if (res?.ok && parseWpJson(String(res.body || "")).length) {
      wordpress = true;
      steps.push({ type: "api", format: "wp-json", url: listUrl });
      notes.push("الموقع ووردبريس: واجهته تعطي التاريخ لكل خبر.");
    }
  }

  // 4) صفحة الأخبار نفسها كخطة أخيرة تتحمل غياب التغذية.
  const links = extractArticleLinks(html, first.url, "generic");
  if (links.length >= 3) {
    steps.push({ type: "newsroom", url: first.url, adapter: "generic" });
    notes.push(`الصفحة تعرض ${links.length} روابط أخبار.`);
  }

  if (!steps.length) {
    return {
      ok: false,
      error: "nothing_readable",
      message:
        "لم أجد في الموقع تغذية RSS ولا واجهة ولا قائمة أخبار مقروءة. قد يعتمد على جافاسكربت أو يحجب الطلبات الآلية؛ جرّب رابط قسم الأخبار بدل الرئيسية.",
      notes,
      requests,
    };
  }

  // 5) بحث داخلي باسم العمدة، وهو ما يصل إلى خبره بين مئات العناوين.
  const search = [];
  if (wordpress) {
    search.push({
      type: "api",
      format: "wp-json",
      url: `${site.origin}/wp-json/wp/v2/posts?per_page=20&orderby=date&search={query}`,
      supplement: true,
    });
    notes.push("يبحث باسم العمدة عبر واجهة الموقع.");
  } else {
    const probeName = searchNames(mayor)[0];
    for (const template of [`${site.origin}/?s={query}`, `${site.origin}/search?q={query}`]) {
      if (!probeName) break;
      const res = await get(template.replace("{query}", encodeURIComponent(probeName)));
      if (!res?.ok || !isSameSite(res.url, site.domain)) continue;
      if (looksLikeErrorPage(res.body, res.status, res.url).error) continue;
      if (extractArticleLinks(String(res.body || ""), res.url, "generic").length) {
        search.push({ type: "internal_search", query_template: template, adapter: "generic", supplement: true });
        notes.push("يبحث باسم العمدة عبر بحث الموقع.");
        break;
      }
    }
  }
  steps.push(...search);
  return { ok: true, steps, name, notes, requests };
}
