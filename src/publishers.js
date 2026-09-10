import { MAYORS, isAboutMayor } from "./mayors.js";
import { APPROVED_SOURCES } from "./sources.js";
import { isAggregatorHost, publisherDomain, resolvePublisherDomain } from "./domain.js";
import { pickConfidence } from "./dedup.js";
import { REASON } from "./reasons.js";
import { splitHeadline } from "./text.js";

export const UNTRUSTED_REASON = REASON.UNTRUSTED;
export const UNRELATED_REASON = REASON.UNRELATED;

const GLOBAL = [
  ["reuters.com", "Reuters"],
  ["apnews.com", "Associated Press"],
  ["afp.com", "AFP"],
  ["bbc.com", "BBC"],
  ["bbc.co.uk", "BBC"],
];

const BY_COUNTRY = {
  KR: [
    ["korea.kr", "Korea.kr", 0],
    ["yna.co.kr", "Yonhap"],
    ["yonhapnews.co.kr", "Yonhap"],
    ["koreaherald.com", "Korea Herald"],
    ["koreatimes.co.kr", "Korea Times"],
    ["koreajoongangdaily.joins.com", "JoongAng Daily"],
    ["joins.com", "JoongAng"],
    ["hani.co.kr", "Hankyoreh"],
    ["chosun.com", "Chosun"],
    ["donga.com", "Donga"],
    ["khan.co.kr", "Kyunghyang"],
    ["kbs.co.kr", "KBS"],
    ["mk.co.kr", "Maeil Business"],
    ["news1.kr", "News1"],
  ],
  ES: [
    ["elpais.com", "El País"],
    ["elmundo.es", "El Mundo"],
    ["abc.es", "ABC"],
    ["lavanguardia.com", "La Vanguardia"],
    ["rtve.es", "RTVE"],
    ["efe.com", "EFE"],
    ["europapress.es", "Europa Press"],
    ["eldiario.es", "elDiario"],
    ["elconfidencial.com", "El Confidencial"],
    ["diariosur.es", "Diario Sur"],
    ["laopiniondemalaga.es", "La Opinión de Málaga"],
  ],
  GB: [
    ["theguardian.com", "The Guardian"],
    ["telegraph.co.uk", "The Telegraph"],
    ["independent.co.uk", "The Independent"],
    ["ft.com", "Financial Times"],
    ["chroniclelive.co.uk", "Chronicle Live"],
    ["thenorthernecho.co.uk", "The Northern Echo"],
  ],
  JO: [
    ["petra.gov.jo", "Petra", 0],
    ["jordantimes.com", "Jordan Times"],
    ["alghad.com", "Al Ghad"],
    ["alrai.com", "Al Rai"],
    ["addustour.com", "Ad-Dustour"],
  ],
  IQ: [
    ["ina.iq", "INA"],
    ["nina.iq", "NINA"],
    ["shafaq.com", "Shafaq"],
    ["alsumaria.tv", "Alsumaria"],
  ],
  OM: [
    ["omannews.gov.om", "Oman News", 0],
    ["omanobserver.om", "Oman Observer"],
    ["timesofoman.com", "Times of Oman"],
  ],
  XK: [
    ["koha.net", "Koha"],
    ["rtklive.com", "RTK"],
    ["balkaninsight.com", "Balkan Insight"],
  ],
  IT: [
    ["ansa.it", "ANSA"],
    ["repubblica.it", "La Repubblica"],
    ["corriere.it", "Corriere"],
    ["lastampa.it", "La Stampa"],
    ["rainews.it", "Rai News"],
    ["ilsole24ore.com", "Il Sole 24 Ore"],
    ["torinotoday.it", "TorinoToday"],
    ["quotidianopiemontese.it", "Quotidiano Piemontese"],
  ],
  JP: [
    ["nhk.or.jp", "NHK"],
    ["nikkei.com", "Nikkei"],
    ["asahi.com", "Asahi"],
    ["mainichi.jp", "Mainichi"],
    ["yomiuri.co.jp", "Yomiuri"],
    ["japantimes.co.jp", "Japan Times"],
    ["kyodo.co.jp", "Kyodo"],
    ["jiji.com", "Jiji"],
  ],
  MA: [
    ["map.ma", "MAP", 0],
    ["lematin.ma", "Le Matin"],
    ["leconomiste.com", "L'Économiste"],
    ["telquel.ma", "TelQuel"],
    ["hespress.com", "Hespress"],
  ],
  GR: [
    ["amna.gr", "AMNA"],
    ["kathimerini.gr", "Kathimerini"],
    ["efsyn.gr", "Efsyn"],
    ["naftemporiki.gr", "Naftemporiki"],
    ["ert.gr", "ERT"],
    ["ertnews.gr", "ERT News"],
  ],
};

function row(domain, name, tier, country_code, mayor_id) {
  return {
    id: `${mayor_id || country_code || "global"}:${domain}`,
    domain,
    name,
    tier,
    country_code: country_code || null,
    mayor_id: mayor_id || null,
  };
}

export function buildPublishers() {
  const out = [];
  const seen = new Set();
  const add = (item) => {
    if (!item.domain || seen.has(item.id)) return;
    seen.add(item.id);
    out.push(item);
  };

  /**
   * سجل المصادر المعتمدة يأتي أولًا لأنه هو الحاكم: كل نطاق يسمح الرصد بفتحه
   * يجب أن يكون موثوقًا بالضرورة، وإلا فتحنا صفحة ثم استبعدناها بلا معنى.
   */
  for (const source of APPROVED_SOURCES) {
    const mayor = MAYORS.find((entry) => entry.id === source.mayor_id);
    add(row(source.domain, source.name, source.tier, mayor?.country_code || null, source.mayor_id));
  }
  for (const [domain, name] of GLOBAL) {
    add(row(domain, name, 1, null, null));
  }
  for (const mayor of MAYORS) {
    if (mayor.official_host) {
      add(row(mayor.official_host, mayor.title_en, 0, mayor.country_code, mayor.id));
    }
    for (const entry of BY_COUNTRY[mayor.country_code] || []) {
      const [domain, name, tier = 1] = entry;
      add(row(domain, name, tier, mayor.country_code, null));
    }
  }
  return out;
}

export const PUBLISHERS = buildPublishers();

export function matchPublisher(domain, mayor) {
  if (!domain || isAggregatorHost(domain)) return null;
  const hits = PUBLISHERS.filter((p) => {
    const same =
      domain === p.domain || domain.endsWith(`.${p.domain}`) || p.domain.endsWith(`.${domain}`);
    if (!same) return false;
    if (p.mayor_id && p.mayor_id !== mayor.id) return false;
    if (p.country_code && p.country_code !== mayor.country_code) return false;
    return true;
  });
  if (!hits.length) return null;
  hits.sort((a, b) => {
    const spec = (p) => (p.mayor_id ? 0 : p.country_code ? 1 : 2);
    return a.tier - b.tier || spec(a) - spec(b);
  });
  return hits[0];
}

function outletMatchesPublisher(outlet, pub) {
  const hay = String(outlet || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!hay) return false;
  const name = String(pub.name || "").toLowerCase();
  if (hay === name) return true;
  if (name.length >= 5 && hay.includes(name)) return true;
  if (hay.length >= 5 && name.includes(hay)) return true;
  return false;
}

export function inferPublisher(row, mayor) {
  const domain = resolvePublisherDomain(row);
  const matched = matchPublisher(domain, mayor);
  if (matched) return matched;
  const { outlet } = splitHeadline(row.title || "");
  if (!outlet) return null;
  const asHost = publisherDomain(/^https?:/i.test(outlet) ? outlet : `https://${outlet}`);
  const byHost = matchPublisher(asHost, mayor);
  if (byHost) return byHost;
  const hits = PUBLISHERS.filter((p) => {
    if (p.mayor_id && p.mayor_id !== mayor.id) return false;
    if (p.country_code && p.country_code !== mayor.country_code) return false;
    return outletMatchesPublisher(outlet, p);
  });
  hits.sort((a, b) => a.tier - b.tier || b.name.length - a.name.length);
  return hits[0] || null;
}

export function classifyItem(row, mayor) {
  const domain = resolvePublisherDomain(row);
  const pub = inferPublisher(row, mayor);
  const relevant = isAboutMayor(`${row.title || ""} ${row.snippet || ""} ${row.page_body || ""}`, mayor);

  if (!pub) {
    return {
      status: "excluded",
      exclude_reason: UNTRUSTED_REASON,
      confidence: "raw",
      publisher_domain: domain || null,
      publisher_tier: null,
    };
  }

  if (!relevant) {
    return {
      status: "excluded",
      exclude_reason: UNRELATED_REASON,
      confidence: pub.tier === 0 ? "official" : pickConfidence(row.source, 0),
      publisher_domain: pub.domain,
      publisher_tier: pub.tier,
    };
  }

  const official = pub.tier === 0 || row.source === "official";
  return {
    status: "inbox",
    exclude_reason: null,
    confidence: official ? "official" : pickConfidence(row.source, 0),
    publisher_domain: pub.domain,
    publisher_tier: pub.tier,
  };
}
