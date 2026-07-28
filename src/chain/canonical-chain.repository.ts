import { isHash, type Hash } from 'viem';
import type {
  CanonicalBlock,
  CanonicalChainState,
  ChainReorgAudit,
} from './canonical-chain.types.js';
import { pool } from '../storage/database.js';

interface CanonicalChainDatabase {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface CanonicalBlockRow {
  block_number: string;
  block_hash: string;
  parent_hash: string;
}

interface ChainReorgRow {
  reorg_id: string;
  detected_at_ms: string;
  common_ancestor_number: string;
  common_ancestor_hash: string;
  previous_tip_number: string;
  previous_tip_hash: string;
  replacement_tip_number: string;
  replacement_tip_hash: string;
  state: CanonicalChainState;
  orphaned_block_count: string;
  orphaned_event_count: string;
  affected_session_count: string;
}

function hash(value: string): Hash {
  if (!isHash(value)) {
    throw new Error(`Hash blockchain invalide en base: ${value}`);
  }
  return value;
}

function canonicalBlock(row: CanonicalBlockRow): CanonicalBlock {
  return {
    number: BigInt(row.block_number),
    hash: hash(row.block_hash),
    parentHash: hash(row.parent_hash),
  };
}

export class CanonicalChainRepository {
  constructor(
    private readonly database: CanonicalChainDatabase =
      pool as unknown as CanonicalChainDatabase,
  ) {}

  async getCanonicalTip(): Promise<CanonicalBlock | null> {
    const result = await this.database.query<CanonicalBlockRow>(
      `SELECT block_number::text, block_hash, parent_hash
       FROM canonical_blocks
       ORDER BY block_number DESC LIMIT 1`,
    );
    const row = result.rows[0];
    return row ? canonicalBlock(row) : null;
  }

  async listCanonicalDescending(limit: number): Promise<CanonicalBlock[]> {
    const result = await this.database.query<CanonicalBlockRow>(
      `SELECT block_number::text, block_hash, parent_hash
       FROM canonical_blocks
       ORDER BY block_number DESC LIMIT $1`,
      [limit],
    );
    return result.rows.map(canonicalBlock);
  }

  async saveCanonicalBlocks(blocks: CanonicalBlock[]): Promise<void> {
    if (blocks.length === 0) return;
    const values: unknown[] = [];
    const placeholders = blocks.map((block, index) => {
      const offset = index * 3;
      values.push(
        block.number.toString(),
        block.hash.toLowerCase(),
        block.parentHash.toLowerCase(),
      );
      return `($${offset + 1}, $${offset + 2}, $${offset + 3})`;
    });
    await this.database.query(
      `INSERT INTO canonical_blocks(block_number, block_hash, parent_hash)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (block_number) DO UPDATE SET
         block_hash = EXCLUDED.block_hash,
         parent_hash = EXCLUDED.parent_hash,
         observed_at = NOW()`,
      values,
    );
  }

  async pruneCanonicalBefore(blockNumber: bigint): Promise<void> {
    await this.database.query(
      'DELETE FROM canonical_blocks WHERE block_number < $1',
      [blockNumber.toString()],
    );
  }

  async getLastReorg(): Promise<ChainReorgAudit | null> {
    const result = await this.database.query<ChainReorgRow>(
      `SELECT
         reorg_id,
         (EXTRACT(EPOCH FROM detected_at) * 1000)::bigint::text AS detected_at_ms,
         common_ancestor_number::text,
         common_ancestor_hash,
         previous_tip_number::text,
         previous_tip_hash,
         replacement_tip_number::text,
         replacement_tip_hash,
         state,
         orphaned_block_count::text,
         orphaned_event_count::text,
         affected_session_count::text
       FROM chain_reorgs
       ORDER BY detected_at DESC LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.reorg_id,
      detectedAtMs: Number(row.detected_at_ms),
      commonAncestor: {
        number: BigInt(row.common_ancestor_number),
        hash: hash(row.common_ancestor_hash),
      },
      previousTip: {
        number: BigInt(row.previous_tip_number),
        hash: hash(row.previous_tip_hash),
      },
      replacementTip: {
        number: BigInt(row.replacement_tip_number),
        hash: hash(row.replacement_tip_hash),
      },
      state: row.state,
      impact: {
        orphanedBlockCount: Number(row.orphaned_block_count),
        orphanedEventCount: Number(row.orphaned_event_count),
        affectedSessionCount: Number(row.affected_session_count),
      },
    };
  }
}
