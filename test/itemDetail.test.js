import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { ensureDb } from "../src/db/bootstrap.js";
import { createTestD1 } from "./helpers/d1.js";

test("the item detail carries the verifier's reason and the quote it rejected, the list does not", async () => {
  const env = { DB: createTestD1(), GEMINI_MODEL: "t" };
  await ensureDb(env);
  env.DB.exec(`
    INSERT INTO items (id, mayor_id, source, title, title_normalized, url, confidence, status, fingerprint, trans_engine, current_version_id)
    VALUES ('abc0f001', 'turin', 'approved_rss', 't', 't', 'https://x.example/1', 'raw', 'inbox', 'fp-detail', 'brief-ai-gemini-v2:m', 'ver-detail');
    INSERT INTO brief_versions (id, item_id, source_hash, engine, title_ar, snippet_ar, evidence, verify_state, verify_attempts, verify_detail)
    VALUES ('ver-detail', 'abc0f001', 'h', 'brief-ai-gemini-v2:m', 'عنوان', 'حقيقة', '{"headline":"Quote that failed","facts":["f"]}', 'failed', 1, 'ai_headline_not_supported');
  `);
  const { item } = await (await worker.fetch(new Request("https://mayor-watch.test/api/items/abc0f001"), env)).json();
  assert.equal(item.verify_state, "failed");
  assert.equal(item.verify_detail, "ai_headline_not_supported");
  assert.equal(JSON.parse(item.version_evidence).headline, "Quote that failed");
  assert.equal(item.desk_lane, "attention_required");
  assert.equal(item.attention_reason, "verify_failed");

  const { items } = await (await worker.fetch(new Request("https://mayor-watch.test/api/items?status=attention_required"), env)).json();
  assert.equal(items.find((row) => row.id === "abc0f001").version_evidence, undefined);
});
