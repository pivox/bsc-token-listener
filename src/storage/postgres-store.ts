import { Pool } from 'pg';
import type { Address } from 'viem';
import type {
  ClassifiedSwap,
  DiscoveredTokenRecord,
  SessionSnapshot,
  TradeRecord,
} from '../types/domain.js';
import { parseWithBigInt, stringifyWithBigInt } from '../utils/bigint-json.js';
import { INITIAL_SCHEMA_SQL } from './schema.js';
import type { BotStore } from './store.js';

const terminalStatuses = ['CLOSED', 'REJECTED', 'EXPIRED', 'ERROR'] as const;

interface PayloadRow {
  payload: string;
}

export class PostgresStore implements BotStore {
  private readonly pool: Pool;

  public constructor(
    connectionString: string,
    private readonly autoMigrate: boolean,
  ) {
    this.pool = new Pool({
      connectionString,
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }

  public async initialize(): Promise<void> {
    if (this.autoMigrate) {
      await this.pool.query(INITIAL_SCHEMA_SQL);
    }
    await this.pool.query('SELECT 1');
  }

  public async migrate(): Promise<void> {
    await this.pool.query(INITIAL_SCHEMA_SQL);
  }

  public async saveSession(session: SessionSnapshot): Promise<void> {
    await this.pool.query(
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
        stringifyWithBigInt(session),
        session.createdAtMs,
        session.updatedAtMs,
      ],
    );
  }

  public async getSession(pair: Address): Promise<SessionSnapshot | undefined> {
    const result = await this.pool.query<PayloadRow>(
      'SELECT payload::text AS payload FROM token_sessions WHERE pair_address = $1',
      [pair.toLowerCase()],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : parseWithBigInt<SessionSnapshot>(row.payload);
  }

  public async listOpenSessions(): Promise<SessionSnapshot[]> {
    const result = await this.pool.query<PayloadRow>(
      `SELECT payload::text AS payload
       FROM token_sessions
       WHERE status <> ALL($1::text[])
       ORDER BY created_at ASC`,
      [terminalStatuses],
    );
    return result.rows.map((row) => parseWithBigInt<SessionSnapshot>(row.payload));
  }

  public async saveSwapEvent(event: ClassifiedSwap): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO swap_events(event_id, pair_address, transaction_hash, block_number, log_index, kind, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [
        event.id,
        event.pair.toLowerCase(),
        event.transactionHash,
        event.cursor.blockNumber.toString(),
        event.cursor.logIndex,
        event.kind,
        stringifyWithBigInt(event),
      ],
    );
    return result.rowCount === 1;
  }

  public async saveTrade(trade: TradeRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO trades(trade_id, pair_address, token_address, side, mode, status, transaction_hash, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, to_timestamp($9 / 1000.0), to_timestamp($10 / 1000.0))
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
        trade.transactionHash ?? null,
        stringifyWithBigInt(trade),
        trade.createdAtMs,
        trade.updatedAtMs,
      ],
    );
  }

  public async saveDiscoveredToken(token: DiscoveredTokenRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO discovered_tokens(token_address, deployment_transaction_hash, deployment_block, probable_bep20, payload, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, to_timestamp($6 / 1000.0), to_timestamp($6 / 1000.0))
       ON CONFLICT (token_address) DO UPDATE SET
         probable_bep20 = EXCLUDED.probable_bep20,
         payload = EXCLUDED.payload,
         updated_at = NOW()`,
      [
        token.address.toLowerCase(),
        token.deploymentTransactionHash,
        token.deploymentBlock.toString(),
        token.isProbableBep20,
        stringifyWithBigInt(token),
        token.discoveredAtMs,
      ],
    );
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }
}
