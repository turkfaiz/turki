import test from "node:test";
import assert from "node:assert/strict";
import {
  BRIEF_STATE,
  aiBriefEnabled,
  buildAiBriefPrompt,
  clusterWithGemini,
  pendingAiBrief,
  summarizeWithGemini,
  validateAiBrief,
} from "../src/aiBrief.js";
import { MAYORS } from "../src/mayors.js";
import { aiEnv } from "./helpers/aiEnv.js";

const turin = MAYORS.find((mayor) => mayor.id === "turin");
const seoul = MAYORS.find((mayor) => mayor.id === "seoul");
const article = {
  title: "Via Roma: inaugurazione della nuova via pedonale",
  snippet: "Stefano Lo Russo presenta la riqualificazione.",
  article_text:
    "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma. La festa è prevista sabato 12 settembre. FINE-PAGINA-VERIFICATA.",
  publisher_domain: "comune.torino.it",
  published_at: "2026-09-08T12:00:00Z",
};

test("AI briefing is enabled only with a secret key", () => {
  assert.equal(aiBriefEnabled({}), false);
  assert.equal(aiBriefEnabled({ GEMINI_API_KEY: "test" }), true);
});

test("pending and failed AI states never invent a news claim", () => {
  const pending = pendingAiBrief(turin);
  const deferred = pendingAiBrief(turin, BRIEF_STATE.DEFERRED);
  const failed = pendingAiBrief(turin, BRIEF_STATE.FAILED);
  assert.equal(pending.engine, "brief-pending");
  assert.match(pending.title_ar, /بانتظار/);
  assert.equal(pending.snippet_ar, "");
  assert.equal(deferred.engine, "brief-deferred");
  assert.match(deferred.title_ar, /حصة/);
  assert.equal(deferred.snippet_ar, "");
  assert.equal(failed.engine, "brief-ai-error");
  assert.match(failed.title_ar, /تعذر/);
  assert.equal(failed.snippet_ar, "");
});

test("AI prompt contains the fetched page body, not only its headline", () => {
  const longArticle = {
    ...article,
    article_text: `${"contenuto completo ".repeat(2000)} FINE-PAGINA-VERIFICATA`,
  };
  const prompt = buildAiBriefPrompt(longArticle, turin);
  assert.match(prompt, /FINE-PAGINA-VERIFICATA/);
  assert.match(prompt, /استخرج الزبدة من نص الصفحة/);
  assert.match(prompt, /اقتباسًا حرفيًا/);
});

test("Gemini brief accepts only facts backed by exact page quotes", async () => {
  const requestBodies = [];
  let call = 0;
  const fetcher = async (_url, options) => {
    requestBodies.push(JSON.parse(options.body));
    call += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          steps: [
            {
              type: "model_output",
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    call === 1
                      ? {
                          headline_ar: "ستيفانو لو روسو يفتتح شارع فيا روما للمشاة",
                          headline_evidence:
                            "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma.",
                          facts: [
                            {
                              fact_ar: "موعد الاحتفال السبت 12 سبتمبر.",
                              evidence: "La festa è prevista sabato 12 settembre.",
                            },
                          ],
                          topic_ar: "افتتاح شارع للمشاة",
                        }
                      : {
                          headline_supported: true,
                          facts: [{ index: 0, supported: true }],
                        },
                  ),
                },
              ],
            },
          ],
        };
      },
    };
  };

  const brief = await summarizeWithGemini(
    aiEnv({ AI_VERIFY_BRIEFS: "1" }),
    article,
    turin,
    fetcher,
  );
  assert.equal(brief.engine, "brief-ai-gemini-v2:gemini-test");
  assert.match(brief.title_ar, /ستيفانو لو روسو/);
  assert.match(brief.snippet_ar, /12 سبتمبر/);
  assert.match(brief.evidence, /La festa è prevista/);
  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0].store, false);
  assert.equal(requestBodies[0].response_format.mime_type, "application/json");
});

test("AI brief rejects a headline whose evidence is absent from the page", () => {
  assert.throws(
    () =>
      validateAiBrief(
        {
          headline_ar: "ستيفانو لو روسو يعلن مشروعًا جديدًا",
          headline_evidence: "This sentence does not exist in the page.",
          facts: [
            {
              fact_ar: "موعد الاحتفال السبت 12 سبتمبر.",
              evidence: "La festa è prevista sabato 12 settembre.",
            },
          ],
          topic_ar: "مشروع",
        },
        `${article.title}\n${article.snippet}\n${article.article_text}`,
        turin,
        "brief-ai-test",
      ),
    /ai_ungrounded_headline/,
  );
});

test("AI brief requires the mayor in the Arabic headline and an exact quote", () => {
  const source =
    "Stefano Lo Russo: non è un'emergenza. La rete sarà controllata domani.";
  const base = {
    headline_ar: "إعلان حالة طوارئ في تورينو",
    headline_evidence: "Stefano Lo Russo: non è un'emergenza.",
    facts: [
      {
        fact_ar: "ستُفحص الشبكة غدًا.",
        evidence: "La rete sarà controllata domani.",
      },
    ],
    topic_ar: "الكهرباء",
  };
  assert.throws(
    () => validateAiBrief(base, source, turin, "brief-ai-test"),
    /ai_ungrounded_headline/,
  );
  assert.throws(
    () =>
      validateAiBrief(
        {
          ...base,
          headline_ar: "ستيفانو لو روسو يعلن حالة طوارئ في تورينو",
          headline_evidence: "Stefano Lo Russo non è un'emergenza.",
        },
        source,
        turin,
        "brief-ai-test",
      ),
    /ai_ungrounded_headline/,
  );
});

test("a second AI pass rejects a claim contradicted by its quote", async () => {
  let call = 0;
  const fetcher = async () => ({
    ok: true,
    status: 200,
    async json() {
      call += 1;
      const payload =
        call === 1
          ? {
              headline_ar: "ستيفانو لو روسو يعلن حالة طوارئ في تورينو",
              headline_evidence: "Stefano Lo Russo: non è un'emergenza.",
              facts: [
                {
                  fact_ar: "ستُفحص الشبكة غدًا.",
                  evidence: "La rete sarà controllata domani.",
                },
              ],
              topic_ar: "الكهرباء",
            }
          : {
              headline_supported: false,
              facts: [{ index: 0, supported: true }],
            };
      return {
        steps: [
          {
            type: "model_output",
            content: [{ type: "text", text: JSON.stringify(payload) }],
          },
        ],
      };
    },
  });
  await assert.rejects(
    summarizeWithGemini(
      aiEnv({ AI_VERIFY_BRIEFS: "1" }),
      {
        ...article,
        title: "Stefano Lo Russo: non è un'emergenza",
        article_text:
          "Stefano Lo Russo: non è un'emergenza. La rete sarà controllata domani.",
      },
      turin,
      fetcher,
    ),
    /ai_headline_not_supported/,
  );
});

test("AI clustering can merge one event reported in different scripts", async () => {
  const items = [
    {
      id: "en",
      mayor_id: "seoul",
      source: "google_news",
      publisher_domain: "koreaherald.com",
      published_at: "2026-09-09T09:00:00Z",
      title: "Oh Se-hoon opens 120-home youth housing complex in Seoul",
      snippet: "The mayor opened the project on Wednesday.",
    },
    {
      id: "ko",
      mayor_id: "seoul",
      source: "official",
      publisher_domain: "seoul.go.kr",
      published_at: "2026-09-09T08:00:00Z",
      title: "오세훈 서울 청년주택 120가구 개관",
      snippet: "수요일 청년주택 문을 열었다.",
    },
  ];
  let call = 0;
  const fetcher = async () => ({
    ok: true,
    status: 200,
    async json() {
      call += 1;
      return {
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  call === 1
                    ? {
                        groups: [
                          {
                            item_ids: ["en", "ko"],
                            event_ar: "افتتاح مشروع إسكان للشباب",
                            evidence: [
                              {
                                item_id: "en",
                                quote: "opens 120-home youth housing complex",
                              },
                              {
                                item_id: "ko",
                                quote: "서울 청년주택 120가구 개관",
                              },
                            ],
                          },
                        ],
                      }
                    : {
                        groups: [{ index: 0, same_event: true }],
                      },
                ),
              },
            ],
          },
        ],
      };
    },
  });
  const groups = await clusterWithGemini(
    aiEnv(),
    items,
    seoul,
    fetcher,
  );
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].members.map((item) => item.id).sort(),
    ["en", "ko"],
  );
});

test("AI clustering keeps cards separate when the independent merge check rejects", async () => {
  const items = [
    {
      id: "housing-a",
      mayor_id: "seoul",
      source: "official",
      published_at: "2026-09-09T09:00:00Z",
      title: "Oh Se-hoon presents a youth housing project in eastern Seoul",
      snippet: "",
    },
    {
      id: "housing-b",
      mayor_id: "seoul",
      source: "google_news",
      published_at: "2026-09-09T08:00:00Z",
      title: "Oh Se-hoon presents a senior housing project in western Seoul",
      snippet: "",
    },
  ];
  let call = 0;
  const fetcher = async () => ({
    ok: true,
    status: 200,
    async json() {
      call += 1;
      const payload =
        call === 1
          ? {
              groups: [
                {
                  item_ids: ["housing-a", "housing-b"],
                  event_ar: "مشروع إسكان",
                  evidence: [
                    { item_id: "housing-a", quote: "youth housing project" },
                    { item_id: "housing-b", quote: "senior housing project" },
                  ],
                },
              ],
            }
          : { groups: [{ index: 0, same_event: false }] };
      return {
        steps: [
          {
            type: "model_output",
            content: [{ type: "text", text: JSON.stringify(payload) }],
          },
        ],
      };
    },
  });
  const groups = await clusterWithGemini(
    aiEnv(),
    items,
    seoul,
    fetcher,
  );
  assert.equal(groups.length, 2);
});

test("attribution accepts how the press actually names a mayor", () => {
  const madrid = MAYORS.find((mayor) => mayor.id === "madrid");
  const accept = (evidence) => {
    const source = `José Luis Martínez-Almeida es el alcalde de Madrid. ${evidence} El coste es de 12 millones de euros.`;
    return validateAiBrief(
      {
        headline_ar: "خوسيه لويس مارتينيز ألميدا يعلن خطة تجديد ساحة مايور",
        headline_evidence: evidence,
        facts: [
          {
            fact_ar: "كلفة الخطة 12 مليون يورو.",
            evidence: "El coste es de 12 millones de euros.",
          },
        ],
        topic_ar: "تجديد",
      },
      source,
      madrid,
      "brief-test",
    );
  };

  // اللقب وحده، وهو الشائع في الصحافة الإسبانية لعمدة اسمه Martínez-Almeida.
  assert.match(accept("Almeida ha presentado el plan de renovación.").title_ar, /ألميدا/);
  // الاسم بلا حركات، فالتطبيع يجب أن يوحّدهما.
  assert.ok(accept("Jose Luis Martinez-Almeida presento el plan."));
  // إشارة إلى المنصب بعد أن سمّته الصفحة، وهو أسلوب صحفي معتاد.
  assert.ok(accept("El alcalde ha presentado el plan de renovación."));
});

test("a quote that attributes the act to nobody is still rejected", () => {
  const madrid = MAYORS.find((mayor) => mayor.id === "madrid");
  const source =
    "José Luis Martínez-Almeida es el alcalde de Madrid. Las obras comenzarán en octubre.";
  assert.throws(
    () =>
      validateAiBrief(
        {
          headline_ar: "خوسيه لويس مارتينيز ألميدا يعلن بدء الأعمال",
          headline_evidence: "Las obras comenzarán en octubre.",
          facts: [
            { fact_ar: "تبدأ الأعمال في أكتوبر.", evidence: "Las obras comenzarán en octubre." },
          ],
          topic_ar: "أعمال",
        },
        source,
        madrid,
        "brief-test",
      ),
    /ai_ungrounded_headline/,
  );
});

test("an invented quote is still rejected no matter how it attributes", () => {
  const madrid = MAYORS.find((mayor) => mayor.id === "madrid");
  assert.throws(
    () =>
      validateAiBrief(
        {
          headline_ar: "خوسيه لويس مارتينيز ألميدا يعلن خطة",
          headline_evidence: "El alcalde Almeida anunció algo que la página no dice.",
          facts: [{ fact_ar: "حقيقة.", evidence: "tampoco existe" }],
          topic_ar: "خطة",
        },
        "José Luis Martínez-Almeida es el alcalde de Madrid.",
        madrid,
        "brief-test",
      ),
    /ai_ungrounded_headline/,
  );
});
