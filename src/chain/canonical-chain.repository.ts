import { isHash, type Address, type Hash } from 'viem';
import type {
  CanonicalBlock,
  ChainReorgStatus,
  ChainReorgAudit,
  DeepReorgReason,
  ReorgAuditMutation,
  ReorgManualReviewReason,
  ReorgReconciliation,
  ReorgRollbackImpact,
  ReorgRollbackPairImpact,
} from './canonical-chain.types.js';
import { pool } from '../storage/database.js';
import type { TokenSession } from '../types/domain.js';
import { parseJson, stringifyJson } from '../utils/json.js';

interface CanonicalChainDatabase {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  connect?(): Promise<CanonicalChainDatabaseClient>;
}

interface CanonicalChainDatabaseClient extends CanonicalChainDatabase {
  release(): void;
}

interface CanonicalBlockRow {
  block_number: string;
  block_hash: string;
  parent_hash: string;
}

interface ChainReorgRow {
  reorg_id: string;
  detected_at_ms: string;
  common_ancestor_number: string | null;
  common_ancestor_hash: string | null;
  previous_tip_number: string;
  previous_tip_hash: string;
  replacement_tip_number: string;
  replacement_tip_hash: string;
  status: ChainReorgStatus;
  depth: string | null;
  orphaned_events: string;
  replayed_events: string;
  details: Record<string, unknown>;
}

interface ReorgAuditUpsertRow {
  status: ChainReorgStatus;
  details: unknown;
}

interface ReorgAuditStatusRow {
  status: ChainReorgStatus;
}

interface DiscoveryImpactRow {
  pair_address: string | null;
}

interface SwapImpactRow {
  event_id: string;
  pair_address: string;
  block_number: string;
  transaction_index: number;
  log_index: number;
  session_before: unknown | null;
}

interface TradeImpactRow {
  trade_id: string;
  pair_address: string;
  has_transaction: boolean;
}

interface CanonicalSessionRow {
  pair_address: string;
  session_after: unknown;
}

const DEEP_REORG_REASONS = new Set<DeepReorgReason>([
  'NO_COMMON_ANCESTOR_WITHIN_RETENTION',
]);

const MANUAL_REVIEW_REASONS = new Set<ReorgManualReviewReason>([
  'WALLET_CONSEQUENCE_REQUIRES_REVIEW',
  'SESSION_RECONCILIATION_FAILED',
  'REPLAY_FAILED',
]);

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

function reorgId(reorg: ReorgReconciliation): string {
  return `reorg:${reorg.oldTip.hash.toLowerCase()}:${reorg.newTip.hash.toLowerCase()}`;
}

function objectDetails(value: unknown): Record<string, unknown> {
  return parseJson<Record<string, unknown>>(value ?? {});
}

function savedRollbackImpact(details: unknown): ReorgRollbackImpact | null {
  const value = objectDetails(details).rollbackImpact;
  if (typeof value !== 'object' || value === null) return null;
  return parseJson<ReorgRollbackImpact>(value);
}

function compareSwapRows(left: SwapImpactRow, right: SwapImpactRow): number {
  const blockOrder = BigInt(left.block_number) < BigInt(right.block_number)
    ? -1
    : BigInt(left.block_number) > BigInt(right.block_number)
      ? 1
      : 0;
  return blockOrder
    || left.transaction_index - right.transaction_index
    || left.log_index - right.log_index
    || left.event_id.localeCompare(right.event_id);
}

function isValidCanonicalBlock(value: unknown): value is CanonicalBlock {
  if (typeof value !== 'object' || value === null) return false;
  const block = value as Record<string, unknown>;
  return (
    typeof block.number === 'bigint'
    && block.number >= 0n
    && typeof block.hash === 'string'
    && isHash(block.hash)
    && typeof block.parentHash === 'string'
    && isHash(block.parentHash)
  );
}

function validateShallowReorg(
  reorg: ReorgReconciliation,
): asserts reorg is ReorgReconciliation & {
  ancestor: CanonicalBlock;
  depth: number;
} {
  if (
    typeof reorg !== 'object'
    || reorg === null
    || !isValidCanonicalBlock(reorg.ancestor)
    || !isValidCanonicalBlock(reorg.oldTip)
    || !isValidCanonicalBlock(reorg.newTip)
    || reorg.depth === null
    || !Number.isSafeInteger(reorg.depth)
    || reorg.depth < 1
    || reorg.depth > 128
    || reorg.ancestor.number >= reorg.oldTip.number
    || BigInt(reorg.depth) !== reorg.oldTip.number - reorg.ancestor.number
    || reorg.newTip.number < reorg.oldTip.number
  ) {
    throw new Error(
      'Un rollback automatique exige des blocs valides et une profondeur cohérente entre 1 et 128.',
    );
  }
}

function validateDeepReorg(
  reorg: ReorgReconciliation,
  reason: DeepReorgReason,
): void {
  if (
    reorg.ancestor !== null
    || reorg.depth !== null
    || !DEEP_REORG_REASONS.has(reason)
  ) {
    throw new Error('Un audit de reorg profond exige un motif contrôlé et aucun ancêtre.');
  }
}

function validateManualReason(reason: ReorgManualReviewReason): void {
  if (!MANUAL_REVIEW_REASONS.has(reason)) {
    throw new Error('Motif de revue manuelle non autorisé.');
  }
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
         status,
         depth::text,
         orphaned_events::text,
         replayed_events::text,
         details
       FROM chain_reorgs
       ORDER BY detected_at DESC LIMIT 1`,
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.reorg_id,
      detectedAtMs: Number(row.detected_at_ms),
      commonAncestor:
        row.common_ancestor_number === null || row.common_ancestor_hash === null
          ? null
          : {
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
      status: row.status,
      impact: {
        depth: row.depth === null ? null : Number(row.depth),
        orphanedEvents: Number(row.orphaned_events),
        replayedEvents: Number(row.replayed_events),
      },
      details: row.details,
    };
  }

  async rewindToAncestor(
    reorg: ReorgReconciliation,
  ): Promise<ReorgRollbackImpact> {
    validateShallowReorg(reorg);
    return this.withTransaction(async (client) => {
      const id = reorgId(reorg);
      const audit = await this.upsertAudit(
        client,
        reorg,
        'RECONCILING',
        {},
      );
      const previousImpact = savedRollbackImpact(audit.details);
      if (previousImpact) return previousImpact;

      const ancestorNumber = reorg.ancestor.number.toString();
      const discoveryResult = await client.query<DiscoveryImpactRow>(
        `SELECT pair_address
         FROM discovered_tokens
         WHERE canonical = TRUE AND deployment_block > $1
         ORDER BY pair_address
         FOR UPDATE`,
        [ancestorNumber],
      );
      const swapResult = await client.query<SwapImpactRow>(
        `SELECT
           event_id, pair_address, block_number::text,
           transaction_index, log_index, session_before
         FROM swap_events
         WHERE canonical = TRUE AND block_number > $1
         ORDER BY block_number, transaction_index, log_index, event_id
         FOR UPDATE`,
        [ancestorNumber],
      );
      const swaps = [...swapResult.rows].sort(compareSwapRows);
      const orphanedEventIds = swaps.map(({ event_id }) => event_id);
      const tradeResult = await client.query<TradeImpactRow>(
        `SELECT
           t.trade_id,
           t.pair_address,
           EXISTS (
             SELECT 1 FROM trade_transactions tx
             WHERE tx.trade_id = t.trade_id
           ) AS has_transaction
         FROM trades t
         WHERE t.canonical = TRUE
           AND t.source_event_id = ANY($1::text[])
         ORDER BY t.pair_address, t.trade_id
         FOR UPDATE OF t`,
        [orphanedEventIds],
      );

      const pairAddresses = [
        ...new Set([
          ...discoveryResult.rows.flatMap(({ pair_address }) =>
            pair_address === null ? [] : [pair_address.toLowerCase()]
          ),
          ...swaps.map(({ pair_address }) => pair_address.toLowerCase()),
          ...tradeResult.rows.map(({ pair_address }) =>
            pair_address.toLowerCase()
          ),
        ]),
      ].sort();
      const canonicalSessions = pairAddresses.length === 0
        ? { rows: [] as CanonicalSessionRow[] }
        : await client.query<CanonicalSessionRow>(
          `SELECT DISTINCT ON (pair_address) pair_address, session_after
           FROM swap_events
           WHERE canonical = TRUE
             AND block_number <= $1
             AND pair_address = ANY($2::text[])
             AND session_after IS NOT NULL
           ORDER BY
             pair_address, block_number DESC,
             transaction_index DESC, log_index DESC, event_id DESC`,
          [ancestorNumber, pairAddresses],
        );

      const discoveries = new Set(
        discoveryResult.rows.flatMap(({ pair_address }) =>
          pair_address === null ? [] : [pair_address.toLowerCase()]
        ),
      );
      const earliestSessions = new Map<string, TokenSession | null>();
      for (const row of swaps) {
        const pairAddress = row.pair_address.toLowerCase();
        if (!earliestSessions.has(pairAddress)) {
          earliestSessions.set(
            pairAddress,
            row.session_before === null
              ? null
              : parseJson<TokenSession>(row.session_before),
          );
        }
      }
      const latestCanonicalSessions = new Map(
        canonicalSessions.rows.map((row) => [
          row.pair_address.toLowerCase(),
          parseJson<TokenSession>(row.session_after),
        ]),
      );
      const walletPairs = new Set(
        tradeResult.rows.flatMap((row) =>
          row.has_transaction ? [row.pair_address.toLowerCase()] : []
        ),
      );
      const affectedPairs: ReorgRollbackPairImpact[] = pairAddresses.map(
        (pairAddress) => ({
          pairAddress: pairAddress as Address,
          discoveryOrphaned: discoveries.has(pairAddress),
          earliestSessionBefore: earliestSessions.get(pairAddress) ?? null,
          latestCanonicalSessionAfter:
            latestCanonicalSessions.get(pairAddress) ?? null,
          hasWalletConsequence: walletPairs.has(pairAddress),
        }),
      );

      await client.query(
        `UPDATE discovered_tokens
         SET canonical = FALSE, updated_at = NOW()
         WHERE canonical = TRUE AND deployment_block > $1`,
        [ancestorNumber],
      );
      await client.query(
        `UPDATE swap_events
         SET canonical = FALSE, orphaned_at = NOW(), updated_at = NOW()
         WHERE canonical = TRUE AND block_number > $1`,
        [ancestorNumber],
      );
      await client.query(
        `UPDATE token_risk_reports
         SET canonical = FALSE
         WHERE canonical = TRUE
           AND source_event_id = ANY($1::text[])`,
        [orphanedEventIds],
      );
      await client.query(
        `UPDATE trades t
         SET canonical = FALSE, updated_at = NOW()
         WHERE t.canonical = TRUE
           AND t.source_event_id = ANY($1::text[])
           AND NOT EXISTS (
             SELECT 1 FROM trade_transactions tx
             WHERE tx.trade_id = t.trade_id
           )`,
        [orphanedEventIds],
      );
      await client.query(
        `UPDATE listener_checkpoints
         SET block_number = $1, block_hash = $2, updated_at = NOW()
         WHERE block_number > $1`,
        [ancestorNumber, reorg.ancestor.hash.toLowerCase()],
      );
      await client.query(
        'DELETE FROM canonical_blocks WHERE block_number > $1',
        [ancestorNumber],
      );

      const impact: ReorgRollbackImpact = {
        reorgId: id,
        depth: reorg.depth,
        orphanedEvents: orphanedEventIds.length,
        replayedEvents: 0,
        orphanedEventIds,
        affectedPairs,
      };
      await client.query(
        `UPDATE chain_reorgs
         SET orphaned_events = $2,
             details = details || jsonb_build_object('rollbackImpact', $3::jsonb)
         WHERE reorg_id = $1`,
        [id, orphanedEventIds.length, stringifyJson(impact)],
      );
      return impact;
    });
  }

  async recordDeepReorg(
    reorg: ReorgReconciliation,
    reason: DeepReorgReason,
  ): Promise<ReorgAuditMutation> {
    validateDeepReorg(reorg, reason);
    return this.withTransaction(async (client) => {
      const result = await this.upsertAudit(
        client,
        reorg,
        'MANUAL_REVIEW',
        { reason },
      );
      return { reorgId: reorgId(reorg), status: result.status };
    });
  }

  async completeReorg(reorgIdValue: string, replayedEvents: number): Promise<void> {
    if (!Number.isSafeInteger(replayedEvents) || replayedEvents < 0) {
      throw new Error('Le nombre d’événements rejoués doit être un entier positif.');
    }
    await this.withTransaction(async (client) => {
      const result = await client.query<ReorgAuditStatusRow>(
        `WITH existing AS (
           SELECT reorg_id, status
           FROM chain_reorgs
           WHERE reorg_id = $1
           FOR UPDATE
         ),
         updated AS (
           UPDATE chain_reorgs AS audit
           SET status = 'RECOVERED', replayed_events = $2
           FROM existing
           WHERE audit.reorg_id = existing.reorg_id
             AND existing.status = 'RECONCILING'
           RETURNING audit.status AS status
         )
         SELECT status FROM updated
         UNION ALL
         SELECT status FROM existing
         WHERE status <> 'RECONCILING'
         LIMIT 1`,
        [reorgIdValue, replayedEvents],
      );
      if (!result.rows[0]) {
        throw new Error('Audit de reorg introuvable.');
      }
    });
  }

  async requireManualReview(
    reorgIdValue: string,
    reason: ReorgManualReviewReason,
  ): Promise<void> {
    validateManualReason(reason);
    await this.withTransaction(async (client) => {
      const result = await client.query<ReorgAuditStatusRow>(
        `WITH existing AS (
           SELECT reorg_id, status
           FROM chain_reorgs
           WHERE reorg_id = $1
           FOR UPDATE
         ),
         updated AS (
           UPDATE chain_reorgs AS audit
           SET status = 'MANUAL_REVIEW',
               details = details || $2::jsonb
           FROM existing
           WHERE audit.reorg_id = existing.reorg_id
             AND existing.status = 'RECONCILING'
           RETURNING audit.status AS status
         )
         SELECT status FROM updated
         UNION ALL
         SELECT status FROM existing
         WHERE status <> 'RECONCILING'
         LIMIT 1`,
        [reorgIdValue, stringifyJson({ reason })],
      );
      if (!result.rows[0]) {
        throw new Error('Audit de reorg introuvable.');
      }
    });
  }

  private async upsertAudit(
    client: CanonicalChainDatabase,
    reorg: ReorgReconciliation,
    status: ChainReorgStatus,
    details: Record<string, unknown>,
  ): Promise<ReorgAuditUpsertRow> {
    const result = await client.query<ReorgAuditUpsertRow>(
      `INSERT INTO chain_reorgs(
         reorg_id,
         common_ancestor_number,
         common_ancestor_hash,
         previous_tip_number,
         previous_tip_hash,
         replacement_tip_number,
         replacement_tip_hash,
         status,
         depth,
         orphaned_events,
         replayed_events,
         details
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       ON CONFLICT (reorg_id) DO UPDATE SET
         status = CASE
           WHEN chain_reorgs.status IN ('RECOVERED', 'MANUAL_REVIEW')
             THEN chain_reorgs.status
           ELSE EXCLUDED.status
         END,
         details = CASE
           WHEN chain_reorgs.status IN ('RECOVERED', 'MANUAL_REVIEW')
             THEN chain_reorgs.details
           ELSE chain_reorgs.details || EXCLUDED.details
         END
       RETURNING status, details`,
      [
        reorgId(reorg),
        reorg.ancestor?.number.toString() ?? null,
        reorg.ancestor?.hash.toLowerCase() ?? null,
        reorg.oldTip.number.toString(),
        reorg.oldTip.hash.toLowerCase(),
        reorg.newTip.number.toString(),
        reorg.newTip.hash.toLowerCase(),
        status,
        reorg.depth,
        0,
        0,
        stringifyJson(details),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('L’audit de reorg n’a pas été persisté.');
    return row;
  }

  private async withTransaction<T>(
    action: (client: CanonicalChainDatabaseClient) => Promise<T>,
  ): Promise<T> {
    if (!this.database.connect) {
      throw new Error('Le rollback canonique exige un client transactionnel.');
    }
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const result = await action(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
