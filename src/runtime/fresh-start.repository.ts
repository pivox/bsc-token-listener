import { randomUUID } from 'node:crypto';
import { isHash } from 'viem';
import { pool } from '../storage/database.js';
import { FRESH_START_REASON } from './fresh-start.types.js';
import type {
  FreshStartCutoff,
  FreshStartRun,
} from './fresh-start.types.js';

interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface Client extends Queryable {
  release(): void;
}

interface Database {
  connect(): Promise<Client>;
}

interface RunRow {
  run_id: string;
  cutoff_block_number: string;
  cutoff_block_hash: string;
  cutoff_parent_hash: string;
  quarantined_sessions: number;
  quarantined_decisions: number;
  applied_at: Date | string;
}

const ACTIVE_STATUSES = [
  'WAITING_FIRST_BUY',
  'RISK_CHECKING',
  'BUY_PENDING',
  'HOLDING',
  'SELL_PENDING',
  'MANUAL_REVIEW',
] as const;

function mapRun(row: RunRow | undefined): FreshStartRun {
  if (row === undefined) {
    throw new Error('Audit fresh-start absent après insertion.');
  }

  let number: bigint;
  try {
    number = BigInt(row.cutoff_block_number);
  } catch {
    throw new Error('Audit fresh-start invalide.');
  }
  const appliedAtMs = new Date(row.applied_at).getTime();
  if (
    number < 0n
    || !isHash(row.cutoff_block_hash)
    || !isHash(row.cutoff_parent_hash)
    || !Number.isInteger(row.quarantined_sessions)
    || row.quarantined_sessions < 0
    || !Number.isInteger(row.quarantined_decisions)
    || row.quarantined_decisions < 0
    || !Number.isFinite(appliedAtMs)
  ) {
    throw new Error('Audit fresh-start invalide.');
  }

  return {
    id: row.run_id,
    cutoff: {
      number,
      hash: row.cutoff_block_hash,
      parentHash: row.cutoff_parent_hash,
    },
    appliedAtMs,
    quarantinedSessions: row.quarantined_sessions,
    quarantinedDecisions: row.quarantined_decisions,
  };
}

export class FreshStartRepository {
  constructor(
    private readonly database: Database = pool as unknown as Database,
  ) {}

  async apply(
    cutoff: FreshStartCutoff,
    nowMs: number,
  ): Promise<FreshStartRun> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('fresh-start-cutoff'))`,
      );
      const latest = await client.query<RunRow>(
        `SELECT * FROM fresh_start_runs
         ORDER BY applied_at DESC, run_id DESC
         LIMIT 1 FOR UPDATE`,
      );
      const previous = latest.rows[0];
      if (
        previous
        && (
          cutoff.number < BigInt(previous.cutoff_block_number)
          || (
            cutoff.number === BigInt(previous.cutoff_block_number)
            && cutoff.hash.toLowerCase()
              !== previous.cutoff_block_hash.toLowerCase()
          )
        )
      ) {
        throw new Error('Cutoff fresh-start antérieur ou divergent.');
      }

      const reason = `${FRESH_START_REASON}: bloc confirmé ${cutoff.number}.`;
      const sessions = await client.query<{ pair_address: string }>(
        `UPDATE token_sessions SET
           status = 'MANUAL_REVIEW',
           payload = jsonb_set(
             jsonb_set(
               jsonb_set(payload, '{status}', '"MANUAL_REVIEW"'::jsonb),
               '{rejectionReason}', to_jsonb($2::text), TRUE
             ),
             '{updatedAtMs}', to_jsonb($3::bigint), TRUE
           ),
           recovery_owner = NULL,
           recovery_lease_until = NULL,
           recovery_error = $2,
           updated_at = to_timestamp($3 / 1000.0)
         WHERE status = ANY($1::text[])
         RETURNING pair_address`,
        [[...ACTIVE_STATUSES], reason, nowMs],
      );
      const decisions = await client.query<{ decision_id: string }>(
        `UPDATE position_exit_decisions SET
           status = 'MANUAL_REVIEW',
           error_type = $1,
           updated_at = to_timestamp($2 / 1000.0)
         WHERE status IN ('PENDING', 'EXECUTING')
         RETURNING decision_id`,
        [FRESH_START_REASON, nowMs],
      );
      await client.query(
        `UPDATE listener_checkpoints SET
           block_number = $1,
           block_hash = $2,
           updated_at = to_timestamp($3 / 1000.0)`,
        [cutoff.number.toString(), cutoff.hash.toLowerCase(), nowMs],
      );
      await client.query(
        `INSERT INTO listener_checkpoints(
           listener_key, block_number, block_hash, updated_at
         ) VALUES ('pair-created', $1, $2, to_timestamp($3 / 1000.0))
         ON CONFLICT (listener_key) DO UPDATE SET
           block_number = EXCLUDED.block_number,
           block_hash = EXCLUDED.block_hash,
           updated_at = EXCLUDED.updated_at`,
        [cutoff.number.toString(), cutoff.hash.toLowerCase(), nowMs],
      );
      await client.query('DELETE FROM canonical_blocks');
      await client.query(
        `INSERT INTO canonical_blocks(
           block_number, block_hash, parent_hash, observed_at
         ) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))`,
        [
          cutoff.number.toString(),
          cutoff.hash.toLowerCase(),
          cutoff.parentHash.toLowerCase(),
          nowMs,
        ],
      );
      const inserted = await client.query<RunRow>(
        `INSERT INTO fresh_start_runs(
           run_id, cutoff_block_number, cutoff_block_hash,
           cutoff_parent_hash, quarantined_sessions,
           quarantined_decisions, applied_at
         ) VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))
         RETURNING *`,
        [
          randomUUID(),
          cutoff.number.toString(),
          cutoff.hash.toLowerCase(),
          cutoff.parentHash.toLowerCase(),
          sessions.rows.length,
          decisions.rows.length,
          nowMs,
        ],
      );
      const run = mapRun(inserted.rows[0]);
      await client.query('COMMIT');
      return run;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
