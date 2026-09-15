/** المرحلة 1: 12 عمدة. الرصد = الاسم الإنجليزي + لغة الأم. العربي للعرض فقط. */
export const MAYORS = [
  {
    id: "seoul",
    country_ar: "كوريا الجنوبية",
    city_ar: "سيئول",
    city_en: "Seoul",
    title_ar: "عمدة سيئول",
    title_en: "Mayor of Seoul",
    name_en: "Oh Se-hoon",
    name_native: "오세훈",
    name_ar: "أوه سيه هون",
    native_lang: "ko",
    native_lang_ar: "الكورية",
    country_code: "KR",
    gn_hl: "ko",
    gn_gl: "KR",
    official_host: "seoul.go.kr",
  },
  {
    id: "madrid",
    country_ar: "إسبانيا",
    city_ar: "مدريد",
    city_en: "Madrid",
    title_ar: "عمدة مدريد",
    title_en: "Mayor of Madrid",
    name_en: "José Luis Martínez-Almeida",
    name_native: "José Luis Martínez-Almeida",
    name_ar: "خوسيه لويس مارتينيز ألميدا",
    native_lang: "es",
    native_lang_ar: "الإسبانية",
    country_code: "ES",
    gn_hl: "es",
    gn_gl: "ES",
    official_host: "madrid.es",
  },
  {
    id: "northeast-england",
    country_ar: "المملكة المتحدة",
    city_ar: "شمال شرق إنجلترا",
    city_en: "North East England",
    title_ar: "عمدة إقليم شمال شرق إنجلترا",
    title_en: "Mayor of the North East",
    name_en: "Kim McGuinness",
    name_native: "Kim McGuinness",
    name_ar: "كيم ماكغينيس",
    native_lang: "en",
    native_lang_ar: "الإنجليزية",
    country_code: "GB",
    gn_hl: "en-GB",
    gn_gl: "GB",
    official_host: "northeast-ca.gov.uk",
  },
  {
    id: "amman",
    country_ar: "الأردن",
    city_ar: "عمّان",
    city_en: "Amman",
    title_ar: "أمين عمّان الكبرى",
    title_en: "Mayor of Greater Amman",
    name_en: "Yousef Al-Shawarbeh",
    name_native: "يوسف الشواربة",
    name_ar: "د. يوسف الشواربة",
    native_lang: "ar",
    native_lang_ar: "العربية",
    country_code: "JO",
    gn_hl: "ar",
    gn_gl: "JO",
    official_host: "ammancity.gov.jo",
  },
  {
    id: "baghdad",
    country_ar: "العراق",
    city_ar: "بغداد",
    city_en: "Baghdad",
    title_ar: "أمين بغداد",
    title_en: "Mayor of Baghdad",
    name_en: "Ammar Musa Kadhim",
    name_native: "عمار موسى كاظم",
    name_ar: "عمار موسى كاظم",
    native_lang: "ar",
    native_lang_ar: "العربية",
    country_code: "IQ",
    gn_hl: "ar",
    gn_gl: "IQ",
    official_host: "amanatbaghdad.gov.iq",
  },
  {
    id: "muscat",
    country_ar: "سلطنة عُمان",
    city_ar: "مسقط",
    city_en: "Muscat",
    title_ar: "رئيس بلدية مسقط",
    title_en: "Chairman of Muscat Municipality",
    name_en: "Ahmed bin Mohammed Al-Humaidi",
    name_native: "أحمد بن محمد الحميدي",
    name_ar: "أحمد بن محمد الحميدي",
    native_lang: "ar",
    native_lang_ar: "العربية",
    country_code: "OM",
    gn_hl: "ar",
    gn_gl: "OM",
    official_host: "mm.gov.om",
  },
  {
    id: "malaga",
    country_ar: "إسبانيا",
    city_ar: "مالقة",
    city_en: "Malaga",
    title_ar: "عمدة مالقة",
    title_en: "Mayor of Malaga",
    name_en: "Francisco de la Torre",
    name_native: "Francisco de la Torre",
    name_ar: "فرانسيسكو دي لا توري",
    native_lang: "es",
    native_lang_ar: "الإسبانية",
    country_code: "ES",
    gn_hl: "es",
    gn_gl: "ES",
    official_host: "malaga.eu",
  },
  {
    id: "pristina",
    country_ar: "كوسوفو",
    city_ar: "بريشتينا",
    city_en: "Pristina",
    title_ar: "عمدة بريشتينا",
    title_en: "Mayor of Pristina",
    name_en: "Perparim Rama",
    name_native: "Përparim Rama",
    name_ar: "بيرباريم راما",
    native_lang: "sq",
    native_lang_ar: "الألبانية",
    country_code: "XK",
    gn_hl: "en",
    gn_gl: "US",
    official_host: "prishtinaonline.com",
  },
  {
    id: "turin",
    country_ar: "إيطاليا",
    city_ar: "تورينو",
    city_en: "Turin",
    title_ar: "عمدة تورينو",
    title_en: "Mayor of Turin",
    name_en: "Stefano Lo Russo",
    name_native: "Stefano Lo Russo",
    name_ar: "ستيفانو لو روسو",
    native_lang: "it",
    native_lang_ar: "الإيطالية",
    country_code: "IT",
    gn_hl: "it",
    gn_gl: "IT",
    official_host: "comune.torino.it",
  },
  {
    id: "osaka",
    country_ar: "اليابان",
    city_ar: "أوساكا",
    city_en: "Osaka",
    title_ar: "عمدة مدينة أوساكا",
    title_en: "Mayor of Osaka",
    name_en: "Hideyuki Yokoyama",
    name_native: "横山英幸",
    name_ar: "هيدييوكي يوكوياما",
    native_lang: "ja",
    native_lang_ar: "اليابانية",
    country_code: "JP",
    gn_hl: "ja",
    gn_gl: "JP",
    official_host: "city.osaka.lg.jp",
  },
  {
    id: "rabat",
    country_ar: "المغرب",
    city_ar: "الرباط",
    city_en: "Rabat",
    title_ar: "عمدة الرباط",
    title_en: "Mayor of Rabat",
    name_en: "Fatiha El Moudni",
    name_native: "فتيحة المودني",
    name_ar: "فتيحة المودني",
    native_lang: "ar",
    native_lang_ar: "العربية",
    country_code: "MA",
    gn_hl: "ar",
    gn_gl: "MA",
    official_host: "mairiederabat.ma",
  },
  {
    id: "athens",
    country_ar: "اليونان",
    city_ar: "أثينا",
    city_en: "Athens",
    title_ar: "عمدة أثينا",
    title_en: "Mayor of Athens",
    name_en: "Haris Doukas",
    name_native: "Χάρης Δούκας",
    name_ar: "هاريس دوكاس",
    native_lang: "el",
    native_lang_ar: "اليونانية",
    country_code: "GR",
    gn_hl: "el",
    gn_gl: "GR",
    official_host: "cityofathens.gr",
  },
];

export function mayorById(id) {
  return MAYORS.find((m) => m.id === id) || null;
}

export const SEED_MAYOR_IDS = new Set(MAYORS.map((mayor) => mayor.id));

const MAYOR_FIELDS = [
  "id",
  "country_ar",
  "city_ar",
  "city_en",
  "title_ar",
  "title_en",
  "name_en",
  "name_native",
  "name_ar",
  "native_lang",
  "native_lang_ar",
  "country_code",
  "gn_hl",
  "gn_gl",
  "official_host",
];

function clip(value, max) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function mayorFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    country_ar: row.country_ar,
    city_ar: row.city_ar,
    city_en: row.city_en,
    title_ar: row.title_ar,
    title_en: row.title_en,
    name_en: row.name_en,
    name_native: row.name_native,
    name_ar: row.name_ar,
    native_lang: row.native_lang,
    native_lang_ar: row.native_lang_ar,
    country_code: row.country_code,
    gn_hl: row.gn_hl,
    gn_gl: row.gn_gl,
    official_host: row.official_host || "",
    origin: SEED_MAYOR_IDS.has(row.id) ? "seed" : "custom",
  };
}

export function slugifyMayorId(cityEn, nameEn) {
  const raw = `${cityEn || ""}-${nameEn || ""}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (/^[a-z][a-z0-9-]{1,39}$/.test(raw)) return raw;
  return "";
}

export function normalizeOfficialHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let host = raw;
  try {
    if (/^https?:\/\//i.test(raw) || raw.includes("/")) {
      const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
      host = url.hostname;
    }
  } catch {
    return "";
  }
  host = host.replace(/^www\./i, "").replace(/\.$/, "").toLowerCase();
  if (!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
    return "";
  }
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    /^(127\.|10\.|192\.168\.|169\.254\.)/.test(host)
  ) {
    return "";
  }
  return host;
}

const LANG_AR = {
  ar: "العربية",
  en: "الإنجليزية",
  es: "الإسبانية",
  it: "الإيطالية",
  ja: "اليابانية",
  ko: "الكورية",
  el: "اليونانية",
  sq: "الألبانية",
  zh: "الصينية",
  fr: "الفرنسية",
  de: "الألمانية",
  pt: "البرتغالية",
  tr: "التركية",
  fa: "الفارسية",
  ur: "الأردية",
  hi: "الهندية",
  ru: "الروسية",
  nl: "الهولندية",
  sv: "السويدية",
  pl: "البولندية",
  uk: "الأوكرانية",
  id: "الإندونيسية",
  ms: "الملايوية",
  th: "التايلاندية",
  vi: "الفيتنامية",
  he: "العبرية",
};

export function parseMayorInput(body = {}) {
  const name_ar = clip(body.name_ar, 120);
  const name_en = clip(body.name_en, 120);
  const name_native = clip(body.name_native, 120) || name_en;
  const city_ar = clip(body.city_ar, 80);
  const city_en = clip(body.city_en, 80);
  const country_ar = clip(body.country_ar, 80);
  const country_code = clip(body.country_code, 8).toUpperCase();
  const title_ar = clip(body.title_ar, 120) || (city_ar ? `عمدة ${city_ar}` : "");
  const title_en = clip(body.title_en, 120) || (city_en ? `Mayor of ${city_en}` : "");
  const native_lang = clip(body.native_lang, 12).toLowerCase();
  const native_lang_ar =
    clip(body.native_lang_ar, 40) || LANG_AR[native_lang.split("-")[0]] || "";
  const official_host = body.official_host ? normalizeOfficialHost(body.official_host) : "";
  if (body.official_host && !official_host) {
    return { error: "bad_official_host", detail: "النطاق الرسمي يجب أن يكون اسم مضيف عامًا، بلا مسار." };
  }
  const required = {
    name_ar,
    name_en,
    name_native,
    city_ar,
    city_en,
    country_ar,
    country_code,
    title_ar,
    title_en,
    native_lang,
    native_lang_ar,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    return { error: "missing_fields", detail: missing };
  }
  if (!/^[A-Z]{2}$/.test(country_code)) {
    return { error: "bad_country_code", detail: "رمز الدولة حرفان لاتينيان، مثل SA." };
  }
  if (!/^[a-z]{2,3}(?:-[a-z]{2})?$/i.test(native_lang)) {
    return { error: "bad_native_lang", detail: "رمز لغة الرصد مثل ar أو ja أو zh." };
  }
  const requestedId = clip(body.id, 40).toLowerCase();
  const id = requestedId || slugifyMayorId(city_en, name_en);
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(id)) {
    return { error: "bad_id", detail: "معرّف المكتب يُشتق من المدينة والاسم الإنجليزي بأحرف لاتينية." };
  }
  if (SEED_MAYOR_IDS.has(id)) {
    return { error: "seed_mayor", detail: "هذا المكتب موجود في السجل الأساسي ولا يُضاف من الواجهة." };
  }
  return {
    mayor: {
      id,
      country_ar,
      city_ar,
      city_en,
      title_ar,
      title_en,
      name_en,
      name_native,
      name_ar,
      native_lang,
      native_lang_ar,
      country_code,
      gn_hl: native_lang,
      gn_gl: country_code,
      official_host,
      origin: "custom",
    },
  };
}

export function mayorInputMessage(parsed) {
  if (!parsed?.error) return "";
  if (parsed.error === "missing_fields") {
    return `أكمل البيانات الأساسية المطلوبة: ${(parsed.detail || []).join("، ")}`;
  }
  if (typeof parsed.detail === "string" && parsed.detail) return parsed.detail;
  return parsed.error;
}

export async function insertCustomMayor(env, mayor) {
  await env.DB.prepare(
    `INSERT INTO mayors (
       id, country_ar, city_ar, city_en, title_ar, title_en, name_en, name_native, name_ar,
       native_lang, native_lang_ar, country_code, gn_hl, gn_gl, official_host
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      mayor.id,
      mayor.country_ar,
      mayor.city_ar,
      mayor.city_en,
      mayor.title_ar,
      mayor.title_en,
      mayor.name_en,
      mayor.name_native,
      mayor.name_ar,
      mayor.native_lang,
      mayor.native_lang_ar,
      mayor.country_code,
      mayor.gn_hl,
      mayor.gn_gl,
      mayor.official_host || "",
    )
    .run();
  return { ...mayor, origin: "custom" };
}

export async function listMayors(env) {
  if (!env?.DB) return MAYORS.map((mayor) => ({ ...mayor, origin: "seed" }));
  const { results } = await env.DB.prepare(
    `SELECT ${MAYOR_FIELDS.join(", ")} FROM mayors ORDER BY country_ar, city_ar, name_ar`,
  ).all();
  const rows = (results || []).map(mayorFromRow);
  return rows.length ? rows : MAYORS.map((mayor) => ({ ...mayor, origin: "seed" }));
}

export async function resolveMayor(env, id) {
  if (!id) return null;
  if (env?.DB) {
    const row = await env.DB.prepare(
      `SELECT ${MAYOR_FIELDS.join(", ")} FROM mayors WHERE id = ?`,
    )
      .bind(id)
      .first();
    if (row) return mayorFromRow(row);
  }
  const seeded = mayorById(id);
  return seeded ? { ...seeded, origin: "seed" } : null;
}

export function buildSearchQueries(mayor, extra = "") {
  const extraBit = String(extra || "").trim();
  const nameClause =
    mayor.name_en === mayor.name_native
      ? `"${mayor.name_en}"`
      : `("${mayor.name_en}" OR "${mayor.name_native}")`;
  const base = extraBit ? `${nameClause} ${extraBit}` : `${nameClause} "${mayor.city_en}"`;
  const official = mayor.official_host
    ? `${nameClause} site:${mayor.official_host}`
    : null;
  return {
    native: base,
    english: extraBit
      ? `"${mayor.name_en}" ${extraBit}`
      : `"${mayor.name_en}" "${mayor.title_en}"`,
    official,
  };
}

export function relevanceTokens(mayor) {
  const parts = [
    mayor.name_en,
    mayor.name_native,
    mayor.city_en,
    mayor.city_ar,
    mayor.title_en,
    "mayor",
    "alcalde",
    "sindaco",
    "δήμαρχος",
    "시장",
    "市長",
    "أمين",
    "عمدة",
    "بلدية",
  ];
  return parts
    .flatMap((p) => String(p).split(/[\s,."()]+/))
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length >= 3);
}

export function identityTokens(mayor) {
  return [...new Set([mayor.name_en, mayor.name_native, mayor.name_ar].filter(Boolean))];
}

function identityText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f\u064b-\u065f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** الكتابات التي لا تفصل الكلمات بمسافات: الصينية واليابانية والكورية. */
const UNSPACED_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * المطابقة بحدود المسافات صحيحة للغات التي تفصل كلماتها، وخاطئة لما سواها:
 * «横山英幸市長» كلمة واحدة متصلة، و«오세훈은» تلتصق بها اللاحقة. اشتراط مسافة
 * حول الاسم كان يُسقط هذه الأخبار كلها رغم أنها عن العمدة صراحةً.
 */
function containsIdentity(text, phrase) {
  const hay = identityText(text);
  const needle = identityText(phrase);
  if (!hay || !needle) return false;
  if (UNSPACED_SCRIPT.test(needle)) {
    return needle.length >= 2 && hay.includes(needle);
  }
  return ` ${hay} `.includes(` ${needle} `);
}

/**
 * مطابقة موضوع البحث: كل كلمة في الموضوع يجب أن ترد في نص الخبر. المطابقة
 * تتجاهل الحركات وعلامات الترقيم، وتقبل التصاق اللواحق في الكتابات غير المفصولة.
 * السلوك «كل الكلمات» لا «أيها»، حتى لا يوسّع الموضوع النتائج بدل أن يضيّقها.
 */
export function matchesTopic(text, topic) {
  const words = identityText(topic).split(" ").filter(Boolean);
  if (!words.length) return true;
  const hay = identityText(text);
  if (!hay) return false;
  return words.every((word) =>
    UNSPACED_SCRIPT.test(word) ? hay.includes(word) : ` ${hay} `.includes(` ${word} `),
  );
}

export function isAboutMayor(text, mayor) {
  if (!text || !mayor) return false;
  const names = identityTokens(mayor);
  if (names.some((name) => containsIdentity(text, name))) return true;

  const englishParts = identityText(mayor.name_en).split(" ").filter(Boolean);
  const nativeParts = identityText(mayor.name_native).split(" ").filter(Boolean);
  const arabicParts = identityText(mayor.name_ar).split(" ").filter(Boolean);
  const surnamePhrases = [englishParts, nativeParts, arabicParts]
    .filter((parts) => parts.length >= 2)
    .map((parts) => parts.slice(-2).join(" "))
    .filter((phrase) => phrase.length >= 6);
  if (surnamePhrases.some((phrase) => containsIdentity(text, phrase))) return true;

  const surnames = [englishParts.at(-1), nativeParts.at(-1), arabicParts.at(-1)]
    .filter((part) => part && part.length >= 4);
  const hasSurname = [...new Set(surnames)].some((surname) => containsIdentity(text, surname));
  if (!hasSurname) return false;

  const officeContext = [
    mayor.city_en,
    mayor.city_ar,
    mayor.title_en,
    mayor.title_ar,
    "mayor",
    "sindaco",
    "alcalde",
    "δήμαρχος",
    "시장",
    "市長",
    "عمدة",
    "أمين",
  ];
  return officeContext.some((phrase) => containsIdentity(text, phrase));
}
