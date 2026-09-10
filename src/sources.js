/**
 * سجل المصادر المعتمدة — حوكمة الرصد.
 *
 * لا يفتح المكتب أي رابط لا ينتمي إلى نطاق معتمد هنا. لا محركات بحث ولا مجمّعات:
 * روابط جوجل نيوز ملفوفة ومعمّاة ومحدودة المعدل فلا تُقرأ أصلًا، وبينج يعيد
 * نطاقات غير موثوقة نستبعدها بعد أن ندفع كلفة فتحها. إغلاق القائمة يجعل كل
 * رابط مكتشف موثوقًا قبل فتحه، فترتفع الدقة وتنخفض الكلفة معًا.
 *
 * لكل مكتب ثلاثة مصادر على الأكثر، مرتبة بالأولوية:
 *   1. غرفة الأخبار الرسمية للمدينة.
 *   2. أقوى تغطية محلية للمدينة.
 *   3. وكالة أو صحيفة وطنية تغطي المدينة.
 *
 * `kind` يحدد طريقة الوصول لا مستوى الثقة:
 *   feed — تغذية RSS/Atom مُتحقَّق منها، وهي الأرخص والأدق.
 *   page — صفحة أخبار الموقع نفسه، لمن لا ينشر تغذية. الاستخراج محصور في
 *          النطاق المعتمد نفسه، فلا تتسع القائمة ضمنًا.
 *
 * كل تغذية أدناه تم فحصها بطلب فعلي: تعيد عناصر، وروابطها مباشرة لا ملفوفة.
 * ما لا تغذية له وُضع بصيغة page بعد التأكد من عدم إعلانه أي تغذية.
 */

const REGISTRY = {
  turin: [
    {
      domain: "comune.torino.it",
      name: "Comune di Torino",
      tier: 0,
      kind: "feed",
      url: "https://www.comune.torino.it/rss.xml",
    },
    {
      domain: "torinoclick.it",
      name: "Torino Click",
      tier: 0,
      kind: "feed",
      url: "https://www.torinoclick.it/feed/",
    },
    {
      domain: "torino.repubblica.it",
      name: "La Repubblica Torino",
      tier: 1,
      kind: "feed",
      url: "https://torino.repubblica.it/rss/rss2.0.xml",
    },
  ],
  seoul: [
    {
      domain: "seoul.go.kr",
      name: "Seoul Metropolitan Government",
      tier: 0,
      kind: "feed",
      url: "https://english.seoul.go.kr/rss",
    },
    {
      domain: "yna.co.kr",
      name: "Yonhap News",
      tier: 1,
      kind: "feed",
      url: "https://www.yna.co.kr/rss/politics.xml",
    },
    {
      domain: "koreaherald.com",
      name: "The Korea Herald",
      tier: 1,
      kind: "feed",
      url: "https://www.koreaherald.com/rss/newsAll",
    },
  ],
  madrid: [
    {
      domain: "diario.madrid.es",
      name: "Diario de Madrid",
      tier: 0,
      kind: "page",
      url: "https://diario.madrid.es/",
    },
    {
      domain: "europapress.es",
      name: "Europa Press Madrid",
      tier: 1,
      kind: "feed",
      url: "https://www.europapress.es/rss/rss.aspx?ch=283",
    },
    {
      domain: "elmundo.es",
      name: "El Mundo Madrid",
      tier: 1,
      kind: "feed",
      url: "https://www.elmundo.es/rss/madrid.xml",
    },
  ],
  malaga: [
    {
      domain: "malaga.eu",
      name: "Ayuntamiento de Málaga",
      tier: 0,
      kind: "page",
      url: "https://prensa.malaga.eu/",
    },
    {
      domain: "diariosur.es",
      name: "Diario Sur Málaga",
      tier: 1,
      kind: "feed",
      url: "https://www.diariosur.es/rss/2.0/?section=malaga",
    },
    {
      domain: "europapress.es",
      name: "Europa Press Andalucía",
      tier: 1,
      kind: "feed",
      url: "https://www.europapress.es/rss/rss.aspx?ch=00356",
    },
  ],
  "northeast-england": [
    {
      domain: "northeast-ca.gov.uk",
      name: "North East Combined Authority",
      tier: 0,
      kind: "page",
      url: "https://www.northeast-ca.gov.uk/news/",
    },
    {
      domain: "chroniclelive.co.uk",
      name: "Chronicle Live",
      tier: 1,
      kind: "feed",
      url: "https://www.chroniclelive.co.uk/news/north-east-news/?service=rss",
    },
    {
      domain: "thenorthernecho.co.uk",
      name: "The Northern Echo",
      tier: 1,
      kind: "feed",
      url: "https://www.thenorthernecho.co.uk/news/rss/",
    },
  ],
  amman: [
    {
      domain: "ammancity.gov.jo",
      name: "أمانة عمّان الكبرى",
      tier: 0,
      kind: "page",
      url: "https://www.ammancity.gov.jo/ar/gam/news.aspx",
    },
    {
      domain: "roya.tv",
      name: "رؤيا",
      tier: 1,
      kind: "feed",
      url: "https://roya.tv/rss",
    },
    {
      domain: "almamlakatv.com",
      name: "المملكة",
      tier: 1,
      kind: "feed",
      url: "https://www.almamlakatv.com/rss.xml",
    },
  ],
  baghdad: [
    {
      domain: "amanatbaghdad.gov.iq",
      name: "أمانة بغداد",
      tier: 0,
      kind: "page",
      url: "https://amanatbaghdad.gov.iq/news",
    },
    {
      domain: "baghdadtoday.news",
      name: "بغداد اليوم",
      tier: 1,
      kind: "feed",
      url: "https://baghdadtoday.news/rss.xml",
    },
    {
      domain: "ina.iq",
      name: "الوكالة العراقية للأنباء",
      tier: 1,
      kind: "feed",
      url: "https://www.ina.iq/rss.xml",
    },
  ],
  muscat: [
    {
      domain: "mm.gov.om",
      name: "بلدية مسقط",
      tier: 0,
      kind: "page",
      url: "https://www.mm.gov.om/",
    },
    {
      domain: "timesofoman.com",
      name: "Times of Oman",
      tier: 1,
      kind: "feed",
      url: "https://timesofoman.com/feed/",
    },
    {
      domain: "omanobserver.om",
      name: "Oman Observer",
      tier: 1,
      kind: "page",
      url: "https://www.omanobserver.om/oman",
    },
  ],
  osaka: [
    {
      domain: "city.osaka.lg.jp",
      name: "大阪市",
      tier: 0,
      kind: "page",
      url: "https://www.city.osaka.lg.jp/hodohappyo/",
    },
    {
      domain: "nhk.or.jp",
      name: "NHK",
      tier: 1,
      kind: "feed",
      url: "https://www.nhk.or.jp/rss/news/cat0.xml",
    },
    {
      domain: "asahi.com",
      name: "朝日新聞",
      tier: 1,
      kind: "feed",
      url: "https://www.asahi.com/rss/asahi/newsheadlines.rdf",
    },
  ],
  athens: [
    {
      domain: "cityofathens.gr",
      name: "Δήμος Αθηναίων",
      tier: 0,
      kind: "page",
      url: "https://www.cityofathens.gr/",
    },
    {
      domain: "efsyn.gr",
      name: "Εφημερίδα των Συντακτών",
      tier: 1,
      kind: "feed",
      url: "https://www.efsyn.gr/rss.xml",
    },
    {
      domain: "in.gr",
      name: "in.gr",
      tier: 1,
      kind: "feed",
      url: "https://www.in.gr/feed/",
    },
  ],
  pristina: [
    {
      domain: "prishtinaonline.com",
      name: "Komuna e Prishtinës",
      tier: 0,
      kind: "page",
      url: "https://prishtinaonline.com/lajme",
    },
    {
      domain: "telegrafi.com",
      name: "Telegrafi",
      tier: 1,
      kind: "feed",
      url: "https://telegrafi.com/feed/",
    },
    {
      domain: "kallxo.com",
      name: "Kallxo",
      tier: 1,
      kind: "feed",
      url: "https://kallxo.com/feed/",
    },
  ],
  rabat: [
    {
      domain: "rabat.ma",
      name: "جماعة الرباط",
      tier: 0,
      kind: "page",
      url: "https://www.rabat.ma/",
    },
    {
      domain: "hespress.com",
      name: "هسبريس",
      tier: 1,
      kind: "feed",
      url: "https://www.hespress.com/feed",
    },
    {
      domain: "telquel.ma",
      name: "TelQuel",
      tier: 1,
      kind: "feed",
      url: "https://telquel.ma/feed",
    },
  ],
};

export const MAX_SOURCES_PER_OFFICE = 3;

/** تاريخ الفحص العميق الذي اختير على أساسه هذا السجل. */
export const CURATED_AT = "2026-09-10";

/**
 * نتيجة الفحص العميق لكل مصدر: أعاد عناصر حقيقية بروابط مباشرة أم لا.
 * غرف الأخبار الرسمية الغائبة هنا فُحصت كذلك لكنها لم تستجب من شبكة الفحص
 * (حجب 403، أو تعذّر DNS، أو صفحة بلا روابط أخبار)، وتبقى في السجل لأنها
 * المصدر الأصلي للمدينة وقد تستجيب من شبكة Cloudflare، فيحكم عليها التشغيل.
 */
const VERIFIED_AT_CURATION = new Set([
  "turin:comune.torino.it",
  "turin:torinoclick.it",
  "turin:torino.repubblica.it",
  "seoul:seoul.go.kr",
  "seoul:yna.co.kr",
  "seoul:koreaherald.com",
  "madrid:europapress.es",
  "madrid:elmundo.es",
  "malaga:diariosur.es",
  "malaga:europapress.es",
  "northeast-england:chroniclelive.co.uk",
  "northeast-england:thenorthernecho.co.uk",
  "amman:roya.tv",
  "amman:almamlakatv.com",
  "baghdad:baghdadtoday.news",
  "baghdad:ina.iq",
  "muscat:timesofoman.com",
  "muscat:omanobserver.om",
  "osaka:nhk.or.jp",
  "osaka:asahi.com",
  "athens:efsyn.gr",
  "athens:in.gr",
  "pristina:telegrafi.com",
  "pristina:kallxo.com",
  "rabat:hespress.com",
  "rabat:telquel.ma",
]);

function withIds(mayorId, entries) {
  return entries.slice(0, MAX_SOURCES_PER_OFFICE).map((entry, index) => {
    const id = `${mayorId}:${entry.domain}`;
    return {
      ...entry,
      id,
      mayor_id: mayorId,
      rank: index + 1,
      verified: VERIFIED_AT_CURATION.has(id) ? 1 : 0,
      curated_at: CURATED_AT,
    };
  });
}

export const APPROVED_SOURCES = Object.entries(REGISTRY).flatMap(([mayorId, entries]) =>
  withIds(mayorId, entries),
);

export function sourcesFor(mayorId) {
  return APPROVED_SOURCES.filter((source) => source.mayor_id === mayorId);
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
  return (
    sourcesFor(mayorId).find((source) => domainMatches(host, source.domain)) || null
  );
}

export function isApprovedUrl(url, mayorId) {
  return Boolean(approvedSourceFor(url, mayorId));
}
