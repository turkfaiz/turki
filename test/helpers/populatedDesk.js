import { MAX_BRIEF_ATTEMPTS } from "../../src/aiDispatch.js";
import { MAX_VERIFY_ATTEMPTS } from "../../src/versions.js";

const EVIDENCE = JSON.stringify([
  { fact_ar: "موعد الاحتفال السبت 12 سبتمبر.", evidence: "La festa è prevista sabato 12 settembre." },
]);

export function snapshotProtected(db) {
  return {
    approvals: db.one(`SELECT COUNT(*) AS n FROM approvals`).n,
    brief_versions: db.one(`SELECT COUNT(*) AS n FROM brief_versions`).n,
    passed_versions: db.one(`SELECT COUNT(*) AS n FROM brief_versions WHERE verify_state = 'passed'`).n,
    approved_versions: db.one(
      `SELECT COUNT(*) AS n FROM brief_versions
       WHERE id IN (SELECT approved_version_id FROM items WHERE approved_version_id IS NOT NULL)`,
    ).n,
    evidence_versions: db.one(
      `SELECT COUNT(*) AS n FROM brief_versions WHERE IFNULL(evidence, '') <> ''`,
    ).n,
    evidence_approvals: db.one(
      `SELECT COUNT(*) AS n FROM approvals WHERE IFNULL(evidence, '') <> ''`,
    ).n,
    decided_items: db.one(
      `SELECT COUNT(*) AS n FROM items WHERE EXISTS (SELECT 1 FROM approvals WHERE approvals.item_id = items.id)`,
    ).n,
    items: db.one(`SELECT COUNT(*) AS n FROM items`).n,
    scans: db.one(`SELECT COUNT(*) AS n FROM scans`).n,
    jobs: db.one(`SELECT COUNT(*) AS n FROM search_jobs`).n,
    tasks: db.one(`SELECT COUNT(*) AS n FROM search_job_tasks`).n,
    candidates: db.one(`SELECT COUNT(*) AS n FROM candidates`).n,
    sources: db.one(`SELECT COUNT(*) AS n FROM sources`).n,
    mayors: db.one(`SELECT COUNT(*) AS n FROM mayors`).n,
    custom_mayors: db.one(`SELECT COUNT(*) AS n FROM mayors WHERE id = 'riyadh-noura'`).n,
    custom_sources: db.one(`SELECT COUNT(*) AS n FROM sources WHERE id = 'riyadh-noura:alriyadh.gov.sa'`).n,
    ai_calls: db.one(`SELECT IFNULL(SUM(calls), 0) AS n FROM ai_provider_budget`).n,
  };
}

/** قاعدة ممتلئة تمثل إنتاجًا قديمًا: قرارات، نسخ، أدلة، مصادر، عمدة مضاف. */
export function seedPopulatedDesk(db) {
  db.exec(`
    INSERT INTO mayors (
      id, country_ar, city_ar, city_en, title_ar, title_en, name_en, name_native, name_ar,
      native_lang, native_lang_ar, country_code, gn_hl, gn_gl, official_host
    ) VALUES (
      'riyadh-noura', 'السعودية', 'الرياض', 'Riyadh', 'عمدة الرياض', 'Mayor of Riyadh',
      'Noura Alabdullah', 'نورة العبدالله', 'نورة العبدالله', 'ar', 'العربية', 'SA', 'ar', 'SA',
      'alriyadh.gov.sa'
    );

    INSERT INTO sources (id, mayor_id, domain, name, tier, kind, url, rank, verified, enabled)
    VALUES (
      'riyadh-noura:alriyadh.gov.sa', 'riyadh-noura', 'alriyadh.gov.sa', 'بوابة الرياض',
      0, 'page', 'https://www.alriyadh.gov.sa/', 1, 1, 1
    );

    INSERT INTO items (
      id, mayor_id, source, title, title_normalized, url, published_at, snippet,
      title_ar, snippet_ar, language, confidence, status, fingerprint, trans_engine,
      publisher_domain, publisher_tier, article_text, source_count, brief_attempts,
      current_version_id, approved_version_id, brief_error
    ) VALUES
    ('item-reading', 'turin', 'approved_feed',
      'Lo Russo in visita', 'lo russo in visita',
      'https://www.comune.torino.it/reading', datetime('now','-1 days'), 'snippet',
      'بانتظار قراءة الذكاء الاصطناعي — ستيفانو لو روسو', '', 'it', 'raw', 'inbox',
      'fp-reading', 'brief-pending', 'comune.torino.it', 0,
      'Stefano Lo Russo visita i quartieri.', 1, 0, NULL, NULL, NULL),
    ('item-verifying', 'turin', 'approved_feed',
      'Lo Russo apre via Roma', 'lo russo apre via roma',
      'https://www.comune.torino.it/verifying', datetime('now','-1 days'), 'snippet',
      'ستيفانو لو روسو يفتتح شارع فيا روما', 'حقيقة بانتظار التدقيق.', 'it', 'raw', 'inbox',
      'fp-verifying', 'brief-ai-gemini-v2:gemini-test', 'comune.torino.it', 0,
      'Stefano Lo Russo inaugura Via Roma.', 1, 1, 'ver-pending', NULL, NULL),
    ('item-ready', 'turin', 'approved_feed',
      'Lo Russo al parco', 'lo russo al parco',
      'https://www.comune.torino.it/ready', datetime('now','-2 days'), 'snippet',
      'ستيفانو لو روسو يفتتح الحديقة', 'افتتاح الحديقة غدًا.', 'it', 'raw', 'inbox',
      'fp-ready', 'brief-ai-gemini-v2:gemini-test', 'comune.torino.it', 0,
      'Stefano Lo Russo apre il parco.', 1, 1, 'ver-passed', NULL, NULL),
    ('item-stale-ready', 'turin', 'approved_feed',
      'Notizia vecchia verificata', 'notizia vecchia verificata',
      'https://www.comune.torino.it/stale', datetime('now','-20 days'), 'snippet',
      'خبر مدقَّق خارج النافذة', 'حقيقة قديمة.', 'it', 'raw', 'inbox',
      'fp-stale-ready', 'brief-ai-gemini-v2:gemini-test', 'comune.torino.it', 0,
      'Vecchia notizia.', 1, 1, 'ver-stale', NULL, NULL),
    ('item-legacy-engine', 'seoul', 'approved_feed',
      'Oh Se-hoon park', 'oh se-hoon park',
      'https://www.yna.co.kr/legacy', datetime('now','-1 days'), 'snippet',
      'أوه سيه هون يفتتح حديقة', 'حديقة جديدة.', 'ko', 'raw', 'inbox',
      'fp-legacy', 'brief-ai-gemini-v2:gemini-test', 'yna.co.kr', 1,
      'Oh Se-hoon opened a park.', 1, 1, NULL, NULL, NULL),
    ('item-failed', 'seoul', 'approved_feed',
      'Oh Se-hoon housing', 'oh se-hoon housing',
      'https://www.yna.co.kr/failed', datetime('now','-1 days'), 'snippet',
      'أوه سيه هون يعلن إسكانًا', 'ادعاء مرفوض.', 'ko', 'raw', 'inbox',
      'fp-failed', 'brief-ai-gemini-v2:gemini-test', 'yna.co.kr', 1,
      'Oh Se-hoon announced housing.', 1, 1, 'ver-failed', NULL, NULL),
    ('item-approved', 'turin', 'approved_feed',
      'Lo Russo approved', 'lo russo approved',
      'https://www.comune.torino.it/approved', datetime('now','-3 days'), 'snippet',
      'ستيفانو لو روسو يعتمد مشروعًا', 'حقيقة معتمدة.', 'it', 'raw', 'approved',
      'fp-approved', 'brief-ai-gemini-v2:gemini-test', 'comune.torino.it', 0,
      'Stefano Lo Russo approva il progetto.', 1, 1, 'ver-approved', 'ver-approved', NULL),
    ('item-exhausted', 'madrid', 'approved_feed',
      'Almeida visita', 'almeida visita',
      'https://www.madrid.es/exhausted', datetime('now','-1 days'), 'snippet',
      'تعذر التلخيص', '', 'es', 'raw', 'inbox',
      'fp-exhausted', 'brief-ai-error', 'madrid.es', 0,
      'Almeida visita el distrito.', 1, ${MAX_BRIEF_ATTEMPTS}, NULL, NULL, 'ai_invalid_json');

    INSERT INTO brief_versions (
      id, item_id, source_hash, engine, title_ar, snippet_ar, evidence,
      verify_state, verify_attempts, verify_detail
    ) VALUES
    ('ver-pending', 'item-verifying', 'hash-pending', 'brief-ai-gemini-v2:gemini-test',
      'ستيفانو لو روسو يفتتح شارع فيا روما', 'حقيقة بانتظار التدقيق.', '${EVIDENCE.replace(/'/g, "''")}',
      'pending', 0, NULL),
    ('ver-passed', 'item-ready', 'hash-passed', 'brief-ai-gemini-v2:gemini-test',
      'ستيفانو لو روسو يفتتح الحديقة', 'افتتاح الحديقة غدًا.', '${EVIDENCE.replace(/'/g, "''")}',
      'passed', 1, NULL),
    ('ver-stale', 'item-stale-ready', 'hash-stale', 'brief-ai-gemini-v2:gemini-test',
      'خبر مدقَّق خارج النافذة', 'حقيقة قديمة.', '${EVIDENCE.replace(/'/g, "''")}',
      'passed', 1, NULL),
    ('ver-failed', 'item-failed', 'hash-failed', 'brief-ai-gemini-v2:gemini-test',
      'أوه سيه هون يعلن إسكانًا', 'ادعاء مرفوض.', '${EVIDENCE.replace(/'/g, "''")}',
      'failed', 1, 'ai_headline_not_supported'),
    ('ver-approved', 'item-approved', 'hash-approved', 'brief-ai-gemini-v2:gemini-test',
      'ستيفانو لو روسو يعتمد مشروعًا', 'حقيقة معتمدة.', '${EVIDENCE.replace(/'/g, "''")}',
      'passed', 1, NULL),
    ('ver-exhausted', 'item-verifying', 'hash-old', 'brief-ai-gemini-v2:gemini-test',
      'نسخة قديمة مستنفدة', 'لا تُستخدم.', '${EVIDENCE.replace(/'/g, "''")}',
      'pending', ${MAX_VERIFY_ATTEMPTS}, 'stale');

    UPDATE brief_versions SET superseded_at = datetime('now','-2 days') WHERE id = 'ver-exhausted';

    INSERT INTO approvals (
      id, item_id, version_id, decision, reviewer, reviewer_known, decided_at,
      source_hash, title_ar, snippet_ar, evidence, source_snapshot, note
    ) VALUES (
      'appr-1', 'item-approved', 'ver-approved', 'approved', 'mayorwatch', 1, datetime('now','-3 days'),
      'hash-approved', 'ستيفانو لو روسو يعتمد مشروعًا', 'حقيقة معتمدة.',
      '${EVIDENCE.replace(/'/g, "''")}', 'Stefano Lo Russo approva il progetto.', 'قرار محفوظ'
    );

    INSERT INTO scans (id, type, query, mayor_id, started_at, found_count)
    VALUES ('scan-1', 'manual', '', 'turin', datetime('now','-1 days'), 4);

    INSERT INTO search_jobs (id, query, mayor_id, status)
    VALUES ('job-1', '', 'turin', 'completed');

    INSERT INTO search_job_tasks (job_id, mayor_id, status, stage, detail)
    VALUES ('job-1', 'turin', 'completed', 'completed', 'اكتمل');

    INSERT INTO candidates (
      id, mayor_id, source_id, scan_id, url, title, discovered_at, stage, fetch_status
    ) VALUES (
      'cand-1', 'turin', 'turin:comune.torino.it', 'scan-1',
      'https://www.comune.torino.it/cand', 'candidate', datetime('now'),
      'candidate_discovered', 'pending'
    );

    INSERT INTO ai_provider_budget (day, provider, calls, last_call_at)
    VALUES (date('now'), 'gemini', 42, datetime('now','-1 hours'));
  `);
}
