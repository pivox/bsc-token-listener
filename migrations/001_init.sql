CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS token_sessions (
  pair_address TEXT PRIMARY KEY,
  token_address TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_sessions_status ON token_sessions(status);
CREATE INDEX IF NOT EXISTS idx_token_sessions_token ON token_sessions(token_address);

CREATE TABLE IF NOT EXISTS swap_events (
  event_id TEXT PRIMARY KEY,
  pair_address TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  transaction_index INTEGER NOT NULL DEFAULT 0,
  log_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'PENDING',
  processing_error TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_swap_events_pair_block
  ON swap_events(pair_address, block_number, log_index);

CREATE TABLE IF NOT EXISTS trades (
  trade_id TEXT PRIMARY KEY,
  pair_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  side TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  transaction_hash TEXT,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades(pair_address, created_at);

CREATE TABLE IF NOT EXISTS discovered_tokens (
  token_address TEXT PRIMARY KEY,
  pair_address TEXT,
  source TEXT NOT NULL DEFAULT 'PAIR_CREATED',
  deployment_transaction_hash TEXT NOT NULL,
  deployment_block NUMERIC(78, 0) NOT NULL,
  probable_bep20 BOOLEAN NOT NULL,
  payload JSONB NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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
