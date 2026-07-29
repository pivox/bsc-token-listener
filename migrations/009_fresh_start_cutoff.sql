CREATE TABLE IF NOT EXISTS fresh_start_runs (
  run_id TEXT PRIMARY KEY,
  cutoff_block_number NUMERIC(78, 0) NOT NULL
    CHECK (cutoff_block_number >= 0),
  cutoff_block_hash TEXT NOT NULL,
  cutoff_parent_hash TEXT NOT NULL,
  quarantined_sessions INTEGER NOT NULL
    CHECK (quarantined_sessions >= 0),
  quarantined_decisions INTEGER NOT NULL
    CHECK (quarantined_decisions >= 0),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fresh_start_runs_latest
  ON fresh_start_runs(applied_at DESC, run_id DESC);
