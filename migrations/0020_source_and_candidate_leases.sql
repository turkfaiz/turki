-- Forward-only additive migration for source-poll and candidate-fetch leases
-- and the desk run lock used as an atomic active-run guard.
--
-- This file is applied ONCE by wrangler via the d1_migrations ledger:
--   wrangler d1 migrations apply mayor-watch --remote
-- ALTER TABLE ADD COLUMN is not re-runnable. Do not execute this file twice
-- outside the ledger. CREATE INDEX / CREATE TABLE IF NOT EXISTS are idempotent.
--
-- This migration does NOT bootstrap an empty database. The migrations folder
-- currently contains only 0020 and does not create base tables (mayors, items,
-- scans, ...). An empty D1 is out of scope here (reserved for a later schema
-- bootstrap). Production databases that already have those tables apply 0020
-- before deploying a Worker that reads the new columns.
--
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

CREATE TABLE IF NOT EXISTS desk_run_locks (
    lock_key TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    job_id TEXT,
    scan_id TEXT,
    kind TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    lease_until TEXT NOT NULL
  );
CREATE INDEX IF NOT EXISTS idx_desk_run_locks_lease ON desk_run_locks(lease_until);
