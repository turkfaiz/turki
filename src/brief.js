import { decodeEntities, splitHeadline } from "./text.js";
import { tokenOverlap } from "./dedup.js";

export const TOPICS = [
  {
    id: "power",
    ar: "كهرباء وشبكة",
    keys: ["blackout", "outage", "al buio", "buio", "elettric", "rete vecchia", "停电", "정전", "كهرباء", "انقطاع", "apagón", "apagon", "power cut"],
  },
  {
    id: "housing",
    ar: "إسكان",
    keys: ["housing", "vivienda", "住宅", "إسكان", "rent", "fragilità", "autonomia", "giovani", "주택"],
  },
  {
    id: "budget",
    ar: "مالية",
    keys: ["budget", "bilancio", "preventivo", "fine", "debt", "مديونية", "ميزانية", "دينار", "fiscal", "tax", "milioni", "مليون", "예산"],
  },
  {
    id: "transport",
    ar: "نقل",
    keys: ["metro", "transit", "traffic", "tram", "airport", "pedonale", "via roma", "نقل", "traffic", "viabilità"],
  },
  {
    id: "protocol",
    ar: "افتتاح",
    keys: ["inaugur", "ceremony", "festa", "يفتتح", "يستقبل", "visit", "ribbon", "aperto", "inauguration"],
  },
  {
    id: "environment",
    ar: "بيئة",
    keys: ["climate", "waste", "pollution", "heat", "caldo", "بيئة"],
  },
  {
    id: "security",
    ar: "أمن",
    keys: ["police", "crime", "emergenc", "emergenza", "طوارئ", "clash", "corteo", "protest", "scontri"],
  },
  {
    id: "health",
    ar: "صحة",
    keys: ["hospital", "health", "sanit", "صحة"],
  },
  {
    id: "water",
    ar: "مياه",
    keys: ["water", "flood", "مياه", "فيضان"],
  },
];

const MONTHS = new Set([
  "gennaio",
  "febbraio",
  "marzo",
  "aprile",
  "maggio",
  "giugno",
  "luglio",
  "agosto",
  "settembre",
  "ottobre",
  "novembre",
  "dicembre",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
  "يناير",
  "فبراير",
  "مارس",
  "أبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
]);

const WEEKDAYS = new Set([
  "sabato",
  "domenica",
  "lunedì",
  "lunedi",
  "martedì",
  "martedi",
  "mercoledì",
  "mercoledi",
  "giovedì",
  "giovedi",
  "venerdì",
  "venerdi",
  "saturday",
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
]);

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

export function detectTopic(text) {
  const hay = String(text || "").toLowerCase();
  if (!hay) return null;
  for (const topic of TOPICS) {
    if (topic.keys.some((key) => hay.includes(key.toLowerCase()))) return topic;
  }
  return null;
}

function extractVia(text) {
  const blob = String(text || "");
  const matches = [
    ...blob.matchAll(
      /\b([Vv]ia|[Pp]iazzale|[Pp]iazza|[Cc]orso)\s+((?:di\s+)?[A-ZÀ-Ú][A-Za-zÀ-ÿ'’-]*(?:\s+(?:di\s+)?[A-ZÀ-Ú][A-Za-zÀ-ÿ'’-]*){0,3})/g,
    ),
  ];
  const named = matches.find((m) => !/^pedonal/i.test(m[2]));
  if (!named) return "";
  const words = `${named[1]} ${named[2]}`.split(/\s+/).filter((word) => {
    const key = word.toLowerCase().replace(/[.]/g, "");
    return key && !WEEKDAYS.has(key) && !MONTHS.has(key);
  });
  return words.join(" ").replace(/\s+/g, " ").trim();
}

export function eventMarkers(title, snippet = "") {
  const original = canonicalOriginal(title, snippet);
  const blob = `${original.headline} ${snippet || ""}`;
  return {
    action: detectTopic(blob)?.id || "",
    place: extractVia(blob).toLowerCase(),
  };
}
