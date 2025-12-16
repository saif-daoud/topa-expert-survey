-- 0001_init.sql
-- D1 (SQLite) schema for TOPA expert survey

-- Store hashed access codes (sha256 hex of the human code)
CREATE TABLE IF NOT EXISTS access_codes (
  code_hash      TEXT PRIMARY KEY,          -- 64-hex sha256(code)
  active         INTEGER NOT NULL DEFAULT 1, -- 1=true, 0=false
  uses_remaining INTEGER,                   -- NULL = unlimited
  expires_at     TEXT,                      -- ISO-8601 string, NULL = never
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Store votes (one row per participant/component/trial)
CREATE TABLE IF NOT EXISTS votes (
  id             TEXT PRIMARY KEY,          -- e.g. P00001__action_space__3
  participant_id TEXT NOT NULL,
  component      TEXT NOT NULL,
  trial_id       INTEGER NOT NULL,
  left_method_id TEXT NOT NULL,
  right_method_id TEXT NOT NULL,
  preferred      TEXT NOT NULL CHECK (preferred IN ('left','right')),
  timestamp_utc  TEXT NOT NULL,             -- from client
  user_agent     TEXT,
  page_url       TEXT,
  received_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Helpful index for analysis queries
CREATE INDEX IF NOT EXISTS idx_votes_participant ON votes(participant_id);
CREATE INDEX IF NOT EXISTS idx_votes_component ON votes(component);
CREATE INDEX IF NOT EXISTS idx_votes_component_trial ON votes(component, trial_id);
