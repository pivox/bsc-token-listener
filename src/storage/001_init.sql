CREATE TABLE IF NOT EXISTS token_sessions (
    pair_address TEXT PRIMARY KEY,
    token_address TEXT NOT NULL,
    status TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_sessions_status ON token_sessions(status);

CREATE TABLE IF NOT EXISTS swap_events (
    event_id TEXT PRIMARY KEY,
    pair_address TEXT NOT NULL,
    transaction_hash TEXT NOT NULL,
    block_number NUMERIC(78, 0) NOT NULL,
    log_index INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_swap_events_pair_block ON swap_events(pair_address, block_number, log_index);

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
    deployment_transaction_hash TEXT NOT NULL,
    deployment_block NUMERIC(78, 0) NOT NULL,
    probable_bep20 BOOLEAN NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
