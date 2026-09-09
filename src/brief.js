import { decodeEntities, splitHeadline, arabicRatio } from "./text.js";
import { tokenOverlap } from "./dedup.js";

export const TOPICS = [
  {
    id: "power",
    ar: "انقطاع الكهرباء وحالة طوارئ في الشبكة",
    keys: [
      "blackout",
      "brownout",
      "outage",
      "power cut",
      "power-cut",
      "black-out",
      "black out",
      "al buio",
      "buio",
      "elettric",
      "rete vecchia",
      "blackout a catena",
      "停電",
      "정전",
      "كهرباء",
      "انقطاع التيار",
      "apagon",
      "apagón",
      "corte de luz",
    ],
  },
  {
    id: "housing",
    ar: "ملف الإسكان",
    keys: ["housing", "vivienda", "住宅", "إسكان", "rent", "affordable home", "redevelopment"],
  },
  {
    id: "budget",
    ar: "الميزانية والمالية البلدية",
    keys: ["budget", "fine", "debt", "مديونية", "ميزانية", "دينار", "won", "벌금", "fiscal", "tax"],
  },
  {
    id: "transport",
    ar: "النقل والبنية التحتية",
    keys: ["metro", "transit", "traffic", "bus", "tram", "airport", "نقل", "subway", "infrastruttur"],
  },
  {
    id: "protocol",
    ar: "نشاط رسمي أو بروتوكولي",
    keys: ["visit", "inaugur", "chairs", "meets", "summit", "ceremony", "يفتتح", "يستقبل"],
  },
  {
    id: "environment",
    ar: "البيئة والنفايات أو المناخ",
    keys: ["climate", "waste", "pollution", "heat", "caldo", "حرارة", "بيئة", "smog"],
  },
  {
    id: "security",
    ar: "الأمن والسلامة العامة",
    keys: ["police", "crime", "security", "emergenc", "emergenza", "طوارئ", "incendio", "clash", "clashes", "rally", "corteo", "protest", "scontri"],
  },
  {
    id: "health",
    ar: "الصحة والخدمات الطبية",
    keys: ["hospital", "health", "covid", "sanit", "صحة"],
  },
  {
    id: "water",
    ar: "المياه والصرف",
    keys: ["water", "sewage", "flood", "alluvion", "مياه", "فيضان"],
  },
];

export function canonicalOriginal(title, snippet) {
  const { headline, outlet } = splitHeadline(decodeEntities(title || ""));
  let extra = decodeEntities(snippet || "");
  if (!extra) return { headline, outlet, extra: "" };
  const extraCore = splitHeadline(extra).headline;
  if (
    extraCore === headline ||
    extra === headline ||
    extra.includes(headline) ||
    headline.includes(extraCore.slice(0, Math.min(40, extraCore.length))) ||
    tokenOverlap(headline, extraCore) >= 0.62
  ) {
    extra = "";
  }
  return { headline, outlet, extra };
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function residualTopic(headline, mayor) {
  let text = ` ${headline} `;
  const drops = [
    mayor.name_en,
    mayor.name_native,
    mayor.name_ar,
    mayor.city_en,
    mayor.city_ar,
    mayor.title_en,
    "Lo Russo",
    "de la Torre",
    "Martínez-Almeida",
    "Martinez-Almeida",
    "mayor",
    "alcalde",
    "sindaco",
    "عمدة",
  ].filter(Boolean);
  for (const drop of drops) {
    text = text.replace(new RegExp(escapeRe(drop), "ig"), " ");
  }
  return text.replace(/["«»„”]/g, " ").replace(/\s+/g, " ").trim();
}

export function detectTopic(text) {
  const hay = String(text || "").toLowerCase();
  if (!hay) return null;
  for (const topic of TOPICS) {
    if (topic.keys.some((key) => hay.includes(key.toLowerCase()))) return topic;
  }
  return null;
}

function officeOf(mayor) {
  return mayor.title_ar || mayor.office_ar || "";
}

export function writeOfficialBrief(mayor, title, snippet) {
  const original = canonicalOriginal(title, snippet);
  const residual = residualTopic(original.headline, mayor);
  const topic = detectTopic(`${original.headline} ${residual} ${original.extra}`);
  const office = officeOf(mayor);
  let what = topic?.ar || "";
  if (!what && residual && arabicRatio(residual) >= 0.4) {
    what = residual.slice(0, 90);
  }
  if (!what) what = "متابعة خبر مرتبط بالمنصب";
  return {
    title_ar: `${mayor.name_ar}: ${what}`,
    snippet_ar: `الشخص: ${mayor.name_ar}. المنصب: ${office}. المدينة: ${mayor.city_ar}. الموضوع: ${what}.`,
    topic_id: topic?.id || "other",
    original,
    engine: "brief",
  };
}
