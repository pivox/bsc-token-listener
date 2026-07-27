CREATE TABLE IF NOT EXISTS runtime_settings (
    setting_key TEXT PRIMARY KEY,
    setting_value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
