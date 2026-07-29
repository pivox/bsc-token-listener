import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import { CanonicalChainRepository } from '../src/chain/canonical-chain.repository.js';
import type {
  CanonicalBlock,
  ChainReorgStatus,
  ReorgReconciliation,
  ReorgRollbackImpact,
} from '../src/chain/canonical-chain.types.js';
import { CheckpointRepository } from '../src/storage/repositories.js';
import { stringifyJson } from '../src/utils/json.js';
import type { TokenSession } from '../src/types/domain.js';

const HASH_10 = `0x${'1'.repeat(64)}` as Hash;
const HASH_11 = `0x${'2'.repeat(64)}` as Hash;
const HASH_12 = `0x${'3'.repeat(64)}` as Hash;
const HASH_13 = `0x${'4'.repeat(64)}` as Hash;
const PAIR_A = `0x${'a'.repeat(40)}` as Address;
const PAIR_B = `0x${'b'.repeat(40)}` as Address;

function validSession(pair: Address, updatedAtMs: number): TokenSession {
  const token = `0x${'5'.repeat(40)}` as Address;
  const wbnb = `0x${'6'.repeat(40)}` as Address;
  return {
    pair: {
      factory: `0x${'1'.repeat(40)}`,
      router: `0x${'2'.repeat(40)}`,
      wbnb,
      pair,
      token,
      token0: token,
      token1: wbnb,
      createdBlock: 10n,
      blockHash: HASH_10,
      createdTransactionHash: HASH_11,
      createdLogIndex: 0,
      discoveredAtMs: 1,
    },
    metadata: {
      address: token,
      name: 'Token',
      symbol: 'TKN',
      decimals: 18,
      totalSupply: 1_000n,
      codeSizeBytes: 1,
    },
    status: 'WAITING_FIRST_BUY',
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs,
  };
}

const SHALLOW_REORG: ReorgReconciliation = {
  ancestor: { number: 10n, hash: HASH_10, parentHash: HASH_10 },
  oldTip: { number: 12n, hash: HASH_12, parentHash: HASH_11 },
  newTip: { number: 13n, hash: HASH_13, parentHash: HASH_12 },
  depth: 2,
};

interface ReorgFixtureState {
  auditCount: number;
  auditStatus: ChainReorgStatus | null;
  replayedEvents: number;
  rollbackImpact: unknown | null;
  details: Record<string, unknown>;
  committed: boolean;
  released: boolean;
  mutations: string[];
}

class StatefulReorgDatabase {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  connectCalls = 0;
  readonly state: ReorgFixtureState = {
    auditCount: 0,
    auditStatus: null,
    replayedEvents: 0,
    rollbackImpact: null,
    details: {},
    committed: false,
    released: false,
    mutations: [],
  };
  failOn: string | null = null;
  canonicalProcessedCount = 0;
  sessionBeforeOverride: unknown | undefined;
  discoveryPairOverride: string | undefined;
  walletSwapPairOverride: string | undefined;
  tradePairOverride: string | undefined;
  private pending: ReorgFixtureState | null = null;

  async connect(): Promise<this> {
    this.connectCalls += 1;
    return this;
  }

  release(): void {
    this.state.released = true;
  }

  async query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ sql, ...(values ? { values } : {}) });
    const normalized = sql.replace(/\s+/gu, ' ').trim();
    if (this.failOn && normalized.includes(this.failOn)) {
      throw new Error(`failure:${this.failOn}`);
    }
    if (normalized === 'BEGIN') {
      this.pending = structuredClone(this.state);
      return { rows: [] };
    }
    if (normalized === 'ROLLBACK') {
      this.pending = null;
      return { rows: [] };
    }
    if (normalized === 'COMMIT') {
      assert.ok(this.pending);
      Object.assign(this.state, this.pending, { committed: true });
      this.pending = null;
      return { rows: [] };
    }
    const staged = this.pending ?? this.state;
    if (
      normalized.includes('SELECT COUNT(*)::text AS replayed_events')
      && normalized.includes('FROM swap_events')
    ) {
      return { rows: [{ replayed_events: String(this.canonicalProcessedCount) }] as T[] };
    }
    if (normalized.includes('INSERT INTO chain_reorgs')) {
      if (staged.auditCount === 0) {
        staged.auditCount = 1;
        staged.auditStatus = String(values?.[7]) as ChainReorgStatus;
        staged.details = JSON.parse(String(values?.[11]));
      } else {
        const previousStatus = staged.auditStatus;
        const preservesTerminal = previousStatus === 'RECOVERED'
          || (
            previousStatus === 'MANUAL_REVIEW'
            && normalized.includes("IN ('RECOVERED', 'MANUAL_REVIEW')")
          );
        staged.auditStatus = preservesTerminal
          ? previousStatus
          : String(values?.[7]) as ChainReorgStatus;
        if (!preservesTerminal) {
          Object.assign(staged.details, JSON.parse(String(values?.[11])));
        }
      }
      staged.mutations.push('audit');
      return {
        rows: [{
          status: staged.auditStatus,
          orphaned_events: String(
            (staged.rollbackImpact as { orphanedEvents?: number } | null)
              ?.orphanedEvents ?? 0,
          ),
          replayed_events: String(staged.replayedEvents),
          details: staged.rollbackImpact === null
            ? staged.details
            : { ...staged.details, rollbackImpact: staged.rollbackImpact },
        }] as T[],
      };
    }
    if (normalized.includes('FROM discovered_tokens') && normalized.includes('FOR UPDATE')) {
      return {
        rows: [
          { pair_address: PAIR_B },
          { pair_address: this.discoveryPairOverride ?? PAIR_A },
        ] as T[],
      };
    }
    if (normalized.includes('FROM swap_events') && normalized.includes('FOR UPDATE')) {
      return {
        rows: [
          {
            event_id: 'event-late',
            pair_address: PAIR_A,
            block_number: '12',
            transaction_index: 1,
            log_index: 0,
            session_before: stringifyJson(validSession(PAIR_A, 2)),
          },
          {
            event_id: 'event-early',
            pair_address: PAIR_A,
            block_number: '11',
            transaction_index: 0,
            log_index: 2,
            session_before: this.sessionBeforeOverride === undefined
              ? stringifyJson(validSession(PAIR_A, 1))
              : stringifyJson(this.sessionBeforeOverride),
          },
          {
            event_id: 'event-wallet',
            pair_address: this.walletSwapPairOverride ?? PAIR_B,
            block_number: '11',
            transaction_index: 1,
            log_index: 1,
            session_before: null,
          },
        ] as T[],
      };
    }
    if (normalized.includes('FROM trades') && normalized.includes('FOR UPDATE')) {
      return {
        rows: [
          {
            trade_id: 'dry-trade',
            pair_address: this.tradePairOverride ?? PAIR_A,
            has_transaction: false,
          },
          { trade_id: 'wallet-trade', pair_address: PAIR_B, has_transaction: true },
        ] as T[],
      };
    }
    if (
      normalized.includes('FROM swap_events')
      && normalized.includes('DISTINCT ON')
    ) {
      return {
        rows: [{
          pair_address: PAIR_B,
          session_after: stringifyJson(validSession(PAIR_B, 3)),
        }] as T[],
      };
    }
    if (normalized.includes('UPDATE chain_reorgs') && normalized.includes('rollbackImpact')) {
      staged.rollbackImpact = JSON.parse(String(values?.[2]));
      staged.mutations.push('impact');
      return { rows: [] };
    }
    if (
      normalized.includes('UPDATE chain_reorgs')
      && normalized.includes("SET status = 'RECOVERED'")
    ) {
      if (
        !normalized.includes("status = 'RECONCILING'")
        || staged.auditStatus === 'RECONCILING'
      ) {
        staged.auditStatus = 'RECOVERED';
        staged.replayedEvents = Number(values?.[1]);
      }
      staged.mutations.push('complete');
      return {
        rows: normalized.includes('SELECT status') && staged.auditCount > 0
          ? [{ status: staged.auditStatus }] as T[]
          : [],
      };
    }
    if (
      normalized.includes('UPDATE chain_reorgs')
      && normalized.includes("'MANUAL_REVIEW'")
    ) {
      if (
        (
          !normalized.includes("status = 'RECONCILING'")
          && staged.auditStatus !== 'RECOVERED'
        )
        || staged.auditStatus === 'RECONCILING'
      ) {
        staged.auditStatus = 'MANUAL_REVIEW';
        Object.assign(staged.details, JSON.parse(String(values?.[1])));
      }
      staged.mutations.push('manual');
      return {
        rows: normalized.includes('SELECT status') && staged.auditCount > 0
          ? [{ status: staged.auditStatus }] as T[]
          : [],
      };
    }
    if (
      normalized.startsWith('UPDATE')
      || normalized.startsWith('DELETE')
    ) {
      staged.mutations.push(
        normalized.match(/^(?:UPDATE|DELETE FROM) ([a-z_]+)/u)?.[1] ?? normalized,
      );
      return { rows: [] };
    }
    return { rows: [] };
  }
}

test('migration reorg reste idempotente et conserve les colonnes legacy nullables', async () => {
  const migration = await readFile(
    new URL('../migrations/007_chain_reorg_safety.sql', import.meta.url),
    'utf8',
  );

  assert.match(migration, /CREATE TABLE IF NOT EXISTS canonical_blocks/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS chain_reorgs/u);
  assert.match(migration, /common_ancestor_number NUMERIC\(78, 0\),/u);
  assert.match(migration, /common_ancestor_hash TEXT,/u);
  assert.match(
    migration,
    /status TEXT NOT NULL CHECK \(status IN \('RECONCILING', 'RECOVERED', 'MANUAL_REVIEW'\)\)/u,
  );
  assert.match(migration, /depth INTEGER,/u);
  assert.match(migration, /orphaned_events INTEGER NOT NULL DEFAULT 0/u);
  assert.match(migration, /replayed_events INTEGER NOT NULL DEFAULT 0/u);
  assert.match(migration, /details JSONB NOT NULL DEFAULT '\{\}'::jsonb/u);
  assert.match(
    migration,
    /ALTER TABLE listener_checkpoints\s+ADD COLUMN IF NOT EXISTS block_hash TEXT;/u,
  );
  assert.doesNotMatch(
    migration,
    /ALTER TABLE listener_checkpoints\s+ADD COLUMN IF NOT EXISTS block_hash TEXT NOT NULL/u,
  );
  for (const table of [
    'swap_events',
    'discovered_tokens',
    'token_risk_reports',
    'trades',
    'token_sessions',
  ]) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table}`, 'u'));
  }
  assert.match(
    migration,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_swap_events_transaction_log\s+ON swap_events\(transaction_hash, log_index\)/u,
  );
  assert.equal(
    [...migration.matchAll(/CREATE (?:UNIQUE )?INDEX (?!IF NOT EXISTS)/gu)].length,
    0,
  );
  assert.equal(
    [...migration.matchAll(/ADD COLUMN (?!IF NOT EXISTS)/gu)].length,
    0,
  );
});

class RecordingDatabase {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  rows: unknown[] = [];

  async query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ sql, ...(values ? { values } : {}) });
    return { rows: this.rows as T[] };
  }
}

test('charge un checkpoint avec son hash sans convertir le bigint en number', async () => {
  const database = new RecordingDatabase();
  database.rows = [{ block_number: '9007199254740993', block_hash: HASH_12 }];
  const repository = new CheckpointRepository(database);

  const checkpoint = await repository.get('pair-created');

  assert.deepEqual(checkpoint, {
    blockNumber: 9_007_199_254_740_993n,
    blockHash: HASH_12,
  });
  assert.deepEqual(database.calls[0]?.values, ['pair-created']);
  assert.match(database.calls[0]?.sql ?? '', /block_hash/u);
});

test('distingue une ligne legacy sans hash d’un checkpoint absent', async () => {
  const database = new RecordingDatabase();
  database.rows = [{ block_number: '42', block_hash: null }];
  const repository = new CheckpointRepository(database);

  assert.deepEqual(await repository.get('pair-created'), {
    blockNumber: 42n,
    blockHash: null,
  });

  database.rows = [];
  assert.equal(await repository.get('missing'), null);
});

test('refuse explicitement un block_hash non-null invalide', async () => {
  const database = new RecordingDatabase();
  database.rows = [{ block_number: '42', block_hash: 'not-a-hash' }];
  const repository = new CheckpointRepository(database);

  await assert.rejects(
    repository.get('pair-created'),
    /Hash de checkpoint invalide/u,
  );
});

test('upsert le numéro et le hash du checkpoint', async () => {
  const database = new RecordingDatabase();
  const repository = new CheckpointRepository(database);

  await repository.set('pair-created', {
    blockNumber: 12n,
    blockHash: HASH_12,
  });

  assert.deepEqual(database.calls[0]?.values, ['pair-created', '12', HASH_12]);
  assert.match(
    database.calls[0]?.sql ?? '',
    /INSERT INTO listener_checkpoints\(listener_key, block_number, block_hash\)/u,
  );
  assert.match(database.calls[0]?.sql ?? '', /block_hash = EXCLUDED\.block_hash/u);
});

test('supprime exactement le checkpoint terminal demandé', async () => {
  const database = new RecordingDatabase();
  const repository = new CheckpointRepository(database);
  const remove = (
    repository as unknown as { delete(key: string): Promise<void> }
  ).delete.bind(repository);

  await remove('swap:0xabc');

  assert.deepEqual(database.calls[0]?.values, ['swap:0xabc']);
  assert.match(
    database.calls[0]?.sql ?? '',
    /DELETE FROM listener_checkpoints WHERE listener_key = \$1/u,
  );
});

test('nettoie idempotemment uniquement les checkpoints Swap de sessions non monitorables', async () => {
  const database = new RecordingDatabase();
  database.rows = [
    { listener_key: 'swap:0xclosed' },
    { listener_key: 'swap:0xmanual' },
  ];
  const repository = new CheckpointRepository(database);
  const cleanup = (
    repository as unknown as {
      deleteNonMonitorableSwapCheckpoints(): Promise<number>;
    }
  ).deleteNonMonitorableSwapCheckpoints.bind(repository);

  assert.equal(await cleanup(), 2);
  const call = database.calls[0];
  assert.match(call?.sql ?? '', /DELETE FROM listener_checkpoints/u);
  assert.match(call?.sql ?? '', /USING token_sessions/u);
  assert.match(call?.sql ?? '', /listener_key = 'swap:' \|\| LOWER\(sessions\.pair_address\)/u);
  assert.match(
    call?.sql ?? '',
    /sessions\.status NOT IN \('WAITING_FIRST_BUY', 'HOLDING'\)/u,
  );
  assert.match(call?.sql ?? '', /RETURNING checkpoints\.listener_key/u);
});

test('charge le plus ancien numéro de checkpoint sans conversion en number', async () => {
  const database = new RecordingDatabase();
  database.rows = [{ block_number: '9007199254740993' }];
  const repository = new CheckpointRepository(database);

  assert.equal(
    await repository.getOldestBlockNumber(),
    9_007_199_254_740_993n,
  );
  assert.match(database.calls[0]?.sql ?? '', /MIN\(block_number\)/u);

  database.rows = [{ block_number: null }];
  assert.equal(await repository.getOldestBlockNumber(), null);
});

test('charge la tête canonique et les blocs descendants avec bigint et hash intacts', async () => {
  const database = new RecordingDatabase();
  const repository = new CanonicalChainRepository(database);
  database.rows = [{
    block_number: '9007199254740993',
    block_hash: HASH_12,
    parent_hash: HASH_11,
  }];

  const tip = await repository.getCanonicalTip();
  const descending = await repository.listCanonicalDescending(25);

  assert.deepEqual(tip, {
    number: 9_007_199_254_740_993n,
    hash: HASH_12,
    parentHash: HASH_11,
  });
  assert.deepEqual(descending, [tip]);
  assert.match(database.calls[0]?.sql ?? '', /ORDER BY block_number DESC LIMIT 1/u);
  assert.deepEqual(database.calls[1]?.values, [25]);
  assert.match(database.calls[1]?.sql ?? '', /ORDER BY block_number DESC LIMIT \$1/u);
});

test('sauvegarde les blocs canoniques par numéro avec toutes les provenances', async () => {
  const database = new RecordingDatabase();
  const repository = new CanonicalChainRepository(database);
  const blocks: CanonicalBlock[] = [
    { number: 11n, hash: HASH_11, parentHash: HASH_10 },
    { number: 12n, hash: HASH_12, parentHash: HASH_11 },
  ];

  await repository.saveCanonicalBlocks(blocks);

  assert.deepEqual(database.calls[0]?.values, [
    '11', HASH_11, HASH_10,
    '12', HASH_12, HASH_11,
  ]);
  assert.match(database.calls[0]?.sql ?? '', /INSERT INTO canonical_blocks/u);
  assert.match(database.calls[0]?.sql ?? '', /ON CONFLICT \(block_number\) DO UPDATE/u);
  assert.match(database.calls[0]?.sql ?? '', /parent_hash = EXCLUDED\.parent_hash/u);
});

test('élague uniquement avant la borne canonique demandée', async () => {
  const database = new RecordingDatabase();
  const repository = new CanonicalChainRepository(database);

  await repository.pruneCanonicalBefore(11n);

  assert.deepEqual(database.calls[0]?.values, ['11']);
  assert.match(
    database.calls[0]?.sql ?? '',
    /DELETE FROM canonical_blocks WHERE block_number < \$1/u,
  );
});

for (const status of [
  'RECONCILING',
  'RECOVERED',
  'MANUAL_REVIEW',
] as const) {
  test(`mappe un audit ${status} avec profondeur, compteurs et détails`, async () => {
    const database = new RecordingDatabase();
    database.rows = [{
      reorg_id: `reorg-${status}`,
      detected_at_ms: '1753700000000',
      common_ancestor_number: '10',
      common_ancestor_hash: HASH_10,
      previous_tip_number: '12',
      previous_tip_hash: HASH_12,
      replacement_tip_number: '11',
      replacement_tip_hash: HASH_11,
      status,
      depth: '2',
      orphaned_events: '3',
      replayed_events: '1',
      details: { affectedPairs: ['pair-1'] },
    }];
    const repository = new CanonicalChainRepository(database);

    const audit = await repository.getLastReorg();

    assert.deepEqual(audit, {
      id: `reorg-${status}`,
      detectedAtMs: 1_753_700_000_000,
      commonAncestor: { number: 10n, hash: HASH_10 },
      previousTip: { number: 12n, hash: HASH_12 },
      replacementTip: { number: 11n, hash: HASH_11 },
      status,
      impact: {
        depth: 2,
        orphanedEvents: 3,
        replayedEvents: 1,
      },
      details: { affectedPairs: ['pair-1'] },
    });
    assert.match(
      database.calls[0]?.sql ?? '',
      /ORDER BY detected_at DESC LIMIT 1/u,
    );
  });
}

test('mappe un audit encore sans ancêtre commun ni profondeur', async () => {
  const database = new RecordingDatabase();
  database.rows = [{
    reorg_id: 'reorg-pending',
    detected_at_ms: '1753700000000',
    common_ancestor_number: null,
    common_ancestor_hash: null,
    previous_tip_number: '12',
    previous_tip_hash: HASH_12,
    replacement_tip_number: '11',
    replacement_tip_hash: HASH_11,
    status: 'RECONCILING',
    depth: null,
    orphaned_events: '0',
    replayed_events: '0',
    details: {},
  }];
  const repository = new CanonicalChainRepository(database);

  const audit = await repository.getLastReorg();

  assert.equal(audit?.commonAncestor, null);
  assert.equal(audit?.impact.depth, null);
  assert.equal(audit?.impact.orphanedEvents, 0);
  assert.equal(audit?.impact.replayedEvents, 0);
  assert.deepEqual(audit?.details, {});
});

test('charge et valide le dernier audit MANUAL_REVIEW terminal, y compris profond', async () => {
  const database = new RecordingDatabase();
  database.rows = [{
    reorg_id: `reorg:${HASH_12}:${HASH_13}`,
    detected_at_ms: '1753700000000',
    common_ancestor_number: null,
    common_ancestor_hash: null,
    previous_tip_number: '12',
    previous_tip_hash: HASH_12,
    replacement_tip_number: '13',
    replacement_tip_hash: HASH_13,
    status: 'MANUAL_REVIEW',
    depth: null,
    orphaned_events: '0',
    replayed_events: '0',
    details: { reason: 'NO_COMMON_ANCESTOR_WITHIN_RETENTION' },
  }];
  const repository = new CanonicalChainRepository(database);
  const loadManualReview = (
    repository as unknown as {
      getManualReviewReorg(): Promise<unknown>;
    }
  ).getManualReviewReorg.bind(repository);

  const audit = await loadManualReview();

  assert.deepEqual(audit, {
    id: `reorg:${HASH_12}:${HASH_13}`,
    detectedAtMs: 1_753_700_000_000,
    commonAncestor: null,
    previousTip: { number: 12n, hash: HASH_12 },
    replacementTip: { number: 13n, hash: HASH_13 },
    status: 'MANUAL_REVIEW',
    impact: { depth: null, orphanedEvents: 0, replayedEvents: 0 },
    details: { reason: 'NO_COMMON_ANCESTOR_WITHIN_RETENTION' },
  });
  assert.match(database.calls[0]?.sql ?? '', /status = 'MANUAL_REVIEW'/u);
});

test('refuse fail-closed un audit MANUAL_REVIEW terminal incohérent', async () => {
  const database = new RecordingDatabase();
  database.rows = [{
    reorg_id: `reorg:${HASH_12}:${HASH_13}`,
    detected_at_ms: '1753700000000',
    common_ancestor_number: '10',
    common_ancestor_hash: HASH_10,
    previous_tip_number: '12',
    previous_tip_hash: HASH_12,
    replacement_tip_number: '13',
    replacement_tip_hash: HASH_13,
    status: 'MANUAL_REVIEW',
    depth: '1',
    orphaned_events: '0',
    replayed_events: '0',
    details: { reason: 'WALLET_CONSEQUENCE_REQUIRES_REVIEW' },
  }];
  const repository = new CanonicalChainRepository(database);
  const loadManualReview = (
    repository as unknown as {
      getManualReviewReorg(): Promise<unknown>;
    }
  ).getManualReviewReorg.bind(repository);

  await assert.rejects(loadManualReview(), /MANUAL_REVIEW.*invalide/u);
});

test('refuse un ancêtre MANUAL_REVIEW partiellement NULL au lieu de le traiter comme deep', async () => {
  const database = new RecordingDatabase();
  database.rows = [{
    reorg_id: `reorg:${HASH_12}:${HASH_13}`,
    detected_at_ms: '1753700000000',
    common_ancestor_number: '10',
    common_ancestor_hash: null,
    previous_tip_number: '12',
    previous_tip_hash: HASH_12,
    replacement_tip_number: '13',
    replacement_tip_hash: HASH_13,
    status: 'MANUAL_REVIEW',
    depth: null,
    orphaned_events: '0',
    replayed_events: '0',
    details: { reason: 'NO_COMMON_ANCESTOR_WITHIN_RETENTION' },
  }];
  const repository = new CanonicalChainRepository(database);

  await assert.rejects(
    repository.getManualReviewReorg(),
    /MANUAL_REVIEW.*invalide/u,
  );
});

test('hydrate le premier audit shallow RECONCILING avec ses snapshots validés', async () => {
  const database = new RecordingDatabase();
  const rollbackImpact: ReorgRollbackImpact = {
    reorgId: `reorg:${HASH_12}:${HASH_13}`,
    depth: 2,
    orphanedEvents: 1,
    replayedEvents: 0,
    orphanedEventIds: ['event-1'],
    affectedPairs: [{
      pairAddress: PAIR_A,
      discoveryOrphaned: false,
      earliestSessionBefore: validSession(PAIR_A, 1),
      latestCanonicalSessionAfter: null,
      hasWalletConsequence: false,
    }],
  };
  database.rows = [{
    reorg_id: rollbackImpact.reorgId,
    detected_at_ms: '1753700000000',
    common_ancestor_number: '10',
    common_ancestor_hash: HASH_10,
    previous_tip_number: '12',
    previous_tip_hash: HASH_12,
    replacement_tip_number: '13',
    replacement_tip_hash: HASH_13,
    status: 'RECONCILING',
    depth: '2',
    orphaned_events: '1',
    replayed_events: '0',
    details: stringifyJson({ rollbackImpact }),
  }];
  const repository = new CanonicalChainRepository(database);

  const pending = await repository.getPendingShallowReorg();

  assert.equal(pending?.audit.id, rollbackImpact.reorgId);
  assert.deepEqual(pending?.rollbackImpact, rollbackImpact);
  assert.match(database.calls[0]?.sql ?? '', /WHERE status = 'RECONCILING'/u);
});

test('charge tous les audits shallow RECONCILING dans leur ordre FIFO autoritatif', async () => {
  const database = new RecordingDatabase();
  const firstImpact: ReorgRollbackImpact = {
    reorgId: `reorg:${HASH_11}:${HASH_12}`,
    depth: 1,
    orphanedEvents: 1,
    replayedEvents: 0,
    orphanedEventIds: ['event-first'],
    affectedPairs: [],
  };
  const secondImpact: ReorgRollbackImpact = {
    reorgId: `reorg:${HASH_12}:${HASH_13}`,
    depth: 2,
    orphanedEvents: 1,
    replayedEvents: 0,
    orphanedEventIds: ['event-second'],
    affectedPairs: [],
  };
  database.rows = [
    {
      reorg_id: firstImpact.reorgId,
      detected_at_ms: '1753700000000',
      common_ancestor_number: '10',
      common_ancestor_hash: HASH_10,
      previous_tip_number: '11',
      previous_tip_hash: HASH_11,
      replacement_tip_number: '12',
      replacement_tip_hash: HASH_12,
      status: 'RECONCILING',
      depth: '1',
      orphaned_events: '1',
      replayed_events: '0',
      details: { rollbackImpact: firstImpact },
    },
    {
      reorg_id: secondImpact.reorgId,
      detected_at_ms: '1753700001000',
      common_ancestor_number: '10',
      common_ancestor_hash: HASH_10,
      previous_tip_number: '12',
      previous_tip_hash: HASH_12,
      replacement_tip_number: '13',
      replacement_tip_hash: HASH_13,
      status: 'RECONCILING',
      depth: '2',
      orphaned_events: '1',
      replayed_events: '0',
      details: { rollbackImpact: secondImpact },
    },
  ];
  const repository = new CanonicalChainRepository(database);

  const pending = await repository.listPendingShallowReorgs();

  assert.deepEqual(
    pending.map(({ audit }) => audit.id),
    [firstImpact.reorgId, secondImpact.reorgId],
  );
  assert.match(database.calls[0]?.sql ?? '', /ORDER BY detected_at ASC, reorg_id ASC/u);
});

test('refuse un rollback persistant dont les compteurs divergent de l’audit', async () => {
  const database = new RecordingDatabase();
  database.rows = [{
    reorg_id: `reorg:${HASH_12}:${HASH_13}`,
    detected_at_ms: '1753700000000',
    common_ancestor_number: '10',
    common_ancestor_hash: HASH_10,
    previous_tip_number: '12',
    previous_tip_hash: HASH_12,
    replacement_tip_number: '13',
    replacement_tip_hash: HASH_13,
    status: 'RECONCILING',
    depth: '2',
    orphaned_events: '2',
    replayed_events: '0',
    details: {
      rollbackImpact: {
        reorgId: `reorg:${HASH_12}:${HASH_13}`,
        depth: 2,
        orphanedEvents: 1,
        replayedEvents: 0,
        orphanedEventIds: ['event-1'],
        affectedPairs: [],
      },
    },
  }];
  const repository = new CanonicalChainRepository(database);

  await assert.rejects(
    repository.listPendingShallowReorgs(),
    /rollback persistant invalide/ui,
  );
});

test('refuse des identifiants d’événements orphelins dupliqués', async () => {
  const database = new RecordingDatabase();
  database.rows = [{
    reorg_id: `reorg:${HASH_12}:${HASH_13}`,
    detected_at_ms: '1753700000000',
    common_ancestor_number: '10',
    common_ancestor_hash: HASH_10,
    previous_tip_number: '12',
    previous_tip_hash: HASH_12,
    replacement_tip_number: '13',
    replacement_tip_hash: HASH_13,
    status: 'RECONCILING',
    depth: '2',
    orphaned_events: '2',
    replayed_events: '0',
    details: {
      rollbackImpact: {
        reorgId: `reorg:${HASH_12}:${HASH_13}`,
        depth: 2,
        orphanedEvents: 2,
        replayedEvents: 0,
        orphanedEventIds: ['event-1', 'event-1'],
        affectedPairs: [],
      },
    },
  }];
  const repository = new CanonicalChainRepository(database);

  await assert.rejects(
    repository.listPendingShallowReorgs(),
    /rollback persistant invalide/ui,
  );
});

for (const [name, snapshot] of [
  ['snapshot incomplet', {}],
  [
    'snapshot d’une autre paire',
    {
      pair: {
        factory: '0x1111111111111111111111111111111111111111',
        router: '0x2222222222222222222222222222222222222222',
        wbnb: '0x3333333333333333333333333333333333333333',
        pair: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        token: '0x4444444444444444444444444444444444444444',
        token0: '0x4444444444444444444444444444444444444444',
        token1: '0x3333333333333333333333333333333333333333',
        createdBlock: 10n,
        blockHash: HASH_10,
        createdTransactionHash: HASH_11,
        createdLogIndex: 0,
        discoveredAtMs: 1,
      },
      metadata: {
        address: '0x4444444444444444444444444444444444444444',
        name: 'Token',
        symbol: 'TKN',
        decimals: 18,
        totalSupply: 1_000n,
        codeSizeBytes: 1,
      },
      status: 'WAITING_FIRST_BUY',
      subsequentBuyCount: 0,
      targetBuysAfterEntry: 3,
      countedBuyTransactionHashes: [],
      sellAttempts: 0,
      createdAtMs: 1,
      updatedAtMs: 1,
    },
  ],
] as const) {
  test(`refuse ${name} dans rollbackImpact`, async () => {
    const database = new RecordingDatabase();
    const pairAddress = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    database.rows = [{
      reorg_id: `reorg:${HASH_12}:${HASH_13}`,
      detected_at_ms: '1753700000000',
      common_ancestor_number: '10',
      common_ancestor_hash: HASH_10,
      previous_tip_number: '12',
      previous_tip_hash: HASH_12,
      replacement_tip_number: '13',
      replacement_tip_hash: HASH_13,
      status: 'RECONCILING',
      depth: '2',
      orphaned_events: '1',
      replayed_events: '0',
      details: stringifyJson({
        rollbackImpact: {
          reorgId: `reorg:${HASH_12}:${HASH_13}`,
          depth: 2,
          orphanedEvents: 1,
          replayedEvents: 0,
          orphanedEventIds: ['event-1'],
          affectedPairs: [{
            pairAddress,
            discoveryOrphaned: false,
            earliestSessionBefore: snapshot,
            latestCanonicalSessionAfter: null,
            hasWalletConsequence: false,
          }],
        },
      }),
    }];
    const repository = new CanonicalChainRepository(database);

    await assert.rejects(
      repository.listPendingShallowReorgs(),
      /rollback persistant invalide/ui,
    );
  });
}

test('refuse explicitement un rollback persistant malformé au lieu de l’ignorer', async () => {
  const database = new RecordingDatabase();
  database.rows = [{
    reorg_id: 'reorg-malformed',
    detected_at_ms: '1753700000000',
    common_ancestor_number: '10',
    common_ancestor_hash: HASH_10,
    previous_tip_number: '12',
    previous_tip_hash: HASH_12,
    replacement_tip_number: '13',
    replacement_tip_hash: HASH_13,
    status: 'RECONCILING',
    depth: '2',
    orphaned_events: '1',
    replayed_events: '0',
    details: { rollbackImpact: { reorgId: 'wrong', depth: '2' } },
  }];
  const repository = new CanonicalChainRepository(database);

  await assert.rejects(
    repository.getPendingShallowReorg(),
    /rollback persistant invalide/ui,
  );
});

test('rewind un reorg superficiel dans une transaction ordonnée et retourne un impact déterministe', async () => {
  const database = new StatefulReorgDatabase();
  const repository = new CanonicalChainRepository(database);

  const impact = await repository.rewindToAncestor(SHALLOW_REORG);

  assert.deepEqual(
    database.calls.map(({ sql }) =>
      sql.replace(/\s+/gu, ' ').trim().match(
        /^(BEGIN|COMMIT|INSERT INTO chain_reorgs|SELECT .*? FROM ([a-z_]+)|UPDATE ([a-z_]+)|DELETE FROM ([a-z_]+))/u,
      )?.[0]
    ),
    [
      'BEGIN',
      'INSERT INTO chain_reorgs',
      'SELECT pair_address FROM discovered_tokens',
      'SELECT event_id, pair_address, block_number::text, transaction_index, log_index, session_before FROM swap_events',
      'SELECT t.trade_id, t.pair_address, EXISTS ( SELECT 1 FROM trade_transactions',
      'SELECT DISTINCT ON (pair_address) pair_address, session_after FROM swap_events',
      'UPDATE discovered_tokens',
      'UPDATE swap_events',
      'UPDATE token_risk_reports',
      'UPDATE trades',
      'UPDATE listener_checkpoints',
      'DELETE FROM canonical_blocks',
      'UPDATE chain_reorgs',
      'COMMIT',
    ],
  );
  assert.equal(impact.reorgId, `reorg:${HASH_12}:${HASH_13}`);
  assert.equal(impact.depth, 2);
  assert.deepEqual(impact.orphanedEventIds, [
    'event-early',
    'event-wallet',
    'event-late',
  ]);
  assert.deepEqual(impact.affectedPairs, [
    {
      pairAddress: PAIR_A,
      discoveryOrphaned: true,
      earliestSessionBefore: validSession(PAIR_A, 1),
      latestCanonicalSessionAfter: null,
      hasWalletConsequence: false,
    },
    {
      pairAddress: PAIR_B,
      discoveryOrphaned: true,
      earliestSessionBefore: null,
      latestCanonicalSessionAfter: validSession(PAIR_B, 3),
      hasWalletConsequence: true,
    },
  ]);
  assert.equal(database.state.auditCount, 1);
  assert.equal(database.state.committed, true);
  assert.equal(database.state.released, true);
  assert.deepEqual(
    database.calls.find(({ sql }) => sql.includes('UPDATE listener_checkpoints'))?.values,
    ['10', HASH_10],
  );
  assert.deepEqual(
    database.calls.find(({ sql }) => sql.includes('DELETE FROM canonical_blocks'))?.values,
    ['10'],
  );
  assert.match(
    database.calls.find(({ sql }) => sql.includes('UPDATE trades'))?.sql ?? '',
    /NOT EXISTS[\s\S]*trade_transactions/u,
  );
  assert.doesNotMatch(
    database.calls.find(({ sql }) => sql.includes('UPDATE trades'))?.sql ?? '',
    /t\.mode/u,
  );
});

test('rollback la transaction sans persister un snapshot de session incomplet', async () => {
  const database = new StatefulReorgDatabase();
  database.sessionBeforeOverride = {};
  const repository = new CanonicalChainRepository(database);

  await assert.rejects(
    repository.rewindToAncestor(SHALLOW_REORG),
    /snapshot de session invalide/ui,
  );

  assert.equal(database.state.auditCount, 0);
  assert.equal(database.state.rollbackImpact, null);
  assert.equal(database.state.committed, false);
});

for (const [name, invalidReorg] of [
  ['ancêtre absent', { ...SHALLOW_REORG, ancestor: null }],
  ['depth nul', { ...SHALLOW_REORG, depth: null }],
  ['depth zéro', { ...SHALLOW_REORG, depth: 0 }],
  ['depth décimal', { ...SHALLOW_REORG, depth: 1.5 }],
  ['depth supérieur à 128', { ...SHALLOW_REORG, depth: 129 }],
  ['depth incohérent', { ...SHALLOW_REORG, depth: 1 }],
  [
    'numéro ancêtre non bigint',
    {
      ...SHALLOW_REORG,
      ancestor: { ...SHALLOW_REORG.ancestor!, number: 10 },
    },
  ],
  [
    'numéro ancêtre négatif',
    {
      ...SHALLOW_REORG,
      ancestor: { ...SHALLOW_REORG.ancestor!, number: -1n },
    },
  ],
  [
    'hash ancêtre invalide',
    {
      ...SHALLOW_REORG,
      ancestor: { ...SHALLOW_REORG.ancestor!, hash: 'invalid' },
    },
  ],
  [
    'parentHash ancêtre invalide',
    {
      ...SHALLOW_REORG,
      ancestor: { ...SHALLOW_REORG.ancestor!, parentHash: 'invalid' },
    },
  ],
  [
    'numéro ancien tip négatif',
    { ...SHALLOW_REORG, oldTip: { ...SHALLOW_REORG.oldTip, number: -1n } },
  ],
  [
    'hash ancien tip invalide',
    { ...SHALLOW_REORG, oldTip: { ...SHALLOW_REORG.oldTip, hash: 'invalid' } },
  ],
  [
    'parentHash ancien tip invalide',
    {
      ...SHALLOW_REORG,
      oldTip: { ...SHALLOW_REORG.oldTip, parentHash: 'invalid' },
    },
  ],
  [
    'numéro nouveau tip non bigint',
    { ...SHALLOW_REORG, newTip: { ...SHALLOW_REORG.newTip, number: 13 } },
  ],
  [
    'hash nouveau tip invalide',
    { ...SHALLOW_REORG, newTip: { ...SHALLOW_REORG.newTip, hash: 'invalid' } },
  ],
  [
    'parentHash nouveau tip invalide',
    {
      ...SHALLOW_REORG,
      newTip: { ...SHALLOW_REORG.newTip, parentHash: 'invalid' },
    },
  ],
  [
    'ancêtre non antérieur',
    {
      ...SHALLOW_REORG,
      ancestor: { ...SHALLOW_REORG.ancestor!, number: 12n },
    },
  ],
  [
    'nouveau tip antérieur à l’ancien',
    { ...SHALLOW_REORG, newTip: { ...SHALLOW_REORG.newTip, number: 11n } },
  ],
] as Array<[string, unknown]>) {
  test(`refuse ${name} avant toute connexion ou requête`, async () => {
    const database = new StatefulReorgDatabase();
    const repository = new CanonicalChainRepository(database);

    await assert.rejects(
      repository.rewindToAncestor(
        invalidReorg as ReorgReconciliation,
      ),
      /rollback automatique/u,
    );

    assert.equal(database.connectCalls, 0);
    assert.equal(database.calls.length, 0);
  });
}

for (const failure of [
  'INSERT INTO chain_reorgs',
  'FROM discovered_tokens',
  'FROM swap_events',
  'FROM trades',
  'UPDATE discovered_tokens',
  'UPDATE swap_events',
  'UPDATE token_risk_reports',
  'UPDATE trades',
  'UPDATE listener_checkpoints',
  'DELETE FROM canonical_blocks',
  'UPDATE chain_reorgs',
]) {
  test(`rollback sans commit ni mutation visible si ${failure} échoue`, async () => {
    const database = new StatefulReorgDatabase();
    database.failOn = failure;
    const repository = new CanonicalChainRepository(database);

    await assert.rejects(repository.rewindToAncestor(SHALLOW_REORG), /failure:/u);

    assert.equal(database.calls.at(-1)?.sql, 'ROLLBACK');
    assert.equal(database.calls.some(({ sql }) => sql === 'COMMIT'), false);
    assert.deepEqual(database.state, {
      auditCount: 0,
      auditStatus: null,
      replayedEvents: 0,
      rollbackImpact: null,
      details: {},
      committed: false,
      released: true,
      mutations: [],
    });
  });
}

test('un retry du même fork réutilise audit et impact sans rejouer les mutations', async () => {
  const database = new StatefulReorgDatabase();
  const repository = new CanonicalChainRepository(database);
  const first = await repository.rewindToAncestor(SHALLOW_REORG);
  const mutationCount = database.state.mutations.length;

  const second = await repository.rewindToAncestor(SHALLOW_REORG);

  assert.deepEqual(second, first);
  assert.equal(database.state.auditCount, 1);
  assert.equal(database.state.mutations.length, mutationCount + 1);
  assert.equal(
    database.calls.filter(({ sql }) => sql.includes('UPDATE swap_events')).length,
    1,
  );
});

test('un retry idempotent refuse un rollbackImpact persistant devenu invalide', async () => {
  const database = new StatefulReorgDatabase();
  const repository = new CanonicalChainRepository(database);
  const first = await repository.rewindToAncestor(SHALLOW_REORG);
  database.state.rollbackImpact = JSON.parse(stringifyJson({
    ...first,
    orphanedEventIds: ['duplicate', 'duplicate', 'event-late'],
  }));

  await assert.rejects(
    repository.rewindToAncestor(SHALLOW_REORG),
    /rollback persistant invalide/ui,
  );

  assert.equal(
    database.calls.filter(({ sql }) => sql.includes('UPDATE swap_events')).length,
    1,
  );
});

for (const [source, configure] of [
  [
    'discovered_tokens',
    (database: StatefulReorgDatabase) => {
      database.discoveryPairOverride = 'not-an-address';
    },
  ],
  [
    'swap_events',
    (database: StatefulReorgDatabase) => {
      database.walletSwapPairOverride = 'not-an-address';
    },
  ],
  [
    'trades',
    (database: StatefulReorgDatabase) => {
      database.tradePairOverride = 'not-an-address';
    },
  ],
] as const) {
  test(`refuse une pair_address invalide lue depuis ${source} avant persistance`, async () => {
    const database = new StatefulReorgDatabase();
    configure(database);
    const repository = new CanonicalChainRepository(database);

    await assert.rejects(
      repository.rewindToAncestor(SHALLOW_REORG),
      /adresse de paire invalide/ui,
    );

    assert.equal(database.state.auditCount, 0);
    assert.equal(database.state.rollbackImpact, null);
  });
}

test('un reorg profond persiste seulement un audit manuel sans ancêtre', async () => {
  const database = new StatefulReorgDatabase();
  const repository = new CanonicalChainRepository(database);
  const deepReorg: ReorgReconciliation = {
    ...SHALLOW_REORG,
    ancestor: null,
    depth: null,
  };

  const audit = await repository.recordDeepReorg(
    deepReorg,
    'NO_COMMON_ANCESTOR_WITHIN_RETENTION',
  );

  assert.equal(audit.reorgId, `reorg:${HASH_12}:${HASH_13}`);
  assert.deepEqual(
    database.calls.map(({ sql }) => sql.replace(/\s+/gu, ' ').trim()),
    [
      'BEGIN',
      database.calls[1]?.sql.replace(/\s+/gu, ' ').trim(),
      'COMMIT',
    ],
  );
  assert.match(database.calls[1]?.sql ?? '', /INSERT INTO chain_reorgs/u);
  assert.deepEqual(database.calls[1]?.values?.slice(1, 4), [null, null, '12']);
  assert.equal(database.calls[1]?.values?.[7], 'MANUAL_REVIEW');
  assert.equal(database.calls[1]?.values?.[8], null);
  assert.deepEqual(JSON.parse(String(database.calls[1]?.values?.[11])), {
    reason: 'NO_COMMON_ANCESTOR_WITHIN_RETENTION',
  });
});

test('complete et manual review écrivent compte et détail sûr sans régresser RECOVERED', async () => {
  const database = new StatefulReorgDatabase();
  const repository = new CanonicalChainRepository(database);
  const impact = await repository.rewindToAncestor(SHALLOW_REORG);

  await repository.completeReorg(impact.reorgId, 7);
  await repository.requireManualReview(
    impact.reorgId,
    'WALLET_CONSEQUENCE_REQUIRES_REVIEW',
  );

  const complete = database.calls.find(
    ({ sql }) => sql.includes("status = 'RECOVERED'"),
  );
  const manual = database.calls.find(
    ({ sql }) => sql.includes("SET status = 'MANUAL_REVIEW'"),
  );
  assert.deepEqual(complete?.values, [impact.reorgId, 7]);
  assert.deepEqual(manual?.values, [
    impact.reorgId,
    '{"reason":"WALLET_CONSEQUENCE_REQUIRES_REVIEW"}',
  ]);
  assert.match(manual?.sql ?? '', /status = 'RECONCILING'/u);
});

test('un retry de rewind conserve un audit MANUAL_REVIEW terminal', async () => {
  const database = new StatefulReorgDatabase();
  const repository = new CanonicalChainRepository(database);
  const first = await repository.rewindToAncestor(SHALLOW_REORG);
  await repository.requireManualReview(
    first.reorgId,
    'SESSION_RECONCILIATION_FAILED',
  );

  const retry = await repository.rewindToAncestor(SHALLOW_REORG);

  assert.deepEqual(retry, first);
  assert.equal(database.state.auditStatus, 'MANUAL_REVIEW');
});

test('completeReorg laisse un audit MANUAL_REVIEW et son compteur inchangés', async () => {
  const database = new StatefulReorgDatabase();
  const repository = new CanonicalChainRepository(database);
  const impact = await repository.rewindToAncestor(SHALLOW_REORG);
  await repository.requireManualReview(
    impact.reorgId,
    'WALLET_CONSEQUENCE_REQUIRES_REVIEW',
  );

  await repository.completeReorg(impact.reorgId, 9);

  assert.equal(database.state.auditStatus, 'MANUAL_REVIEW');
  assert.equal(database.state.replayedEvents, 0);
});

test('requireManualReview laisse un audit RECOVERED intégralement inchangé', async () => {
  const database = new StatefulReorgDatabase();
  const repository = new CanonicalChainRepository(database);
  const impact = await repository.rewindToAncestor(SHALLOW_REORG);
  await repository.completeReorg(impact.reorgId, 4);
  const detailsBefore = structuredClone(database.state.details);

  await repository.requireManualReview(
    impact.reorgId,
    'REPLAY_FAILED',
  );

  assert.equal(database.state.auditStatus, 'RECOVERED');
  assert.equal(database.state.replayedEvents, 4);
  assert.deepEqual(database.state.details, detailsBefore);
});

for (const operation of ['complete', 'manual'] as const) {
  test(`${operation} rejette atomiquement un audit absent`, async () => {
    const database = new StatefulReorgDatabase();
    const repository = new CanonicalChainRepository(database);

    const call = operation === 'complete'
      ? repository.completeReorg('missing-reorg', 1)
      : repository.requireManualReview(
        'missing-reorg',
        'SESSION_RECONCILIATION_FAILED',
      );
    await assert.rejects(call, /Audit de reorg introuvable/u);

    assert.equal(database.calls.at(-1)?.sql, 'ROLLBACK');
    const mutation = database.calls.find(({ sql }) =>
      sql.includes('UPDATE chain_reorgs')
    );
    assert.match(mutation?.sql ?? '', /WITH existing AS/u);
    assert.match(mutation?.sql ?? '', /updated AS/u);
    assert.match(mutation?.sql ?? '', /RETURNING .*status/u);
  });
}

test('complete et manual mettent atomiquement à jour un audit RECONCILING', async () => {
  const completeDatabase = new StatefulReorgDatabase();
  const completeRepository = new CanonicalChainRepository(completeDatabase);
  const completeImpact = await completeRepository.rewindToAncestor(SHALLOW_REORG);

  await completeRepository.completeReorg(completeImpact.reorgId, 6);

  assert.equal(completeDatabase.state.auditStatus, 'RECOVERED');
  assert.equal(completeDatabase.state.replayedEvents, 6);

  const manualDatabase = new StatefulReorgDatabase();
  const manualRepository = new CanonicalChainRepository(manualDatabase);
  const manualImpact = await manualRepository.rewindToAncestor(SHALLOW_REORG);

  await manualRepository.requireManualReview(
    manualImpact.reorgId,
    'SESSION_RECONCILIATION_FAILED',
  );

  assert.equal(manualDatabase.state.auditStatus, 'MANUAL_REVIEW');
  assert.deepEqual(manualDatabase.state.details, {
    reason: 'SESSION_RECONCILIATION_FAILED',
  });
});

test('compte seulement les événements orphelins redevenus canoniques et PROCESSED', async () => {
  const database = new StatefulReorgDatabase();
  database.canonicalProcessedCount = 2;
  const repository = new CanonicalChainRepository(database);

  const count = await repository.countCanonicalProcessedEvents(['event-a', 'event-b']);

  assert.equal(count, 2);
  const query = database.calls.at(-1);
  assert.match(query?.sql ?? '', /canonical = TRUE/u);
  assert.match(query?.sql ?? '', /processing_status = 'PROCESSED'/u);
  assert.deepEqual(query?.values, [['event-a', 'event-b']]);
  assert.equal(await repository.countCanonicalProcessedEvents([]), 0);
});
