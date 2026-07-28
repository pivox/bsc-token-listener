ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS wallet_address TEXT;
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS related_trade_id TEXT;
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS quoted_amount_out NUMERIC(78, 0);
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS actual_amount_in NUMERIC(78, 0);
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS actual_amount_out NUMERIC(78, 0);
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS gas_cost_wei NUMERIC(78, 0);
ALTER TABLE trades
  ADD COLUMN IF NOT EXISTS error TEXT;

CREATE INDEX IF NOT EXISTS idx_trades_related_trade
  ON trades(related_trade_id);
CREATE INDEX IF NOT EXISTS idx_trades_status
  ON trades(status);

CREATE TABLE IF NOT EXISTS trade_transactions (
  transaction_id TEXT PRIMARY KEY,
  trade_id TEXT NOT NULL REFERENCES trades(trade_id),
  step TEXT NOT NULL,
  status TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  transaction_hash TEXT NOT NULL,
  nonce NUMERIC(78, 0) NOT NULL,
  to_address TEXT NOT NULL,
  value_wei NUMERIC(78, 0) NOT NULL,
  block_number NUMERIC(78, 0),
  gas_used NUMERIC(78, 0),
  effective_gas_price NUMERIC(78, 0),
  gas_cost_wei NUMERIC(78, 0),
  receipt_status TEXT,
  native_balance_before NUMERIC(78, 0),
  native_balance_after NUMERIC(78, 0),
  token_balance_before NUMERIC(78, 0),
  token_balance_after NUMERIC(78, 0),
  error TEXT,
  measurement_error TEXT,
  payload JSONB NOT NULL,
  submitted_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_transactions_hash
  ON trade_transactions(transaction_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_transactions_wallet_nonce
  ON trade_transactions(wallet_address, nonce);
CREATE INDEX IF NOT EXISTS idx_trade_transactions_trade
  ON trade_transactions(trade_id, created_at);
CREATE INDEX IF NOT EXISTS idx_trade_transactions_status
  ON trade_transactions(status);
