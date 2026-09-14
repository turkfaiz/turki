import test from "node:test";
import assert from "node:assert/strict";
import { ensureDb, pruneOldItems, reviewerOf } from "../src/worker.js";
import { translatePending, verifyPending } from "../src/translate.js";
import { currentVersion, isReadyForApproval, recordDecision } from "../src/versions.js";
import { createTestD1 } from "./helpers/d1.js";

const ARTICLE =
  "Stefano Lo Russo inaugura la nuova via pedonale di Via Roma. La festa è prevista sabato 12 settembre.";

function briefResponse() {
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
                  topic_ar: "افتتاح شارع",
                }),
              },
            ],
          },
        ],
      };
    },
  };
}

function verdictResponse(headlineSupported = true, factSupported = true) {
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
                  headline_supported: headlineSupported,
                  facts: [{ index: 0, supported: factSupported }],
                }),
              },
            ],
          },
        ],
      };
    },
  };
}

async function desk(overrides = {}) {
  const db = createTestD1();
  const env = {
    DB: db,
    GEMINI_API_KEY: "test",
    GEMINI_MODEL: "gemini-test",
    AI_DAILY_LIMIT: "1000",
    AI_MIN_INTERVAL_MS: "0",
    ...overrides,
  };
  await ensureDb(env);
  db.exec(`
    INSERT INTO items (
      id, mayor_id, source, title, title_normalized, url, published_at, snippet,
      title_ar, snippet_ar, language, confidence, status, fingerprint, trans_engine,
      publisher_domain, publisher_tier, article_text, source_count, brief_attempts
    ) VALUES (
      'a', 'turin', 'approved_feed', 'Lo Russo inaugura via Roma',
      'lo russo inaugura via roma', 'https://www.comune.torino.it/a',
      datetime('now','-1 days'), 'snippet', 'بانتظار', '', 'it', 'raw', 'inbox',
      'fp-a', 'brief-pending', 'comune.torino.it', 0, '${ARTICLE}', 1, 0
    );
  `);
  return { db, env };
}

test("a brief is saved before verification and survives a deferred verifier", async () => {
  const { db, env } = await desk();
  await translatePending(env, 1, null, async () => briefResponse());

  const saved = await currentVersion(env, "a");
  assert.ok(saved, "the brief exists as a version immediately");
  assert.equal(saved.verify_state, "pending");
  assert.match(saved.title_ar, /ستيفانو لو روسو يفتتح/);

  // المدقق يُمنع بالميزانية: يجب ألا يُفقد الموجز ولا يُعاد إنتاجه.
  let verifierCalls = 0;
  const blocked = { ...env, AI_DAILY_LIMIT: "0" };
  const result = await verifyPending(blocked, 1, async () => {
    verifierCalls += 1;
    return verdictResponse();
  });
  assert.equal(verifierCalls, 0, "no call is made when the budget cannot serve it");

  const stillThere = await currentVersion(env, "a");
  assert.equal(stillThere.id, saved.id, "the same version is kept, not regenerated");
  assert.equal(stillThere.title_ar, saved.title_ar);
  assert.ok(result.pending >= 1, "the desk reports verification still owed");

  // ثم يُستأنف من موضعه بلا إعادة تلخيص.
  const resumed = await verifyPending(env, 1, async () => verdictResponse());
  assert.equal(resumed.verified, 1);
  const passed = await currentVersion(env, "a");
  assert.equal(passed.id, saved.id, "verification resumes on the stored version");
  assert.equal(passed.verify_state, "passed");
});

test("an unverified brief is not ready for approval, a verified one is", async () => {
  const { env } = await desk();
  await translatePending(env, 1, null, async () => briefResponse());
  assert.equal(isReadyForApproval(await currentVersion(env, "a")), false);

  await verifyPending(env, 1, async () => verdictResponse());
  assert.equal(isReadyForApproval(await currentVersion(env, "a")), true);
});

test("a rejected claim leaves the brief unusable for approval", async () => {
  const { env } = await desk();
  await translatePending(env, 1, null, async () => briefResponse());
  await verifyPending(env, 1, async () => verdictResponse(false, true));

  const version = await currentVersion(env, "a");
  assert.equal(version.verify_state, "failed");
  assert.equal(isReadyForApproval(version), false);
});

test("a decision freezes what the reviewer saw, with who and when", async () => {
  const { db, env } = await desk();
  await translatePending(env, 1, null, async () => briefResponse());
  await verifyPending(env, 1, async () => verdictResponse());
  const version = await currentVersion(env, "a");

  await recordDecision(env, {
    itemId: "a",
    version,
    decision: "approved",
    reviewer: "mayorwatch",
    sourceText: ARTICLE,
  });

  const decision = db.one(`SELECT * FROM approvals WHERE item_id = 'a'`);
  assert.equal(decision.reviewer, "mayorwatch");
  assert.equal(decision.reviewer_known, 1);
  assert.ok(decision.decided_at, "the moment of the decision is recorded");
  assert.equal(decision.title_ar, version.title_ar, "the reviewed text is frozen");
  assert.equal(decision.source_hash, version.source_hash);
  assert.match(decision.source_snapshot, /Via Roma/, "the source is snapshotted");
  assert.equal(
    db.one(`SELECT approved_version_id FROM items WHERE id = 'a'`).approved_version_id,
    version.id,
  );
});

test("a changed source makes a new version needing review and keeps the approved one", async () => {
  const { db, env } = await desk();
  await translatePending(env, 1, null, async () => briefResponse());
  await verifyPending(env, 1, async () => verdictResponse());
  const approved = await currentVersion(env, "a");
  await recordDecision(env, {
    itemId: "a",
    version: approved,
    decision: "approved",
    reviewer: "mayorwatch",
    sourceText: ARTICLE,
  });

  // المصدر يتغير ثم يُعاد التلخيص.
  db.exec(`
    UPDATE items SET article_text = '${ARTICLE} Le opere iniziano a ottobre.',
      trans_engine = 'brief-pending', brief_attempts = 0 WHERE id = 'a';
  `);
  await translatePending(env, 1, null, async () => briefResponse());

  const fresh = await currentVersion(env, "a");
  assert.notEqual(fresh.id, approved.id, "a changed source produces a new version");
  assert.equal(fresh.verify_state, "pending", "the new version needs review again");
  assert.equal(
    db.one(`SELECT needs_review FROM items WHERE id = 'a'`).needs_review,
    1,
    "the desk flags that the approved text no longer matches the source",
  );

  const kept = db.one(`SELECT * FROM brief_versions WHERE id = '${approved.id}'`);
  assert.ok(kept, "the approved version is retained");
  assert.equal(kept.verify_state, "passed");
  const decision = db.one(`SELECT * FROM approvals WHERE version_id = '${approved.id}'`);
  assert.equal(decision.title_ar, approved.title_ar, "the approved evidence is untouched");
});

test("retention never removes an article that carries a decision", async () => {
  const { db, env } = await desk();
  await translatePending(env, 1, null, async () => briefResponse());
  await verifyPending(env, 1, async () => verdictResponse());
  const version = await currentVersion(env, "a");
  await recordDecision(env, {
    itemId: "a",
    version,
    decision: "approved",
    reviewer: "mayorwatch",
    sourceText: ARTICLE,
  });

  db.exec(`
    UPDATE items SET published_at = datetime('now','-400 days') WHERE id = 'a';
    INSERT INTO items (
      id, mayor_id, source, title, title_normalized, url, published_at, snippet,
      language, confidence, status, fingerprint, trans_engine, publisher_domain,
      publisher_tier, article_text, source_count, brief_attempts
    ) VALUES (
      'old', 'turin', 'approved_feed', 'vecchia notizia', 'vecchia notizia',
      'https://www.comune.torino.it/old', datetime('now','-400 days'), '',
      'it', 'raw', 'inbox', 'fp-old', 'brief-pending', 'comune.torino.it', 0,
      'testo', 1, 0
    );
  `);

  const removed = await pruneOldItems(env, 9);
  assert.equal(removed, 1, "only the undecided old article is removed");
  assert.ok(db.one(`SELECT id FROM items WHERE id = 'a'`), "the decided article stays");
  assert.equal(db.one(`SELECT id FROM items WHERE id = 'old'`), null);
  assert.ok(db.one(`SELECT id FROM approvals WHERE item_id = 'a'`), "its decision stays");
});

test("the reviewer is taken from the authenticated identity", () => {
  const request = new Request("https://example.com/api/items/a/status", {
    method: "POST",
    headers: { Authorization: `Basic ${btoa("hala:secret")}` },
  });
  assert.equal(reviewerOf(request, {}), "hala");
  const anonymous = new Request("https://example.com/api/items/a/status", { method: "POST" });
  assert.equal(reviewerOf(anonymous, { DASHBOARD_USER: "mayorwatch" }), "mayorwatch");
});
