import test from "node:test";
import assert from "node:assert/strict";
import {
  aiBriefEnabled,
  buildAiBriefPrompt,
  summarizeWithGemini,
  validateAiBrief,
} from "../src/aiBrief.js";
import { MAYORS } from "../src/mayors.js";

const turin = MAYORS.find((mayor) => mayor.id === "turin");
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

test("AI prompt contains the fetched page body, not only its headline", () => {
  const longArticle = {
    ...article,
    article_text: `${"contenuto completo ".repeat(3000)} FINE-PAGINA-VERIFICATA`,
  };
  const prompt = buildAiBriefPrompt(longArticle, turin);
  assert.match(prompt, /FINE-PAGINA-VERIFICATA/);
  assert.match(prompt, /استخرج الزبدة من نص الصفحة/);
  assert.match(prompt, /اقتباسًا حرفيًا/);
});

test("Gemini brief accepts only facts backed by exact page quotes", async () => {
  let requestBody;
  const fetcher = async (_url, options) => {
    requestBody = JSON.parse(options.body);
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
                  text: JSON.stringify({
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
                  }),
                },
              ],
            },
          ],
        };
      },
    };
  };

  const brief = await summarizeWithGemini(
    { GEMINI_API_KEY: "secret", GEMINI_MODEL: "gemini-test" },
    article,
    turin,
    fetcher,
  );
  assert.equal(brief.engine, "brief-ai-gemini:gemini-test");
  assert.match(brief.title_ar, /ستيفانو لو روسو/);
  assert.match(brief.snippet_ar, /12 سبتمبر/);
  assert.match(brief.evidence, /La festa è prevista/);
  assert.equal(requestBody.store, false);
  assert.equal(requestBody.response_format.mime_type, "application/json");
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
