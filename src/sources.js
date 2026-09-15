/**
 * سجل المصادر المعتمدة — حوكمة الرصد.
 *
 * لا يفتح المكتب أي رابط لا ينتمي إلى نطاق معتمد هنا. لا محركات بحث ولا مجمّعات.
 * الاكتشاف مرتّب داخل المصدر: RSS ثم غرفة الأخبار ثم Sitemap/API ثم بحث داخلي
 * مختبر ثم Browser Rendering إن رُبط، دون تجاوز CAPTCHA.
 *
 * لكل مكتب ثلاثة مصادر على الأكثر:
 *   1. غرفة الأخبار الرسمية للمدينة.
 *   2. أقوى تغطية محلية.
 *   3. وكالة أو صحيفة وطنية.
 */

const STRATEGY_KIND = {
  rss: "feed",
  newsroom: "page",
  sitemap: "sitemap",
  api: "api",
  internal_search: "search",
  browser: "browser",
};

function step(type, spec = {}) {
  return { type, enabled: spec.enabled !== false, ...spec };
}

const REGISTRY = {
  turin: [
    {
      domain: "comune.torino.it",
      name: "Comune di Torino",
      tier: 0,
      platform: "official",
      discovery: [
        step("rss", { url: "https://www.comune.torino.it/rss.xml" }),
        step("newsroom", { url: "https://www.comune.torino.it/", adapter: "generic" }),
      ],
    },
    {
      domain: "torinoclick.it",
      name: "Torino Click",
      tier: 0,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://www.torinoclick.it/feed/" })],
    },
    {
      domain: "torino.repubblica.it",
      name: "La Repubblica Torino",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://torino.repubblica.it/rss/rss2.0.xml" })],
    },
  ],
  seoul: [
    {
      domain: "seoul.go.kr",
      name: "Seoul Metropolitan Government",
      tier: 0,
      platform: "official",
      discovery: [
        step("rss", { url: "https://english.seoul.go.kr/feed/" }),
        step("newsroom", { url: "https://english.seoul.go.kr/", adapter: "seoul-wp" }),
        step("api", {
          url: "https://english.seoul.go.kr/wp-json/wp/v2/posts?per_page=20",
          format: "wp-json",
        }),
      ],
    },
    {
      domain: "yna.co.kr",
      name: "Yonhap News",
      tier: 1,
      platform: "agency",
      discovery: [step("rss", { url: "https://www.yna.co.kr/rss/politics.xml" })],
    },
    {
      domain: "koreaherald.com",
      name: "The Korea Herald",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://www.koreaherald.com/rss/newsAll" })],
    },
  ],
  madrid: [
    {
      domain: "diario.madrid.es",
      name: "Diario de Madrid",
      tier: 0,
      platform: "official",
      discovery: [
        step("newsroom", { url: "https://diario.madrid.es/", adapter: "madrid-diario" }),
        step("sitemap", {
          url: "https://diario.madrid.es/sitemap.xml",
          include_patterns: ["blog", "noticia", "20"],
        }),
        step("browser", { enabled: false }),
      ],
    },
    {
      domain: "europapress.es",
      name: "Europa Press Madrid",
      tier: 1,
      platform: "agency",
      discovery: [step("rss", { url: "https://www.europapress.es/rss/rss.aspx?ch=289" })],
    },
    {
      domain: "elmundo.es",
      name: "El Mundo Madrid",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://www.elmundo.es/rss/madrid.xml" })],
    },
  ],
  malaga: [
    {
      domain: "malaga.eu",
      name: "Ayuntamiento de Málaga",
      tier: 0,
      platform: "official",
      discovery: [
        step("newsroom", {
          url: "https://www.malaga.eu/el-ayuntamiento/notas-de-prensa/",
          adapter: "malaga-press",
        }),
        step("browser", { enabled: false }),
      ],
    },
    {
      domain: "diariosur.es",
      name: "Diario Sur Málaga",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://www.diariosur.es/rss/2.0/?section=malaga" })],
    },
    {
      domain: "europapress.es",
      name: "Europa Press Andalucía",
      tier: 1,
      platform: "agency",
      discovery: [step("rss", { url: "https://www.europapress.es/rss/rss.aspx?ch=00356" })],
    },
  ],
  "northeast-england": [
    {
      domain: "northeast-ca.gov.uk",
      name: "North East Combined Authority",
      tier: 0,
      platform: "official",
      discovery: [
        step("newsroom", { url: "https://www.northeast-ca.gov.uk/news", adapter: "neca-news" }),
        step("sitemap", {
          url: "https://www.northeast-ca.gov.uk/sitemap.xml",
          include_patterns: ["/news/"],
        }),
        step("browser", { enabled: false }),
      ],
    },
    {
      domain: "chroniclelive.co.uk",
      name: "Chronicle Live",
      tier: 1,
      platform: "newspaper",
      discovery: [
        step("rss", { url: "https://www.chroniclelive.co.uk/news/north-east-news/?service=rss" }),
      ],
    },
    {
      domain: "thenorthernecho.co.uk",
      name: "The Northern Echo",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://www.thenorthernecho.co.uk/news/rss/" })],
    },
  ],
  amman: [
    {
      domain: "ammancity.gov.jo",
      name: "أمانة عمّان الكبرى",
      tier: 0,
      platform: "official",
      discovery: [
        step("newsroom", {
          url: "https://www.ammancity.gov.jo/ar/gam/news.aspx",
          adapter: "amman-gam",
        }),
        step("browser", { enabled: false }),
      ],
    },
    {
      domain: "roya.tv",
      name: "رؤيا",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://roya.tv/rss" })],
    },
    {
      domain: "almamlakatv.com",
      name: "المملكة",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://almamlakatv.com/rss.xml" })],
    },
  ],
  baghdad: [
    {
      domain: "amanatbaghdad.gov.iq",
      name: "أمانة بغداد",
      tier: 0,
      platform: "official",
      discovery: [
        step("newsroom", { url: "https://amanatbaghdad.gov.iq/news", adapter: "baghdad-amanat" }),
        step("browser", { enabled: false }),
      ],
    },
    {
      domain: "baghdadtoday.news",
      name: "بغداد اليوم",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://baghdadtoday.news/rss.xml" })],
    },
    {
      domain: "ina.iq",
      name: "الوكالة العراقية للأنباء",
      tier: 1,
      platform: "agency",
      discovery: [
        step("rss", { url: "https://www.ina.iq/rss.xml" }),
        step("newsroom", { url: "https://ina.iq/ar/local", adapter: "ina-local" }),
      ],
    },
  ],
  muscat: [
    {
      domain: "mm.gov.om",
      name: "بلدية مسقط",
      tier: 0,
      platform: "official",
      discovery: [
        step("rss", { url: "https://www.mm.gov.om/ar/rss.aspx" }),
        step("newsroom", {
          url: "https://www.mm.gov.om/ar/Page.aspx?PAID=2",
          adapter: "muscat-mm",
        }),
      ],
    },
    {
      domain: "timesofoman.com",
      name: "Times of Oman",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://timesofoman.com/feed/" })],
    },
    {
      domain: "omanobserver.om",
      name: "Oman Observer",
      tier: 1,
      platform: "newspaper",
      discovery: [
        step("newsroom", { url: "https://www.omanobserver.om/oman", adapter: "oman-observer" }),
      ],
    },
  ],
  osaka: [
    {
      domain: "city.osaka.lg.jp",
      name: "大阪市",
      tier: 0,
      platform: "official",
      discovery: [
        step("rss", { url: "https://www.city.osaka.lg.jp/main/rss/rss.xml" }),
        step("newsroom", {
          url: "https://www.city.osaka.lg.jp/shisei/news/curr.html",
          adapter: "osaka-city",
          also: ["https://www.city.osaka.lg.jp/shisei/news/prev1.html"],
        }),
      ],
    },
    {
      domain: "nhk.or.jp",
      name: "NHK",
      tier: 1,
      platform: "agency",
      discovery: [step("rss", { url: "https://www3.nhk.or.jp/rss/news/cat0.xml" })],
    },
    {
      domain: "asahi.com",
      name: "朝日新聞",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://www.asahi.com/rss/asahi/newsheadlines.rdf" })],
    },
  ],
  athens: [
    {
      domain: "cityofathens.gr",
      name: "Δήμος Αθηναίων",
      tier: 0,
      platform: "official",
      discovery: [
        step("rss", { url: "https://www.cityofathens.gr/feed/" }),
        step("newsroom", { url: "https://www.cityofathens.gr/news/", adapter: "athens-wp" }),
        step("api", {
          url: "https://www.cityofathens.gr/wp-json/wp/v2/posts?per_page=20",
          format: "wp-json",
        }),
        step("sitemap", {
          url: "https://www.cityofathens.gr/post-sitemap.xml",
          include_patterns: ["deltio-typoy", "anakoinosi"],
        }),
      ],
    },
    {
      domain: "efsyn.gr",
      name: "Εφημερίδα των Συντακτών",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://www.efsyn.gr/rss.xml" })],
    },
    {
      domain: "in.gr",
      name: "in.gr",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://www.in.gr/feed/" })],
    },
  ],
  pristina: [
    {
      domain: "prishtinaonline.com",
      name: "Komuna e Prishtinës",
      tier: 0,
      platform: "official",
      discovery: [
        step("newsroom", { url: "https://prishtinaonline.com/lajmet", adapter: "pristina-lajmet" }),
      ],
    },
    {
      domain: "telegrafi.com",
      name: "Telegrafi",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://telegrafi.com/feed/" })],
    },
    {
      domain: "kallxo.com",
      name: "Kallxo",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://kallxo.com/feed/" })],
    },
  ],
  rabat: [
    {
      domain: "mairiederabat.ma",
      name: "جماعة الرباط",
      tier: 0,
      platform: "official",
      discovery: [
        step("newsroom", { url: "https://mairiederabat.ma/ar-AR", adapter: "rabat-mairie" }),
        step("browser", { enabled: false }),
      ],
    },
    {
      domain: "hespress.com",
      name: "هسبريس",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://www.hespress.com/feed" })],
    },
    {
      domain: "telquel.ma",
      name: "TelQuel",
      tier: 1,
      platform: "newspaper",
      discovery: [step("rss", { url: "https://telquel.ma/feed" })],
    },
  ],
};

export const MAX_SOURCES_PER_OFFICE = 3;
export const CURATED_AT = "2026-09-14";
export const SOURCE_POLL_MAX_REQUESTS = 6;
export const ARTICLE_FETCH_BATCH = 3;
export const INLINE_ARTICLE_FETCH_LIMIT = 12;
export const FEED_STALE_DAYS = 21;

const VERIFIED_AT_CURATION = new Set([
  "turin:comune.torino.it",
  "turin:torinoclick.it",
  "turin:torino.repubblica.it",
  "seoul:seoul.go.kr",
  "seoul:yna.co.kr",
  "seoul:koreaherald.com",
  "madrid:europapress.es",
  "madrid:elmundo.es",
  "malaga:malaga.eu",
  "malaga:diariosur.es",
  "malaga:europapress.es",
  "northeast-england:chroniclelive.co.uk",
  "northeast-england:thenorthernecho.co.uk",
  "amman:roya.tv",
  "amman:almamlakatv.com",
  "baghdad:baghdadtoday.news",
  "baghdad:ina.iq",
  "muscat:mm.gov.om",
  "muscat:timesofoman.com",
  "muscat:omanobserver.om",
  "osaka:city.osaka.lg.jp",
  "osaka:nhk.or.jp",
  "osaka:asahi.com",
  "athens:cityofathens.gr",
  "athens:efsyn.gr",
  "athens:in.gr",
  "pristina:prishtinaonline.com",
  "pristina:telegrafi.com",
  "pristina:kallxo.com",
  "rabat:hespress.com",
  "rabat:telquel.ma",
]);

export function discoverySteps(source) {
  return (source?.discovery || []).filter((entry) => entry && entry.enabled !== false);
}

export function primaryStrategy(source) {
  return discoverySteps(source).find((entry) => entry.url) || discoverySteps(source)[0] || null;
}

export function strategyKind(type) {
  return STRATEGY_KIND[type] || "page";
}

export function platformLabelAr(source) {
  const platform = source.platform || (source.tier === 0 ? "official" : "newspaper");
  const labels = {
    official: "موقع رسمي",
    newspaper: "صحيفة",
    agency: "وكالة",
  };
  return labels[platform] || platform;
}

export function strategyLabelAr(type) {
  return (
    {
      rss: "RSS",
      newsroom: "غرفة أخبار",
      sitemap: "Sitemap",
      api: "واجهة الموقع",
      internal_search: "بحث داخلي",
      browser: "Browser",
    }[type] || type
  );
}

function withIds(mayorId, entries) {
  return entries.slice(0, MAX_SOURCES_PER_OFFICE).map((entry, index) => {
    const id = `${mayorId}:${entry.domain}`;
    const discovery = (entry.discovery || []).map((row, rank) => ({
      ...row,
      enabled: row.enabled !== false,
      rank: rank + 1,
    }));
    const primary = discovery.find((row) => row.enabled && row.url) || discovery[0] || {};
    return {
      ...entry,
      id,
      mayor_id: mayorId,
      rank: index + 1,
      discovery,
      kind: strategyKind(primary.type),
      url: primary.url || "",
      adapter: discovery.find((row) => row.type === "newsroom")?.adapter || "generic",
      verified: VERIFIED_AT_CURATION.has(id) ? 1 : 0,
      curated_at: CURATED_AT,
    };
  });
}

export const APPROVED_SOURCES = Object.entries(REGISTRY).flatMap(([mayorId, entries]) =>
  withIds(mayorId, entries),
);

/** الثلاثة المقترحة لكل مكتب: رسمي، محلي، وطني — نفس ترتيب السجل. */
export const PLATFORM_SLOTS = [
  { key: "official", platform: "official", tier: 0, label_ar: "غرفة الأخبار الرسمية" },
  { key: "local", platform: "newspaper", tier: 0, label_ar: "أقوى تغطية محلية" },
  { key: "national", platform: "agency", tier: 1, label_ar: "وكالة أو صحيفة وطنية" },
];

const BLOCKED_DISCOVERY = new Set([
  "google.com",
  "news.google.com",
  "bing.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
]);

const customById = new Map();

export function hydrateCustomSources(sources) {
  customById.clear();
  for (const source of sources || []) {
    if (source?.id) customById.set(source.id, source);
  }
}

export function rememberCustomSource(source) {
  if (source?.id) customById.set(source.id, source);
}

export function sourcesFor(mayorId) {
  const coded = APPROVED_SOURCES.filter((source) => source.mayor_id === mayorId);
  if (coded.length) return coded;
  return [...customById.values()]
    .filter((source) => source.mayor_id === mayorId)
    .sort((a, b) => (a.rank || 0) - (b.rank || 0));
}

export function sourceById(id) {
  return APPROVED_SOURCES.find((source) => source.id === id) || customById.get(id) || null;
}

export function parsePublicSourceUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return { error: "missing_url" };
  let href = raw;
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
  let parsed;
  try {
    parsed = new URL(href);
  } catch {
    return { error: "bad_url" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "bad_url" };
  }
  const domain = parsed.hostname.replace(/^www\./i, "").replace(/\.$/, "").toLowerCase();
  if (
    !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      domain,
    )
  ) {
    return { error: "bad_host" };
  }
  if (
    domain === "localhost" ||
    domain.endsWith(".localhost") ||
    domain.endsWith(".local") ||
    /^(127\.|10\.|192\.168\.|169\.254\.)/.test(domain)
  ) {
    return { error: "bad_host" };
  }
  const root = domain.split(".").slice(-2).join(".");
  if (BLOCKED_DISCOVERY.has(domain) || BLOCKED_DISCOVERY.has(root)) {
    return { error: "blocked_host" };
  }
  parsed.hash = "";
  return { url: parsed.toString(), domain };
}

function discoveryFromUrl(url) {
  if (/\b(rss|atom|feed|\.xml)\b/i.test(url)) {
    let home = url;
    try {
      home = `${new URL(url).origin}/`;
    } catch {
      /* keep the feed url */
    }
    return [
      step("rss", { url }),
      step("newsroom", { url: home, adapter: "generic" }),
    ];
  }
  return [step("newsroom", { url, adapter: "generic" })];
}

export function parseOfficePlatforms(body, mayorId) {
  const seen = new Set();
  const sources = [];
  for (let index = 0; index < PLATFORM_SLOTS.length; index += 1) {
    const slot = PLATFORM_SLOTS[index];
    const fromList = Array.isArray(body?.platforms) ? body.platforms[index] : null;
    const parsed = parsePublicSourceUrl(
      body?.[`${slot.key}_url`] || fromList?.url || fromList?.href,
    );
    if (parsed.error) {
      return {
        error: parsed.error === "missing_url" ? "missing_platforms" : parsed.error,
        detail: slot.key,
        message:
          parsed.error === "blocked_host"
            ? "المنصات الثلاثة مواقع المكتب نفسه، لا محركات بحث ولا شبكات تواصل."
            : `رابط ${slot.label_ar} غير صالح.`,
      };
    }
    if (seen.has(parsed.domain)) {
      return {
        error: "duplicate_platform",
        detail: parsed.domain,
        message: "كل موقع من الثلاثة يجب أن يكون نطاقًا مختلفًا.",
      };
    }
    seen.add(parsed.domain);
    const name = String(fromList?.name || body?.[`${slot.key}_name`] || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 120) || parsed.domain;
    const discovery = discoveryFromUrl(parsed.url).map((row, rank) => ({
      ...row,
      enabled: row.enabled !== false,
      rank: rank + 1,
    }));
    const primary = discovery.find((row) => row.enabled && row.url) || discovery[0] || {};
    sources.push({
      id: `${mayorId}:${parsed.domain}`,
      mayor_id: mayorId,
      domain: parsed.domain,
      name,
      tier: slot.tier,
      platform: slot.platform,
      rank: index + 1,
      discovery,
      kind: strategyKind(primary.type),
      url: primary.url || parsed.url,
      adapter: "generic",
      verified: 0,
      curated_at: new Date().toISOString().slice(0, 10),
      custom: true,
    });
  }
  return { sources };
}

export function sourceFromStored(row) {
  if (!row) return null;
  let discovery = [];
  try {
    discovery = JSON.parse(row.discovery_json || "[]");
  } catch {
    discovery = [];
  }
  if (!Array.isArray(discovery) || !discovery.length) {
    discovery = discoveryFromUrl(row.url).map((entry, rank) => ({
      ...entry,
      enabled: entry.enabled !== false,
      rank: rank + 1,
    }));
  }
  const primary = discovery.find((entry) => entry.enabled !== false && entry.url) || discovery[0] || {};
  const platform =
    row.platform || (Number(row.rank) === 1 ? "official" : Number(row.rank) === 3 ? "agency" : "newspaper");
  return {
    id: row.id,
    mayor_id: row.mayor_id,
    domain: row.domain,
    name: row.name,
    tier: Number(row.tier) || 0,
    platform,
    rank: Number(row.rank) || 0,
    discovery,
    kind: row.kind || strategyKind(primary.type),
    url: row.url || primary.url || "",
    adapter: discovery.find((entry) => entry.type === "newsroom")?.adapter || "generic",
    verified: Number(row.verified) || 0,
    curated_at: row.curated_at || "",
    custom: true,
  };
}

function hostOf(value) {
  try {
    return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return "";
  }
}

function domainMatches(host, domain) {
  const approved = domain.replace(/^www\./i, "").toLowerCase();
  return host === approved || host.endsWith(`.${approved}`);
}

/** البوابة الوحيدة: لا يُفتح رابط إلا إن كان نطاقه معتمدًا لهذا المكتب. */
export function approvedSourceFor(url, mayorId) {
  const host = hostOf(url);
  if (!host) return null;
  return sourcesFor(mayorId).find((source) => domainMatches(host, source.domain)) || null;
}

export function isApprovedUrl(url, mayorId) {
  return Boolean(approvedSourceFor(url, mayorId));
}
