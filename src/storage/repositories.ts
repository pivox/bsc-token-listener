import type { Address } from 'viem';
import { pool } from './database.js';
import { parseJson, stringifyJson } from '../utils/json.js';
import type {
  PairInfo,
  SwapEvent,
  TokenMetadata,
  TokenSession,
  TradeRecord,
} from '../types/domain.js';
import type { TokenRiskReport } from '../security/token-risk.types.js';

export class SessionRepository {
  async save(session: TokenSession): Promise<void> {
    await pool.query(
      `INSERT INTO token_sessions(pair_address, token_address, status, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, to_timestamp($5 / 1000.0), to_timestamp($6 / 1000.0))
       ON CONFLICT (pair_address) DO UPDATE SET
         token_address = EXCLUDED.token_address,
         status = EXCLUDED.status,
         payload = EXCLUDED.payload,
         updated_at = EXCLUDED.updated_at`,
      [
        session.pair.pair.toLowerCase(),
        session.pair.token.toLowerCase(),
        session.status,
        stringifyJson(session),
        session.createdAtMs,
        session.updatedAtMs,
      ],
    );
  }

  async loadActive(): Promise<TokenSession[]> {
    const result = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM token_sessions
       WHERE status IN ('WAITING_FIRST_BUY', 'RISK_CHECKING', 'BUY_PENDING', 'HOLDING', 'SELL_PENDING', 'MANUAL_REVIEW')`,
    );
    return result.rows.map((row) => parseJson<TokenSession>(row.payload));
  }

  async countOpenPositions(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM token_sessions
       WHERE status IN ('BUY_PENDING', 'HOLDING', 'SELL_PENDING', 'MANUAL_REVIEW')`,
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  async countActive(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM token_sessions
       WHERE status IN ('WAITING_FIRST_BUY', 'RISK_CHECKING', 'BUY_PENDING', 'HOLDING', 'SELL_PENDING', 'MANUAL_REVIEW')`,
    );
    return Number(result.rows[0]?.count ?? '0');
  }
}

export class SwapEventRepository {
  async claim(event: SwapEvent): Promise<boolean> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO swap_events(
           event_id, pair_address, transaction_hash, block_number,
           transaction_index, log_index, kind, payload, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb,
           to_timestamp($9 / 1000.0), NOW())
         ON CONFLICT (event_id) DO NOTHING`,
        [
          event.id,
          event.pair.toLowerCase(),
          event.transactionHash.toLowerCase(),
          event.cursor.blockNumber.toString(),
          event.cursor.transactionIndex,
          event.cursor.logIndex,
          event.kind,
          stringifyJson(event),
          event.observedAtMs,
        ],
      );
      const result = await client.query<{ event_id: string }>(
        `UPDATE swap_events
         SET processing_status = 'PROCESSING', processing_error = NULL, updated_at = NOW()
         WHERE event_id = $1
           AND (
             processing_status IN ('PENDING', 'FAILED')
             OR (processing_status = 'PROCESSING' AND updated_at < NOW() - INTERVAL '60 seconds')
           )
         RETURNING event_id`,
        [event.id],
      );
      await client.query('COMMIT');
      return result.rows.length === 1;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markProcessed(eventId: string): Promise<void> {
    await pool.query(
      `UPDATE swap_events
       SET processing_status = 'PROCESSED', processed_at = NOW(), updated_at = NOW()
       WHERE event_id = $1`,
      [eventId],
    );
  }

  async markFailed(eventId: string, error: string): Promise<void> {
    await pool.query(
      `UPDATE swap_events
       SET processing_status = 'FAILED', processing_error = $2, updated_at = NOW()
       WHERE event_id = $1`,
      [eventId, error.slice(0, 4000)],
    );
  }
}

export class TradeRepository {
  async save(trade: TradeRecord): Promise<void> {
    await pool.query(
      `INSERT INTO trades(
         trade_id, pair_address, token_address, side, mode, status,
         transaction_hash, payload, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb,
         to_timestamp($9 / 1000.0), to_timestamp($10 / 1000.0))
       ON CONFLICT (trade_id) DO UPDATE SET
         status = EXCLUDED.status,
         transaction_hash = EXCLUDED.transaction_hash,
         payload = EXCLUDED.payload,
         updated_at = EXCLUDED.updated_at`,
      [
        trade.id,
        trade.pair.toLowerCase(),
        trade.token.toLowerCase(),
        trade.side,
        trade.mode,
        trade.status,
        trade.transactionHash?.toLowerCase() ?? null,
        stringifyJson(trade),
        trade.createdAtMs,
        trade.updatedAtMs,
      ],
    );
  }
}

export class RiskReportRepository {
  async save(report: TokenRiskReport): Promise<void> {
    await pool.query(
      `INSERT INTO token_risk_reports(
         id, token_address, pair_address, block_number,
         score, verdict, checks, report, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb,
         to_timestamp($9 / 1000.0))`,
      [
        report.id,
        report.token.toLowerCase(),
        report.pair.toLowerCase(),
        report.blockNumber.toString(),
        report.score,
        report.verdict,
        stringifyJson(report.checks),
        stringifyJson(report),
        report.createdAtMs,
      ],
    );
  }
}

export class DiscoveredTokenRepository {
  async upsert(input: {
    pair: PairInfo;
    metadata?: TokenMetadata;
    source?: 'PAIR_CREATED' | 'DIRECT_DEPLOYMENT';
  }): Promise<void> {
    const source = input.source ?? 'PAIR_CREATED';
    const payload = {
      pair: input.pair,
      metadata: input.metadata ?? null,
      source,
    };
    await pool.query(
      `INSERT INTO discovered_tokens(
         token_address, pair_address, source,
         deployment_transaction_hash, deployment_block,
         probable_bep20, payload, metadata, created_at, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb,
         to_timestamp($9 / 1000.0), NOW())
       ON CONFLICT (token_address) DO UPDATE SET
         pair_address = COALESCE(EXCLUDED.pair_address, discovered_tokens.pair_address),
         source = EXCLUDED.source,
         probable_bep20 = EXCLUDED.probable_bep20,
         payload = EXCLUDED.payload,
         metadata = COALESCE(EXCLUDED.metadata, discovered_tokens.metadata),
         updated_at = NOW()`,
      [
        input.pair.token.toLowerCase(),
        input.pair.pair.toLowerCase(),
        source,
        input.pair.createdTransactionHash.toLowerCase(),
        input.pair.createdBlock.toString(),
        Boolean(input.metadata),
        stringifyJson(payload),
        input.metadata ? stringifyJson(input.metadata) : null,
        input.pair.discoveredAtMs,
      ],
    );
  }
}

export class CheckpointRepository {
  async get(key: string): Promise<bigint | null> {
    const result = await pool.query<{ block_number: string }>(
      'SELECT block_number::text FROM listener_checkpoints WHERE listener_key = $1',
      [key],
    );
    return result.rows[0] ? BigInt(result.rows[0].block_number) : null;
  }

  async set(key: string, blockNumber: bigint): Promise<void> {
    await pool.query(
      `INSERT INTO listener_checkpoints(listener_key, block_number)
       VALUES ($1, $2)
       ON CONFLICT (listener_key) DO UPDATE SET
         block_number = EXCLUDED.block_number,
         updated_at = NOW()`,
      [key, blockNumber.toString()],
    );
  }
}

export function normalizeAddress(value: Address): string {
  return value.toLowerCase();
}
