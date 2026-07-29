import { randomUUID } from 'node:crypto';
import { getAddress, isAddress } from 'viem';
import { pool } from '../storage/database.js';
import { parseJson, stringifyJson } from '../utils/json.js';
import {
  parsePositionExitSettings,
  type PositionExitSettings,
} from './position-exit-settings.js';
import type { PositionExitSettingsStore } from './position-exit-settings.provider.js';
import type {
  EffectivePositionExitSettings,
  ExitRuleCode,
  NewPositionExitDecision,
  PositionExitDecision,
  PositionExitDecisionStatus,
  PositionMetricsSnapshot,
} from './position-exit.types.js';

interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface Client extends Queryable {
  release(): void;
}

interface Database extends Queryable {
  connect(): Promise<Client>;
}

interface SettingsRow {
  revision: number;
  setting_value: unknown;
  updated_at: Date | string;
}

interface DecisionRow {
  decision_id: string;
  idempotency_key: string;
  pair_address: string;
  token_address: string;
  settings_revision: number;
  primary_rule: string;
  triggered_rules: unknown;
  action: string;
  status: string;
  metrics: unknown;
  reason: string;
  error_type: string | null;
  related_trade_id: string | null;
  created_at: Date | string;
  execution_started_at: Date | string | null;
  updated_at: Date | string;
}

const SETTING_KEY = 'position-exit-policy';
const RULES = new Set<ExitRuleCode>([
  'SELLABILITY_UNCERTAIN',
  'SELLABILITY_BLOCKED',
  'LIQUIDITY_DROP',
  'STOP_LOSS',
  'MAX_HOLDING_TIME',
  'TRAILING_STOP',
  'TAKE_PROFIT',
  'TARGET_BUYS',
  'GAS_RATIO_EXCEEDED',
  'EMERGENCY_GAS_EXCEEDED',
]);
const STATUSES = new Set<PositionExitDecisionStatus>([
  'PENDING',
  'EXECUTING',
  'EXECUTED',
  'MANUAL_REVIEW',
  'FAILED',
  'SUPERSEDED',
]);

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Date PostgreSQL invalide.');
  return date.toISOString();
}

function ms(value: Date | string): number {
  return new Date(value).getTime();
}

function metrics(value: unknown): PositionMetricsSnapshot {
  const parsed = parseJson<PositionMetricsSnapshot>(value);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.quoteWei !== 'bigint' ||
    typeof parsed.entryCostWei !== 'bigint' ||
    typeof parsed.netExitValueWei !== 'bigint' ||
    typeof parsed.currentLiquidityWbnbWei !== 'bigint' ||
    typeof parsed.estimatedExitGasWei !== 'bigint' ||
    !Number.isInteger(parsed.sellTaxBps) ||
    !['SAFE', 'BLOCKED', 'UNKNOWN'].includes(parsed.probeStatus) ||
    !Number.isSafeInteger(parsed.probeMeasuredAtMs)
  ) {
    throw new Error('Métriques de décision persistées invalides.');
  }
  return parsed;
}

function mapDecision(row: DecisionRow): PositionExitDecision {
  if (
    !isAddress(row.pair_address) ||
    !isAddress(row.token_address) ||
    !RULES.has(row.primary_rule as ExitRuleCode) ||
    !STATUSES.has(row.status as PositionExitDecisionStatus)
  ) {
    throw new Error('Décision de sortie persistée invalide.');
  }
  const triggeredRules = parseJson<unknown>(row.triggered_rules);
  if (
    !Array.isArray(triggeredRules) ||
    !triggeredRules.every(
      (rule) => typeof rule === 'string' && RULES.has(rule as ExitRuleCode),
    )
  ) {
    throw new Error('Règles de décision persistées invalides.');
  }
  if (
    row.action !== 'SELL' &&
    row.action !== 'EMERGENCY_SELL' &&
    row.action !== 'MANUAL_REVIEW'
  ) {
    throw new Error('Action de décision persistée invalide.');
  }
  const decision: PositionExitDecision = {
    id: row.decision_id,
    idempotencyKey: row.idempotency_key,
    pair: getAddress(row.pair_address),
    token: getAddress(row.token_address),
    settingsRevision: row.settings_revision,
    primaryRule: row.primary_rule as ExitRuleCode,
    triggeredRules: triggeredRules as ExitRuleCode[],
    action: row.action,
    status: row.status as PositionExitDecisionStatus,
    metrics: metrics(row.metrics),
    reason: row.reason,
    createdAtMs: ms(row.created_at),
    updatedAtMs: ms(row.updated_at),
  };
  if (row.error_type) decision.errorType = row.error_type;
  if (row.related_trade_id) decision.relatedTradeId = row.related_trade_id;
  if (row.execution_started_at) {
    decision.executionStartedAtMs = ms(row.execution_started_at);
  }
  return decision;
}

export class PositionExitRepository implements PositionExitSettingsStore {
  constructor(
    private readonly database: Database = pool as unknown as Database,
  ) {}

  async getSettings(): Promise<EffectivePositionExitSettings | null> {
    const result = await this.database.query<SettingsRow>(
      `SELECT revision, setting_value, updated_at
       FROM strategy_settings WHERE setting_key = $1`,
      [SETTING_KEY],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      settings: parsePositionExitSettings(parseJson<unknown>(row.setting_value)),
      revision: row.revision,
      source: 'DATABASE',
      updatedAt: iso(row.updated_at),
    };
  }

  async saveSettings(
    value: PositionExitSettings,
    expectedRevision: number,
    source: 'DASHBOARD',
  ): Promise<EffectivePositionExitSettings> {
    const parsed = parsePositionExitSettings(value);
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<SettingsRow>(
        `SELECT revision, setting_value, updated_at
         FROM strategy_settings WHERE setting_key = $1 FOR UPDATE`,
        [SETTING_KEY],
      );
      const previous = current.rows[0];
      const revision = previous?.revision ?? 0;
      if (revision !== expectedRevision) {
        throw new Error(
          `Conflit de révision: attendu ${expectedRevision}, courant ${revision}.`,
        );
      }
      const nextRevision = revision + 1;
      const saved = await client.query<SettingsRow>(
        `INSERT INTO strategy_settings(
           setting_key, revision, setting_value, created_at, updated_at
         ) VALUES ($1, $2, $3::jsonb, NOW(), NOW())
         ON CONFLICT (setting_key) DO UPDATE SET
           revision = EXCLUDED.revision,
           setting_value = EXCLUDED.setting_value,
           updated_at = NOW()
         RETURNING revision, setting_value, updated_at`,
        [SETTING_KEY, nextRevision, stringifyJson(parsed)],
      );
      await client.query(
        `INSERT INTO strategy_settings_audit(
           audit_id, setting_key, revision, previous_value, next_value, source
         ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
        [
          randomUUID(),
          SETTING_KEY,
          nextRevision,
          previous ? stringifyJson(previous.setting_value) : null,
          stringifyJson(parsed),
          source,
        ],
      );
      await client.query('COMMIT');
      const row = saved.rows[0];
      if (!row) throw new Error('Réglages non retournés après commit.');
      return {
        settings: parsePositionExitSettings(parseJson<unknown>(row.setting_value)),
        revision: row.revision,
        source: 'DATABASE',
        updatedAt: iso(row.updated_at),
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async resetSettings(
    expectedRevision: number,
    defaults: PositionExitSettings,
  ): Promise<EffectivePositionExitSettings> {
    const parsedDefaults = parsePositionExitSettings(defaults);
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<SettingsRow>(
        `SELECT revision, setting_value, updated_at
         FROM strategy_settings WHERE setting_key = $1 FOR UPDATE`,
        [SETTING_KEY],
      );
      const previous = current.rows[0];
      const revision = previous?.revision ?? 0;
      if (revision !== expectedRevision) {
        throw new Error(
          `Conflit de révision: attendu ${expectedRevision}, courant ${revision}.`,
        );
      }
      await client.query(
        `INSERT INTO strategy_settings_audit(
           audit_id, setting_key, revision, previous_value, next_value, source
         ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, 'ENV_RESET')`,
        [
          randomUUID(),
          SETTING_KEY,
          revision + 1,
          previous ? stringifyJson(previous.setting_value) : null,
          stringifyJson(parsedDefaults),
        ],
      );
      await client.query(
        'DELETE FROM strategy_settings WHERE setting_key = $1',
        [SETTING_KEY],
      );
      await client.query('COMMIT');
      return {
        settings: parsedDefaults,
        revision: 0,
        source: 'ENV',
        updatedAt: null,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createDecision(
    input: NewPositionExitDecision,
  ): Promise<PositionExitDecision> {
    const id = randomUUID();
    await this.database.query(
      `INSERT INTO position_exit_decisions(
         decision_id, idempotency_key, pair_address, token_address,
         settings_revision, primary_rule, triggered_rules, action, status,
         metrics, reason
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'PENDING', $9::jsonb, $10)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        id,
        input.idempotencyKey,
        input.pair.toLowerCase(),
        input.token.toLowerCase(),
        input.settingsRevision,
        input.primaryRule,
        stringifyJson(input.triggeredRules),
        input.action,
        stringifyJson(input.metrics),
        input.reason,
      ],
    );
    const result = await this.database.query<DecisionRow>(
      `SELECT * FROM position_exit_decisions WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Décision non retrouvée après création.');
    return mapDecision(row);
  }

  async findDecision(id: string): Promise<PositionExitDecision | null> {
    const result = await this.database.query<DecisionRow>(
      'SELECT * FROM position_exit_decisions WHERE decision_id = $1',
      [id],
    );
    const row = result.rows[0];
    return row ? mapDecision(row) : null;
  }

  async transitionDecision(
    id: string,
    expected: PositionExitDecisionStatus,
    next: PositionExitDecisionStatus,
    patch: { relatedTradeId?: string; errorType?: string } = {},
  ): Promise<boolean> {
    const result = await this.database.query<{ decision_id: string }>(
      `UPDATE position_exit_decisions SET
         status = $3,
         related_trade_id = COALESCE($4, related_trade_id),
         error_type = COALESCE($5, error_type),
         execution_started_at = CASE
           WHEN $3 = 'EXECUTING' THEN COALESCE(execution_started_at, NOW())
           ELSE execution_started_at
         END,
         updated_at = NOW()
       WHERE decision_id = $1 AND status = $2
       RETURNING decision_id`,
      [id, expected, next, patch.relatedTradeId ?? null, patch.errorType ?? null],
    );
    return result.rows.length === 1;
  }

  async listRecoverableDecisions(): Promise<PositionExitDecision[]> {
    const result = await this.database.query<DecisionRow>(
      `SELECT * FROM position_exit_decisions
       WHERE status IN ('PENDING', 'EXECUTING')
       ORDER BY created_at, decision_id`,
    );
    return result.rows.map(mapDecision);
  }
}
