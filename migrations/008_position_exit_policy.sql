CREATE TABLE IF NOT EXISTS strategy_settings (
  setting_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  setting_value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategy_settings_audit (
  audit_id TEXT PRIMARY KEY,
  setting_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  previous_value JSONB,
  next_value JSONB NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('DASHBOARD', 'ENV_RESET')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (setting_key, revision)
);

CREATE TABLE IF NOT EXISTS position_exit_decisions (
  decision_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  pair_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0),
  primary_rule TEXT NOT NULL,
  triggered_rules JSONB NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('SELL', 'EMERGENCY_SELL', 'MANUAL_REVIEW')
  ),
  status TEXT NOT NULL CHECK (
    status IN (
      'PENDING', 'EXECUTING', 'EXECUTED',
      'MANUAL_REVIEW', 'FAILED', 'SUPERSEDED'
    )
  ),
  metrics JSONB NOT NULL,
  reason TEXT NOT NULL,
  error_type TEXT,
  related_trade_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  execution_started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_position_exit_decisions_pair_status
  ON position_exit_decisions(pair_address, status, created_at DESC);
