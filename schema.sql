CREATE TABLE IF NOT EXISTS mayors (
  id TEXT PRIMARY KEY,
  country_ar TEXT NOT NULL,
  city_ar TEXT NOT NULL,
  city_en TEXT NOT NULL,
  title_ar TEXT NOT NULL,
  title_en TEXT NOT NULL,
  name_en TEXT NOT NULL,
  name_native TEXT NOT NULL,
  name_ar TEXT NOT NULL,
  native_lang TEXT NOT NULL,
  native_lang_ar TEXT NOT NULL,
  country_code TEXT NOT NULL,
  gn_hl TEXT NOT NULL,
  gn_gl TEXT NOT NULL,
  official_host TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scans (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  query TEXT,
  mayor_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  found_count INTEGER DEFAULT 0,
  duplicate_count INTEGER DEFAULT 0,
  excluded_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  mayor_id TEXT NOT NULL,
  scan_id TEXT,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at TEXT,
  snippet TEXT,
  title_ar TEXT,
  snippet_ar TEXT,
  language TEXT,
  confidence TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'inbox',
  exclude_reason TEXT,
  fingerprint TEXT NOT NULL,
  trans_engine TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_items_status ON items(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_mayor ON items(mayor_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_fingerprint ON items(fingerprint);
CREATE INDEX IF NOT EXISTS idx_scans_started ON scans(started_at DESC);
