ALTER TABLE token_sessions
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
CREATE INDEX IF NOT EXISTS idx_token_sessions_token ON token_sessions(token_address);

ALTER TABLE swap_events
  ADD COLUMN IF NOT EXISTS transaction_index INTEGER NOT NULL DEFAULT 0;
ALTER TABLE swap_events
  ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE swap_events
  ADD COLUMN IF NOT EXISTS processing_error TEXT;
ALTER TABLE swap_events
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
ALTER TABLE swap_events
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE swap_events
SET processing_status = 'PROCESSED',
    processed_at = COALESCE(processed_at, created_at),
    updated_at = NOW()
WHERE processing_status = 'PENDING';

ALTER TABLE discovered_tokens
  ADD COLUMN IF NOT EXISTS pair_address TEXT;
ALTER TABLE discovered_tokens
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'PAIR_CREATED';
ALTER TABLE discovered_tokens
  ADD COLUMN IF NOT EXISTS metadata JSONB;
CREATE INDEX IF NOT EXISTS idx_discovered_tokens_pair ON discovered_tokens(pair_address);

CREATE TABLE IF NOT EXISTS token_risk_reports (
  id UUID PRIMARY KEY,
  token_address TEXT NOT NULL,
  pair_address TEXT NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  score SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  verdict TEXT NOT NULL CHECK (verdict IN ('ALLOW', 'REVIEW', 'BLOCK')),
  checks JSONB NOT NULL,
  report JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS token_risk_reports_token_created_idx
  ON token_risk_reports(token_address, created_at DESC);
CREATE INDEX IF NOT EXISTS token_risk_reports_pair_created_idx
  ON token_risk_reports(pair_address, created_at DESC);
CREATE INDEX IF NOT EXISTS token_risk_reports_verdict_idx
  ON token_risk_reports(verdict);

CREATE TABLE IF NOT EXISTS listener_checkpoints (
  listener_key TEXT PRIMARY KEY,
  block_number NUMERIC(78, 0) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
