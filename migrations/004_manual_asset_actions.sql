CREATE TABLE IF NOT EXISTS ignored_assets (
    token_address TEXT PRIMARY KEY,
    pair_address TEXT,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ignored_assets_pair
    ON ignored_assets(pair_address);
