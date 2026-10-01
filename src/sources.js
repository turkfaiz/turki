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
      domain: "en.sedaily.com",
      name: "Seoul Economic Daily",
      tier: 1,
      platform: "newspaper",
      discovery: [
        step("rss", { url: "https://en.sedaily.com/RSS" }),
        step("newsroom", { url: "https://en.sedaily.com/", adapter: "generic" }),
      ],
    },
  ],
  madrid: [
    {
      domain: "madridiario.es",
      name: "Madridiario",
      tier: 1,
      platform: "newspaper",
      discovery: [
        step("rss", { url: "https://www.madridiario.es/rss" }),
        step("newsroom", { url: "https://www.madridiario.es/", adapter: "generic" }),
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
      domain: "sunderlandecho.com",
      name: "Sunderland Echo",
      tier: 1,
      platform: "newspaper",
      discovery: [
        step("rss", { url: "https://www.sunderlandecho.com/rss" }),
        step("newsroom", { url: "https://www.sunderlandecho.com/", adapter: "generic" }),
      ],
    },
    {
      domain: "newcastlemagazine.com",
      name: "Newcastle Magazine",
      tier: 1,
      platform: "newspaper",
      discovery: [
        step("rss", { url: "https://www.newcastlemagazine.com/feed" }),
        step("newsroom", { url: "https://www.newcastlemagazine.com/", adapter: "generic" }),
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
      domain: "media.ammancity.gov.jo",
      name: "إعلام أمانة عمّان",
      tier: 0,
      platform: "official",
      discovery: [
        step("newsroom", { url: "https://media.ammancity.gov.jo/", adapter: "generic" }),
      ],
    },
    {
      domain: "petra.gov.jo",
      name: "وكالة الأنباء الأردنية بترا",
      tier: 1,
      platform: "agency",
      discovery: [
        step("newsroom", { url: "https://www.petra.gov.jo/", adapter: "generic" }),
      ],
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
      domain: "iraqinews.com",
      name: "Iraqi News",
      tier: 1,
      platform: "newspaper",
      discovery: [
        step("rss", { url: "https://www.iraqinews.com/feed/" }),
        step("newsroom", { url: "https://www.iraqinews.com/", adapter: "generic" }),
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
      domain: "tv-osaka.co.jp",
      name: "テレビ大阪",
      tier: 1,
      platform: "newspaper",
      discovery: [
        step("newsroom", { url: "https://www.tv-osaka.co.jp/", adapter: "generic" }),
      ],
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
      domain: "athens24.com",
      name: "Athens 24",
      tier: 1,
      platform: "newspaper",
      discovery: [
        step("rss", { url: "https://www.athens24.com/feed/" }),
        step("newsroom", { url: "https://www.athens24.com/", adapter: "generic" }),
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
/** سقف كتابة لكل فحص مصدر: الأرشيف بلا تاريخ كان يفرّغ Sitemap في D1. */
export const MAX_CANDIDATES_PER_SOURCE_POLL = 25;
export const MAX_PENDING_CANDIDATES_PER_SOURCE = 40;

const VERIFIED_AT_CURATION = new Set([
  "turin:comune.torino.it",
  "turin:torinoclick.it",
  "turin:torino.repubblica.it",
  "seoul:seoul.go.kr",
  "seoul:yna.co.kr",
  "madrid:europapress.es",
  "madrid:elmundo.es",
  "malaga:malaga.eu",
  "malaga:diariosur.es",
  "malaga:europapress.es",
  "northeast-england:thenorthernecho.co.uk",
  "amman:almamlakatv.com",
  "baghdad:baghdadtoday.news",
  "baghdad:ina.iq",
  "muscat:mm.gov.om",
  "muscat:timesofoman.com",
  "muscat:omanobserver.om",
  "osaka:city.osaka.lg.jp",
  "osaka:asahi.com",
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

/** مصادر السجل المكتوب في الشيفرة: بذرة ثابتة تُزرع في كل ترحيل. */
export const APPROVED_SOURCES = Object.entries(REGISTRY).flatMap(([mayorId, entries]) =>
  withIds(mayorId, entries),
);

/**
 * مصادر أضافها الموظف من الإعدادات. تُحمَّل من D1 إلى ذاكرة العامل عند بدء كل
 * طلب أو مهمة (`refreshCustomSources`)، فتمر عبر نفس بوابة الحوكمة التي تمر بها
 * مصادر الشيفرة: نطاق معتمد لمكتبه فقط، وتحويلات مراقبة، وهوية العمدة إلزامية.
 */
let customSources = [];

export function setCustomSources(rows) {
  customSources = (rows || []).map(customSourceFromRow).filter(Boolean);
}

export function customSourceFromRow(row) {
  let discovery;
  try {
    discovery = JSON.parse(row.discovery_json || "[]");
  } catch {
    return null;
  }
  if (!row.id || !row.mayor_id || !row.domain || !Array.isArray(discovery)) return null;
  discovery = discovery.map((entry, index) => ({
    ...entry,
    enabled: entry.enabled !== false,
    rank: index + 1,
  }));
  const primary = discovery.find((entry) => entry.enabled && entry.url && !entry.supplement) || discovery[0] || {};
  return {
    id: row.id,
    mayor_id: row.mayor_id,
    domain: row.domain,
    name: row.name || row.domain,
    tier: row.tier == null ? 1 : Number(row.tier),
    platform: row.platform || "newspaper",
    discovery,
    kind: strategyKind(primary.type),
    url: primary.url || row.url || "",
    adapter: discovery.find((entry) => entry.type === "newsroom")?.adapter || "generic",
    rank: Number(row.rank) || 1,
    verified: 1,
    curated_at: row.curated_at || "",
    origin: "custom",
  };
}

/** كل المصادر المعتمدة الآن: السجل المكتوب ثم ما أضافه الموظف. */
export function allSources() {
  return customSources.length ? [...APPROVED_SOURCES, ...customSources] : APPROVED_SOURCES;
}

/**
 * شرط SQL يحصر قراءة جدول sources في المسجّل: ما في الشيفرة، أو ما أضافه الموظف
 * (origin = 'custom'). صفوف مصادر استُبدلت في الشيفرة تبقى في القاعدة بلا حذف
 * لكنها لا تُعدّ ولا تُعرض. المعرّفات ثوابت من السجل، وليست مدخلات.
 */
export function registeredSourcesSql(prefix = "") {
  return `(${prefix}id IN (${APPROVED_SOURCES.map((source) => `'${source.id}'`).join(", ")}) OR ${prefix}origin = 'custom')`;
}

export function sourcesFor(mayorId) {
  return allSources().filter((source) => source.mayor_id === mayorId);
}

export function sourceById(id) {
  return allSources().find((source) => source.id === id) || null;
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
