CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS discovered_tokens (
  token_address VARCHAR(42) PRIMARY KEY,
  pair_address VARCHAR(42),
  source VARCHAR(32) NOT NULL,
  discovered_block BIGINT NOT NULL,
  transaction_hash VARCHAR(66) NOT NULL,
  metadata JSONB,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS token_sessions (
  pair_address VARCHAR(42) PRIMARY KEY,
  token_address VARCHAR(42) NOT NULL,
  status VARCHAR(32) NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS token_sessions_status_idx ON token_sessions(status);
CREATE INDEX IF NOT EXISTS token_sessions_token_idx ON token_sessions(token_address);

CREATE TABLE IF NOT EXISTS swap_events (
  event_id VARCHAR(100) PRIMARY KEY,
  pair_address VARCHAR(42) NOT NULL,
  transaction_hash VARCHAR(66) NOT NULL,
  block_number BIGINT NOT NULL,
  transaction_index INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  kind VARCHAR(16) NOT NULL,
  data JSONB NOT NULL,
  processing_status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  processing_error TEXT,
  processed_at TIMESTAMPTZ,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS swap_events_pair_block_idx
  ON swap_events(pair_address, block_number, log_index);

CREATE TABLE IF NOT EXISTS trades (
  id UUID PRIMARY KEY,
  pair_address VARCHAR(42) NOT NULL,
  token_address VARCHAR(42) NOT NULL,
  side VARCHAR(8) NOT NULL,
  mode VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  transaction_hash VARCHAR(66),
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trades_pair_idx ON trades(pair_address);

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

CREATE TABLE IF NOT EXISTS listener_checkpoints (
  listener_key TEXT PRIMARY KEY,
  block_number BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
