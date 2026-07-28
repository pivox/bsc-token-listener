ALTER TABLE token_sessions
  ADD COLUMN IF NOT EXISTS recovery_owner TEXT;
ALTER TABLE token_sessions
  ADD COLUMN IF NOT EXISTS recovery_lease_until TIMESTAMPTZ;
ALTER TABLE token_sessions
  ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_sessions
  ADD COLUMN IF NOT EXISTS recovery_error TEXT;
ALTER TABLE token_sessions
  ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_token_sessions_recovery
  ON token_sessions(status, recovery_lease_until);

CREATE TABLE IF NOT EXISTS reconciliation_decisions (
  decision_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  pair_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  status_before TEXT NOT NULL,
  status_after TEXT NOT NULL,
  action TEXT NOT NULL,
  trade_id TEXT,
  transaction_hash TEXT,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_decisions_pair
  ON reconciliation_decisions(pair_address, created_at);
