import { config } from '../config/env.js';
import { pool } from '../storage/database.js';

const SETTING_KEY = 'risk_allow_unknown';

interface RiskSettingsRow {
  setting_value: unknown;
  updated_at: Date | string;
}

export interface RuntimeRiskSettings {
  allowUnknownReviews: boolean;
  allowUnknownMinScore: number;
  updatedAt: string | null;
}

interface StoredRiskSettings {
  allowUnknownReviews?: unknown;
  allowUnknownMinScore?: unknown;
}

function fallbackSettings(): RuntimeRiskSettings {
  return {
    allowUnknownReviews: config.riskAllowUnknownReviews,
    allowUnknownMinScore: config.riskAllowUnknownMinScore,
    updatedAt: null,
  };
}

function parseStoredSettings(row: RiskSettingsRow | undefined): RuntimeRiskSettings {
  if (!row || typeof row.setting_value !== 'object' || row.setting_value === null) {
    return fallbackSettings();
  }
  const stored = row.setting_value as StoredRiskSettings;
  const allowUnknownReviews = typeof stored.allowUnknownReviews === 'boolean'
    ? stored.allowUnknownReviews
    : config.riskAllowUnknownReviews;
  const rawScore = stored.allowUnknownMinScore;
  const allowUnknownMinScore = typeof rawScore === 'number' && Number.isInteger(rawScore)
    ? rawScore
    : config.riskAllowUnknownMinScore;
  return {
    allowUnknownReviews,
    allowUnknownMinScore,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export class RiskSettingsStore {
  async get(): Promise<RuntimeRiskSettings> {
    const result = await pool.query<RiskSettingsRow>(
      `SELECT setting_value, updated_at
       FROM runtime_settings
       WHERE setting_key = $1`,
      [SETTING_KEY],
    );
    return parseStoredSettings(result.rows[0]);
  }

  async set(input: {
    allowUnknownReviews: boolean;
    allowUnknownMinScore: number;
  }): Promise<RuntimeRiskSettings> {
    if (!Number.isInteger(input.allowUnknownMinScore)
      || input.allowUnknownMinScore < config.riskMinScore
      || input.allowUnknownMinScore > 100) {
      throw new Error(
        `Le seuil UNKNOWN doit être un entier entre ${config.riskMinScore} et 100.`,
      );
    }

    const result = await pool.query<RiskSettingsRow>(
      `INSERT INTO runtime_settings (setting_key, setting_value, updated_at)
       VALUES ($1, $2::jsonb, NOW())
       ON CONFLICT (setting_key) DO UPDATE
       SET setting_value = EXCLUDED.setting_value,
           updated_at = NOW()
       RETURNING setting_value, updated_at`,
      [
        SETTING_KEY,
        JSON.stringify({
          allowUnknownReviews: input.allowUnknownReviews,
          allowUnknownMinScore: input.allowUnknownMinScore,
        }),
      ],
    );
    return parseStoredSettings(result.rows[0]);
  }
}
