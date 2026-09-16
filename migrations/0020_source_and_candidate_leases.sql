-- Forward-only additive migration for source-poll and candidate-fetch leases.
-- Applied once by wrangler (d1_migrations). Re-running the equivalent worker
-- helper is safe: each ALTER is skipped when the column already exists.
-- No DELETE, DROP, or table rebuild. Existing rows keep their values.

ALTER TABLE scan_sources ADD COLUMN claim_id TEXT;
ALTER TABLE scan_sources ADD COLUMN claimed_at TEXT;
ALTER TABLE scan_sources ADD COLUMN attempts INTEGER DEFAULT 0;
ALTER TABLE scan_sources ADD COLUMN next_attempt_at TEXT;
ALTER TABLE scan_sources ADD COLUMN last_error TEXT;

ALTER TABLE candidates ADD COLUMN fetch_claim_id TEXT;
ALTER TABLE candidates ADD COLUMN fetch_claimed_at TEXT;
ALTER TABLE candidates ADD COLUMN fetch_after TEXT;
ALTER TABLE candidates ADD COLUMN last_error TEXT;

CREATE INDEX IF NOT EXISTS idx_scan_sources_lease ON scan_sources(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_candidates_fetch_lease ON candidates(fetch_status, fetch_after, fetch_claimed_at);
