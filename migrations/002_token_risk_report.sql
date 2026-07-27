ALTER TABLE discovered_tokens
  ADD COLUMN IF NOT EXISTS pair_address VARCHAR(42);
ALTER TABLE discovered_tokens
  ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'PAIR_CREATED';
ALTER TABLE discovered_tokens
  ADD COLUMN IF NOT EXISTS discovered_block BIGINT;
ALTER TABLE discovered_tokens
  ADD COLUMN IF NOT EXISTS transaction_hash VARCHAR(66);
ALTER TABLE discovered_tokens
  ADD COLUMN IF NOT EXISTS metadata JSONB;
ALTER TABLE discovered_tokens
  ADD COLUMN IF NOT EXISTS discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE discovered_tokens
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE UNIQUE INDEX IF NOT EXISTS discovered_tokens_token_address_uidx
  ON discovered_tokens(token_address);

CREATE TABLE IF NOT EXISTS token_risk_reports (
  id UUID PRIMARY KEY,
  token_address VARCHAR(42) NOT NULL,
  pair_address VARCHAR(42) NOT NULL,
  block_number BIGINT NOT NULL,
  score SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 100),
  verdict VARCHAR(10) NOT NULL CHECK (verdict IN ('ALLOW', 'REVIEW', 'BLOCK')),
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

ALTER TABLE swap_events
  ADD COLUMN IF NOT EXISTS processing_status VARCHAR(16) NOT NULL DEFAULT 'PENDING';
ALTER TABLE swap_events
  ADD COLUMN IF NOT EXISTS processing_error TEXT;
ALTER TABLE swap_events
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
ALTER TABLE swap_events
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE swap_events
SET processing_status = 'PROCESSED',
    processed_at = COALESCE(processed_at, observed_at),
    updated_at = NOW()
WHERE processing_status = 'PENDING';
