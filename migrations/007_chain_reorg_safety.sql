CREATE TABLE IF NOT EXISTS canonical_blocks (
  block_number NUMERIC(78, 0) PRIMARY KEY,
  block_hash TEXT NOT NULL UNIQUE,
  parent_hash TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_canonical_blocks_parent_hash
  ON canonical_blocks(parent_hash);

CREATE TABLE IF NOT EXISTS chain_reorgs (
  reorg_id TEXT PRIMARY KEY,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  common_ancestor_number NUMERIC(78, 0) NOT NULL,
  common_ancestor_hash TEXT NOT NULL,
  previous_tip_number NUMERIC(78, 0) NOT NULL,
  previous_tip_hash TEXT NOT NULL,
  replacement_tip_number NUMERIC(78, 0) NOT NULL,
  replacement_tip_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('HEALTHY', 'RECONCILING', 'MANUAL_REVIEW')),
  orphaned_block_count INTEGER NOT NULL DEFAULT 0,
  orphaned_event_count INTEGER NOT NULL DEFAULT 0,
  affected_session_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_chain_reorgs_detected_at
  ON chain_reorgs(detected_at DESC);

ALTER TABLE listener_checkpoints
  ADD COLUMN IF NOT EXISTS block_hash TEXT;

ALTER TABLE swap_events
  ADD COLUMN IF NOT EXISTS block_hash TEXT;
ALTER TABLE swap_events
  ADD COLUMN IF NOT EXISTS canonical BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE swap_events
  ADD COLUMN IF NOT EXISTS orphaned_at TIMESTAMPTZ;
ALTER TABLE swap_events
  ADD COLUMN IF NOT EXISTS session_before JSONB;
ALTER TABLE swap_events
  ADD COLUMN IF NOT EXISTS session_after JSONB;

ALTER TABLE discovered_tokens
  ADD COLUMN IF NOT EXISTS block_hash TEXT;
ALTER TABLE discovered_tokens
  ADD COLUMN IF NOT EXISTS canonical BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE token_risk_reports
  ADD COLUMN IF NOT EXISTS source_event_id TEXT;
ALTER TABLE token_risk_reports
  ADD COLUMN IF NOT EXISTS canonical BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS source_event_id TEXT;
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS canonical BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE token_sessions
  ADD COLUMN IF NOT EXISTS canonical BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_swap_events_transaction_log
  ON swap_events(transaction_hash, log_index);
CREATE INDEX IF NOT EXISTS idx_swap_events_canonical_block
  ON swap_events(canonical, block_number);
CREATE INDEX IF NOT EXISTS idx_discovered_tokens_canonical_block
  ON discovered_tokens(canonical, deployment_block);
CREATE INDEX IF NOT EXISTS idx_token_risk_reports_source_event
  ON token_risk_reports(source_event_id);
CREATE INDEX IF NOT EXISTS idx_token_risk_reports_canonical
  ON token_risk_reports(canonical, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trades_source_event
  ON trades(source_event_id);
CREATE INDEX IF NOT EXISTS idx_trades_canonical
  ON trades(canonical, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_token_sessions_canonical_status
  ON token_sessions(canonical, status);
