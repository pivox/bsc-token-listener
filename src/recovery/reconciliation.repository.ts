import { randomUUID } from 'node:crypto';
import { pool } from '../storage/database.js';
import type {
  TokenSession,
  TradeRecord,
  TradeTransactionRecord,
} from '../types/domain.js';
import { parseJson, stringifyJson } from '../utils/json.js';
import type {
  ClaimedRecovery,
  RecoveryDecision,
  ReconciliationStore,
} from './recovery.types.js';

interface QueryResult<T> {
  rows: T[];
}

interface DatabaseClient {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
  release(): void;
}

interface RecoveryDatabase {
  connect(): Promise<DatabaseClient>;
}

const PASS_LOCK_ID = 707_007_007;

export class ReconciliationRepository implements ReconciliationStore {
  private passLockClient: DatabaseClient | null = null;

  constructor(
    private readonly database: RecoveryDatabase =
      pool as unknown as RecoveryDatabase,
  ) {}

  async tryAcquirePassLock(): Promise<boolean> {
    if (this.passLockClient) return false;
    const client = await this.database.connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [PASS_LOCK_ID],
      );
      if (!result.rows[0]?.acquired) {
        client.release();
        return false;
      }
      this.passLockClient = client;
      return true;
    } catch (error) {
      client.release();
      throw error;
    }
  }

  async releasePassLock(): Promise<void> {
    const client = this.passLockClient;
    if (!client) return;
    this.passLockClient = null;
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [PASS_LOCK_ID]);
    } finally {
      client.release();
    }
  }

  async claimNext(
    owner: string,
    leaseMs: number,
    excludedPairs: readonly string[] = [],
  ): Promise<ClaimedRecovery | null> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query<{
        payload: unknown;
        status: TokenSession['status'];
      }>(
        `WITH candidate AS (
           SELECT pair_address
           FROM token_sessions
           WHERE status IN ('RISK_CHECKING', 'BUY_PENDING', 'SELL_PENDING')
             AND (recovery_lease_until IS NULL OR recovery_lease_until < NOW())
             AND NOT (pair_address = ANY($3::text[]))
           ORDER BY updated_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE token_sessions s
         SET recovery_owner = $1,
             recovery_lease_until = NOW() + ($2::text || ' milliseconds')::interval,
             recovery_attempts = recovery_attempts + 1
         FROM candidate
         WHERE s.pair_address = candidate.pair_address
         RETURNING s.payload, s.status`,
        [owner, leaseMs, excludedPairs.map((pair) => pair.toLowerCase())],
      );
      const row = claimed.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return null;
      }
      const session = parseJson<TokenSession>(row.payload);
      const tradesResult = await client.query<{ payload: unknown }>(
        `SELECT payload
         FROM trades
         WHERE pair_address = $1
         ORDER BY created_at`,
        [session.pair.pair.toLowerCase()],
      );
      const trades = tradesResult.rows.map((trade) =>
        parseJson<TradeRecord>(trade.payload));
      let transactions: TradeTransactionRecord[] = [];
      if (trades.length > 0) {
        const transactionsResult = await client.query<{ payload: unknown }>(
          `SELECT x.payload
           FROM trade_transactions x
           JOIN trades t ON t.trade_id = x.trade_id
           WHERE t.pair_address = $1
           ORDER BY x.created_at`,
          [session.pair.pair.toLowerCase()],
        );
        transactions = transactionsResult.rows.map((transaction) =>
          parseJson<TradeTransactionRecord>(transaction.payload));
      }
      await client.query('COMMIT');
      return {
        owner,
        statusBefore: row.status,
        snapshot: { session, trades, transactions },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getBacklogCounts(): Promise<{
    pendingSessions: number;
    manualReviewSessions: number;
  }> {
    const client = await this.database.connect();
    try {
      const result = await client.query<{
        pending_sessions: string;
        manual_review_sessions: string;
      }>(
        `SELECT
           COUNT(*) FILTER (
             WHERE status IN ('RISK_CHECKING', 'BUY_PENDING', 'SELL_PENDING')
           )::text AS pending_sessions,
           COUNT(*) FILTER (
             WHERE status = 'MANUAL_REVIEW'
           )::text AS manual_review_sessions
         FROM token_sessions`,
      );
      return {
        pendingSessions: Number(result.rows[0]?.pending_sessions ?? '0'),
        manualReviewSessions: Number(result.rows[0]?.manual_review_sessions ?? '0'),
      };
    } finally {
      client.release();
    }
  }

  async applyDecision(
    claimed: ClaimedRecovery,
    decision: RecoveryDecision,
  ): Promise<void> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const updated = await client.query<{ pair_address: string }>(
        `UPDATE token_sessions
         SET status = $3,
             payload = $4::jsonb,
             recovery_owner = CASE WHEN $7 THEN recovery_owner ELSE NULL END,
             recovery_lease_until = CASE WHEN $7 THEN recovery_lease_until ELSE NULL END,
             recovery_error = $5,
             last_reconciled_at = NOW(),
             updated_at = NOW()
         WHERE pair_address = $1
           AND recovery_owner = $2
           AND status = $6
         RETURNING pair_address`,
        [
          decision.session.pair.pair.toLowerCase(),
          claimed.owner,
          decision.session.status,
          stringifyJson(decision.session),
          decision.reason,
          claimed.statusBefore,
          decision.retainLease ?? false,
        ],
      );
      if (updated.rows.length !== 1) {
        throw new Error('Bail ou état de réconciliation obsolète.');
      }
      if (decision.trade) await this.updateTrade(client, decision.trade);
      if (decision.transaction) {
        await this.updateTransaction(client, decision.transaction);
      }
      await client.query(
        `INSERT INTO reconciliation_decisions(
           decision_id, idempotency_key, pair_address, token_address,
           status_before, status_after, action, trade_id,
           transaction_hash, reason
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [
          randomUUID(),
          decision.idempotencyKey,
          decision.session.pair.pair.toLowerCase(),
          decision.session.pair.token.toLowerCase(),
          claimed.statusBefore,
          decision.session.status,
          decision.action,
          decision.trade?.id ?? null,
          decision.transaction?.transactionHash.toLowerCase() ?? null,
          decision.reason,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async updateTrade(
    client: DatabaseClient,
    trade: TradeRecord,
  ): Promise<void> {
    await client.query(
      `UPDATE trades
       SET status = $2,
           transaction_hash = $3,
           actual_amount_in = $4,
           actual_amount_out = $5,
           gas_cost_wei = $6,
           error = $7,
           payload = $8::jsonb,
           updated_at = to_timestamp($9 / 1000.0)
       WHERE trade_id = $1`,
      [
        trade.id,
        trade.status,
        trade.transactionHash?.toLowerCase() ?? null,
        trade.actualAmountIn?.toString() ?? null,
        trade.actualAmountOut?.toString() ?? null,
        trade.gasCostWei?.toString() ?? null,
        trade.error ?? null,
        stringifyJson(trade),
        trade.updatedAtMs,
      ],
    );
  }

  private async updateTransaction(
    client: DatabaseClient,
    transaction: TradeTransactionRecord,
  ): Promise<void> {
    await client.query(
      `UPDATE trade_transactions
       SET status = $2,
           block_number = $3,
           gas_used = $4,
           effective_gas_price = $5,
           gas_cost_wei = $6,
           receipt_status = $7,
           native_balance_after = $8,
           token_balance_after = $9,
           error = $10,
           measurement_error = $11,
           confirmed_at = CASE
             WHEN $12::double precision IS NULL THEN NULL
             ELSE to_timestamp($12 / 1000.0)
           END,
           payload = $13::jsonb,
           updated_at = to_timestamp($14 / 1000.0)
       WHERE transaction_id = $1`,
      [
        transaction.id,
        transaction.status,
        transaction.blockNumber?.toString() ?? null,
        transaction.gasUsed?.toString() ?? null,
        transaction.effectiveGasPrice?.toString() ?? null,
        transaction.gasCostWei?.toString() ?? null,
        transaction.receiptStatus ?? null,
        transaction.nativeBalanceAfter?.toString() ?? null,
        transaction.tokenBalanceAfter?.toString() ?? null,
        transaction.error ?? null,
        transaction.measurementError ?? null,
        transaction.confirmedAtMs ?? null,
        stringifyJson(transaction),
        transaction.updatedAtMs,
      ],
    );
  }
}
