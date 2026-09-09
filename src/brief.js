import { decodeEntities, splitHeadline, arabicRatio } from "./text.js";
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

const GLOSS = [
  [/blackout a catena/gi, "انقطاع كهرباء متتالٍ"],
  [/rete elettrica è vecchia/gi, "الشبكة الكهربائية قديمة"],
  [/rete vecchia/gi, "الشبكة القديمة"],
  [/via pedonale di via roma/gi, "شارع فيا روما للمشاة"],
  [/via pedonale/gi, "شارع للمشاة"],
  [/grande festa per l['’]inaugurazione/gi, "احتفال بمناسبة الافتتاح"],
  [/inaugurazione della nuova via/gi, "افتتاح الشارع الجديد"],
  [/inizia una nuova storia/gi, "مرحلة جديدة"],
  [/housing per giovani/gi, "إسكان للشباب"],
  [/in condizioni di fragilità/gi, "في وضع هش"],
  [/costruire l['’]autonomia/gi, "لبناء الاستقلال"],
  [/un piazzale di sogni/gi, "ساحة أحلام"],
  [/bilancio preventivo/gi, "الميزانية التقديرية"],
  [/circoscrizione/gi, "دائرة بلدية"],
  [/occupabilità/gi, "التوظيف"],
  [/comunicati?/gi, ""],
  [/black-?outs?/gi, "انقطاع الكهرباء"],
  [/power cuts?/gi, "انقطاع الكهرباء"],
  [/al buio/gi, "انقطاع الكهرباء"],
  [/apagones?/gi, "انقطاع الكهرباء"],
  [/è un['’]?emergenza/gi, "حالة طوارئ"],
  [/e un['’]?emergenza/gi, "حالة طوارئ"],
  [/emergency/gi, "حالة طوارئ"],
  [/inaugurazione/gi, "افتتاح"],
  [/inauguration/gi, "افتتاح"],
  [/inaugurato/gi, "افتُتح"],
  [/inaugur\w*/gi, "افتتاح"],
  [/pedonale/gi, "للمشاة"],
  [/riqualificazione/gi, "إعادة التأهيل"],
  [/viabilità/gi, "حركة المرور"],
  [/settembre/gi, "سبتمبر"],
  [/ottobre/gi, "أكتوبر"],
  [/novembre/gi, "نوفمبر"],
  [/dicembre/gi, "ديسمبر"],
  [/gennaio/gi, "يناير"],
  [/febbraio/gi, "فبراير"],
  [/marzo/gi, "مارس"],
  [/aprile/gi, "أبريل"],
  [/maggio/gi, "مايو"],
  [/giugno/gi, "يونيو"],
  [/luglio/gi, "يوليو"],
  [/agosto/gi, "أغسطس"],
  [/sabato/gi, "السبت"],
  [/domenica/gi, "الأحد"],
  [/lunedì/gi, "الاثنين"],
  [/martedì/gi, "الثلاثاء"],
  [/mercoledì/gi, "الأربعاء"],
  [/giovedì/gi, "الخميس"],
  [/venerdì/gi, "الجمعة"],
  [/september/gi, "سبتمبر"],
  [/saturday/gi, "السبت"],
  [/sunday/gi, "الأحد"],
  [/monday/gi, "الاثنين"],
  [/housing/gi, "إسكان"],
  [/vivienda/gi, "إسكان"],
  [/giovani/gi, "الشباب"],
  [/fragilità/gi, "الهشاشة"],
  [/autonomia/gi, "الاستقلال"],
  [/posti/gi, "مقاعد"],
  [/sette/gi, "سبعة"],
  [/milioni/gi, "مليون"],
  [/million/gi, "مليون"],
  [/aperto/gi, "افتتاح"],
  [/nuova via/gi, "الشارع الجديد"],
  [/restituito ai torinesi/gi, "أُعيد إلى أهل تورينو"],
  [/al termine dei lavori/gi, "بعد انتهاء الأعمال"],
  [/da oggi/gi, "اعتباراً من اليوم"],
  [/punto di riferimento/gi, "نقطة مرجعية"],
  [/housing first/gi, "إسكان أولاً"],
  [/questa mattina/gi, "هذا الصباح"],
  [/comune di torino/gi, "بلدية تورينو"],
  [/torino/gi, "تورينو"],
  [/turin/gi, "تورينو"],
  [/via roma/gi, "فيا روما"],
  [/sindaco/gi, ""],
  [/mayor/gi, ""],
  [/alcalde/gi, ""],
  [/announces?/gi, "يعلن"],
  [/declared?/gi, "يعلن"],
  [/attends?/gi, "يحضر"],
  [/opens?/gi, "يفتتح"],
  [/ribbon event/gi, "فعالية محلية"],
  [/local/gi, "محلية"],
  [/grid repair/gi, "إصلاح الشبكة"],
];

const MONTHS = {
  gennaio: "يناير",
  febbraio: "فبراير",
  marzo: "مارس",
  aprile: "أبريل",
  maggio: "مايو",
  giugno: "يونيو",
  luglio: "يوليو",
  agosto: "أغسطس",
  settembre: "سبتمبر",
  ottobre: "أكتوبر",
  novembre: "نوفمبر",
  dicembre: "ديسمبر",
  january: "يناير",
  february: "فبراير",
  march: "مارس",
  april: "أبريل",
  may: "مايو",
  june: "يونيو",
  july: "يوليو",
  august: "أغسطس",
  september: "سبتمبر",
  october: "أكتوبر",
  november: "نوفمبر",
  december: "ديسمبر",
  يناير: "يناير",
  فبراير: "فبراير",
  مارس: "مارس",
  أبريل: "أبريل",
  مايو: "مايو",
  يونيو: "يونيو",
  يوليو: "يوليو",
  أغسطس: "أغسطس",
  سبتمبر: "سبتمبر",
  أكتوبر: "أكتوبر",
  نوفمبر: "نوفمبر",
  ديسمبر: "ديسمبر",
};

const WEEKDAYS = {
  sabato: "السبت",
  domenica: "الأحد",
  lunedì: "الاثنين",
  lunedi: "الاثنين",
  martedì: "الثلاثاء",
  martedi: "الثلاثاء",
  mercoledì: "الأربعاء",
  mercoledi: "الأربعاء",
  giovedì: "الخميس",
  giovedi: "الخميس",
  venerdì: "الجمعة",
  venerdi: "الجمعة",
  saturday: "السبت",
  sunday: "الأحد",
  monday: "الاثنين",
  tuesday: "الثلاثاء",
  wednesday: "الأربعاء",
  thursday: "الخميس",
  friday: "الجمعة",
};

const PLACE_AR = {
  roma: "روما",
  torino: "تورينو",
  turin: "تورينو",
  madrid: "مدريد",
  seoul: "سيئول",
  amman: "عمّان",
  baghdad: "بغداد",
  athens: "أثينا",
  barcelona: "برشلونة",
  paris: "باريس",
  po: "بو",
  garibaldi: "غاريبالدي",
  milano: "ميلانو",
  milan: "ميلانو",
};

const STOP = new Set(
  `il lo la gli le di da del della delle dei des un una uno e per con su a al ai the of and for an to in on is are was were by at as from with el los las de y en que se unos nel nella nei negli che non è e' it's its this that nuova storia breve descrizione testo comunicato stampa`.split(
    /\s+/,
  ),
);

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
    "Città di Torino",
    "mayor",
    "alcalde",
    "sindaco",
    "عمدة",
  ].filter(Boolean);
  for (const phrase of [mayor.name_en, mayor.name_native, mayor.name_ar]) {
    for (const part of String(phrase || "").split(/[\s.]+/)) {
      if (part.length >= 3) drops.push(part);
    }
  }
  for (const drop of drops) {
    text = text.replace(new RegExp(escapeRe(drop), "ig"), " ");
  }
  return text.replace(/["«»„”|:]+/g, " ").replace(/\s+/g, " ").trim();
}

export function detectTopic(text) {
  const hay = String(text || "").toLowerCase();
  if (!hay) return null;
  for (const topic of TOPICS) {
    if (topic.keys.some((key) => hay.includes(key.toLowerCase()))) return topic;
  }
  return null;
}

export function glossPhrase(text) {
  let out = ` ${String(text || "")} `;
  for (const [pattern, ar] of GLOSS) {
    out = out.replace(pattern, ` ${ar} `);
  }
  return out
    .split(/\s+/)
    .filter((tok) => tok && !STOP.has(tok.toLowerCase()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function tidy(text) {
  return String(text || "")
    .replace(/,/g, "،")
    .replace(/\s+([،,:])/g, "$1")
    .replace(/[،,]{2,}/g, "،")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[:،.\-–—]\s*/, "")
    .replace(/\s*[:،.\-–—]$/, "");
}

function stripLatin(text) {
  const mapped = String(text || "")
    .replace(/\b[A-Za-zÀ-ÿ]{3,}\b/g, (word) => PLACE_AR[word.toLowerCase()] || "")
    .replace(/[A-Za-zÀ-ÿ]/g, " ")
    .replace(/[«»„”“"‘’'`´]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return tidy(mapped);
}

function hasLatin(text) {
  return /[A-Za-zÀ-ÿ]/.test(String(text || ""));
}

function translitIt(word) {
  const lower = String(word || "").toLowerCase();
  if (!lower || WEEKDAYS[lower] || MONTHS[lower]) return "";
  if (PLACE_AR[lower]) return PLACE_AR[lower];
  const chunks = { sci: "ش", gn: "ني", gl: "لي", ch: "ك" };
  let i = 0;
  let out = "";
  const one = {
    a: "ا", e: "ي", i: "ي", o: "و", u: "و", b: "ب", c: "ك", d: "د", f: "ف", g: "غ",
    h: "ه", l: "ل", m: "م", n: "ن", p: "ب", q: "ك", r: "ر", s: "س", t: "ت", v: "ف",
    z: "ز", k: "ك", w: "و", y: "ي", j: "ج", x: "كس",
  };
  while (i < lower.length) {
    const three = lower.slice(i, i + 3);
    if (chunks[three]) {
      out += chunks[three];
      i += 3;
      continue;
    }
    const two = lower.slice(i, i + 2);
    if (chunks[two]) {
      out += chunks[two];
      i += 2;
      continue;
    }
    out += one[lower[i]] || "";
    i += 1;
  }
  return out;
}

function arabicPlace(raw) {
  const original = String(raw || "").replace(/[.]/g, " ").replace(/\s+/g, " ").trim();
  if (!original) return "";
  const kind = /^piazzale\b|^piazza\b/i.test(original)
    ? "ساحة"
    : /^corso\b/i.test(original)
      ? "كورسو"
      : /^via\b/i.test(original)
        ? "فيا"
        : "";
  const core = original.replace(/^(via|piazzale|piazza|corso)\s+/i, "");
  const parts = core
    .split(/\s+/)
    .map((part) => translitIt(part))
    .filter(Boolean);
  const named = parts.join(" ");
  if (!named) return "";
  if (!kind) return named;
  return `${kind} ${named}`.trim();
}

function extractWhen(text) {
  const blob = String(text || "");
  const day = blob.match(
    /\b(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  );
  const wd = blob.match(
    /\b(sabato|domenica|lunedì|lunedi|martedì|martedi|mercoledì|mercoledi|giovedì|giovedi|venerdì|venerdi|saturday|sunday|monday|tuesday|wednesday|thursday|friday)\b/i,
  );
  const parts = [];
  if (wd) parts.push(WEEKDAYS[wd[1].toLowerCase()] || "");
  if (day) parts.push(`${day[1]} ${MONTHS[day[2].toLowerCase()] || day[2]}`);
  return tidy(parts.filter(Boolean).join(" "));
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
    return key && !WEEKDAYS[key] && !MONTHS[key];
  });
  return words.join(" ").replace(/\s+/g, " ").trim();
}

function extractQuote(text) {
  const blob = String(text || "");
  const m = blob.match(
    /(?:[:]|\bsaid\b|\bdice\b|\bdichiar|\bLo Russo\b|\bmayor\b|\balcalde\b)[^\n«“"']{0,48}[«“"']([^»”"']{8,160})[»”"']/i,
  );
  return m ? tidy(m[1]) : "";
}

function extractAmount(text) {
  const m = String(text || "").match(/(\d{1,4}(?:[.,]\d{3})*)\s*(milioni|million|مليون|مليار|billion|دينار)/i);
  if (!m) return "";
  const unit = glossPhrase(m[2]) || m[2];
  return tidy(`${m[1]} ${unit}`);
}

export function extractSlots(text) {
  const blob = String(text || "");
  const topic = detectTopic(blob);
  return {
    action: topic?.id || "",
    via: extractVia(blob),
    when: extractWhen(blob),
    quote: extractQuote(blob),
    amount: extractAmount(blob),
    emergency: /emergenz|emergency|طوارئ/i.test(blob),
    oldGrid: /rete vecchia|old network|grid|شبكة.*قديم/i.test(blob),
    youth: /giovani|youth|شباب/i.test(blob),
    fragile: /fragilità|fragility|هش/i.test(blob),
  };
}

export function eventMarkers(title, snippet = "") {
  const original = canonicalOriginal(title, snippet);
  const slots = extractSlots(`${original.headline} ${snippet || ""}`);
  return {
    action: slots.action || "",
    place: (slots.via || "").toLowerCase(),
  };
}

function namedIn(text, mayor) {
  const hay = String(text || "").toLowerCase();
  return [mayor.name_en, mayor.name_native, mayor.name_ar]
    .filter(Boolean)
    .some((name) => hay.includes(String(name).toLowerCase()));
}

function frameHeadline(mayor, blob, slots) {
  const name = mayor.name_ar;
  const city = mayor.city_ar;
  const actor = namedIn(blob, mayor);
  const asFact = (fact) => `${name}: ${tidy(fact)}`;

  if ((/pedonal/i.test(blob) || /للمشاة/.test(blob)) && (/inaugur|aperto|يفتتح|افتتاح/i.test(blob) || slots.via)) {
    const street = arabicPlace(slots.via);
    const when = slots.when ? ` ${slots.when}` : "";
    const obj = street ? `شارع ${street} للمشاة${when}` : `شارع للمشاة${when}`;
    return actor ? `${name} يفتتح ${obj}` : asFact(`افتتاح ${obj}`);
  }

  if (slots.action === "housing" || /housing|vivienda|إسكان/i.test(blob)) {
    const who = slots.youth ? "للشباب" : "";
    const state = slots.fragile ? " في وضع هش" : "";
    return asFact(`إسكان ${who}${state} في ${city}`.replace(/\s+/g, " "));
  }

  if (/inaugur|يفتتح|افتتاح/i.test(blob) && slots.via && /^via\b/i.test(slots.via)) {
    const street = arabicPlace(slots.via);
    const when = slots.when ? ` ${slots.when}` : "";
    return actor ? `${name} يفتتح شارع ${street}${when}` : asFact(`افتتاح شارع ${street}${when}`);
  }

  if (slots.action === "power" || /black-?out|al buio|apag[oó]n|انقطاع/i.test(blob)) {
    if (slots.emergency) return `${name} يعلن حالة طوارئ بعد انقطاع الكهرباء في ${city}`;
    if (slots.oldGrid) return `${name}: الشبكة الكهربائية قديمة بعد انقطاع في ${city}`;
    return `${name}: انقطاع الكهرباء في ${city}`;
  }

  if (slots.amount && (slots.action === "budget" || /مديونية|ميزانية|bilancio|budget|دينار/i.test(blob))) {
    if (/مديونية/.test(blob)) return asFact(`مديونية ${slots.amount}`);
    return asFact(`ميزانية ${city} ${slots.amount}`);
  }

  if (/circoscrizione\s+(\d+)/i.test(blob) && /aperto|da oggi|punto di riferimento|inaugur/i.test(blob)) {
    const n = blob.match(/circoscrizione\s+(\d+)/i)[1];
    return asFact(`افتتاح مكتب دائرة بلدية ${n}`);
  }

  if (/attend|ribbon|ceremon/i.test(blob)) {
    return `${name} يحضر فعالية محلية في ${city}`;
  }

  if (slots.quote) {
    const q = stripLatin(glossPhrase(slots.quote));
    if (q.length >= 8) return `${name}: ${q.slice(0, 110)}`;
  }

  return "";
}

function pickSentences(text, headline) {
  const parts = String(text || "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?。！؟])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 28 && s.length <= 240);
  const ranked = parts
    .map((s) => ({ s, score: tokenOverlap(s, headline) + (/\d/.test(s) ? 0.15 : 0) + (/[«“"]/.test(s) ? 0.1 : 0) }))
    .filter((row) => row.score >= 0.12 || /\d/.test(row.s))
    .sort((a, b) => b.score - a.score);
  const seen = new Set();
  const out = [];
  for (const row of ranked) {
    const key = row.s.slice(0, 48);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row.s);
    if (out.length === 4) break;
  }
  return out;
}

function pushFact(lines, fact, headline) {
  const text = tidy(fact);
  if (!text || text.length < 8) return;
  if (headline && tokenOverlap(headline, text) >= 0.86) return;
  if (lines.some((row) => tokenOverlap(row, text) >= 0.72)) return;
  lines.push(text.slice(0, 160));
}

export function arabicHeadline(mayor, title, extra = "") {
  const original = canonicalOriginal(title, extra);
  const blob = `${original.headline} ${extra}`;
  const residual = residualTopic(original.headline, mayor);
  if (residual && arabicRatio(residual) >= 0.4) {
    if (residual.includes(mayor.name_ar) || residual.includes(mayor.name_native || "")) {
      return residual.slice(0, 120);
    }
    return `${mayor.name_ar}: ${residual.slice(0, 110)}`;
  }
  const slots = extractSlots(blob);
  const framed = frameHeadline(mayor, blob, slots);
  if (framed) return tidy(framed).slice(0, 140);
  const glossed = stripLatin(glossPhrase(residual));
  if (glossed && glossed.length >= 8 && arabicRatio(glossed) >= 0.45) {
    return `${mayor.name_ar}: ${glossed.slice(0, 110)}`;
  }
  if (slots.when) return `${mayor.name_ar} في ${mayor.city_ar} ${slots.when}`;
  return `${mayor.name_ar} في ${mayor.city_ar}`;
}

export function arabicBullets(mayor, title, snippet = "", body = "") {
  const original = canonicalOriginal(title, snippet);
  const blob = `${original.headline}. ${snippet} ${body}`.replace(/\s+/g, " ");
  const slots = extractSlots(blob);
  const headline = arabicHeadline(mayor, title, `${snippet} ${body}`);
  const framed = Boolean(frameHeadline(mayor, blob, slots));
  const lines = [];

  const corso = blob.match(/\bcorso\s+([A-ZÀ-Ú][A-Za-zÀ-ÿ'’-]+)\s+(\d+)/);
  if (slots.when && !headline.includes(slots.when)) {
    pushFact(lines, `يُحدد الموعد ${slots.when}.`, headline);
  }
  if (slots.via && !corso) {
    const place = arabicPlace(slots.via);
    if (place && !headline.includes(place) && !headline.includes(place.replace(/^فيا\s+/, ""))) {
      const loc = place.startsWith("ساحة") || place.startsWith("كورسو") || place.startsWith("فيا")
        ? place
        : `شارع ${place}`;
      pushFact(lines, `العمل في ${loc}.`, headline);
    }
  }
  if (slots.amount && !headline.includes(slots.amount.split(" ")[0])) {
    pushFact(lines, `الرقم المعلن ${slots.amount}.`, headline);
  }
  if (slots.emergency && !/طوارئ/.test(headline)) {
    pushFact(lines, `${mayor.name_ar} يصف الوضع بأنه حالة طوارئ.`, headline);
  }
  if (slots.oldGrid) pushFact(lines, `العمدة يقول إن الشبكة الكهربائية قديمة.`, headline);
  if (slots.youth) pushFact(lines, `البرنامج موجه للشباب.`, headline);
  if (slots.fragile) pushFact(lines, `يشمل من هم في وضع هش.`, headline);
  if (/festa|grande festa/i.test(blob)) pushFact(lines, `يُقام احتفال بمناسبة الافتتاح.`, headline);
  if (/riqualificaz|restituito/i.test(blob)) {
    pushFact(lines, `بعد إعادة التأهيل يُعاد المكان إلى أهل المدينة.`, headline);
  }
  if (/piazzale di sogni|ساحة أحلام/i.test(blob)) pushFact(lines, `المشروع يحمل اسم ساحة أحلام.`, headline);
  if (/housing first/i.test(blob)) pushFact(lines, `المشروع ضمن مسار إسكان أولاً.`, headline);
  if (corso) {
    pushFact(lines, `المكتب في كورسو ${translitIt(corso[1])} ${corso[2]}.`, headline);
  }
  if (slots.quote) {
    const q = stripLatin(glossPhrase(slots.quote));
    if (q && !hasLatin(q)) pushFact(lines, `${mayor.name_ar}: «${q.slice(0, 120)}».`, headline);
  }

  if (!framed) {
    const glossedHead = stripLatin(glossPhrase(residualTopic(original.headline, mayor)));
    if (glossedHead && arabicRatio(glossedHead) >= 0.45 && !hasLatin(glossedHead)) {
      pushFact(lines, `${glossedHead}.`, headline);
    }
  }

  if (!framed && lines.length < 2) {
    for (const sentence of pickSentences(blob, original.headline)) {
      const g = stripLatin(glossPhrase(residualTopic(sentence, mayor)));
      if (!g || g.length < 12 || g.length > 90 || arabicRatio(g) < 0.45 || hasLatin(g)) continue;
      pushFact(lines, `${g}.`, headline);
      if (lines.length === 4) break;
    }
  }

  return lines.slice(0, 4);
}

export function writeOfficialBrief(mayor, title, snippet, body = "") {
  const original = canonicalOriginal(title, snippet);
  const title_ar = arabicHeadline(mayor, title, `${snippet} ${body}`);
  const bullets = arabicBullets(mayor, title, snippet, body);
  return {
    title_ar,
    snippet_ar: bullets.join("\n"),
    topic_id: detectTopic(`${title} ${snippet} ${body}`)?.id || "other",
    original,
    engine: "brief-radar",
  };
}
