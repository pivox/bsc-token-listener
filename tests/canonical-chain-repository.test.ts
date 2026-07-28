import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Hash } from 'viem';
import { CanonicalChainRepository } from '../src/chain/canonical-chain.repository.js';
import type {
  CanonicalBlock,
  ReorgReconciliation,
} from '../src/chain/canonical-chain.types.js';
import { CheckpointRepository } from '../src/storage/repositories.js';

const HASH_10 = `0x${'1'.repeat(64)}` as Hash;
const HASH_11 = `0x${'2'.repeat(64)}` as Hash;
const HASH_12 = `0x${'3'.repeat(64)}` as Hash;
const HASH_13 = `0x${'4'.repeat(64)}` as Hash;

const SHALLOW_REORG: ReorgReconciliation = {
  ancestor: { number: 10n, hash: HASH_10, parentHash: HASH_10 },
  oldTip: { number: 12n, hash: HASH_12, parentHash: HASH_11 },
  newTip: { number: 13n, hash: HASH_13, parentHash: HASH_12 },
  depth: 2,
};

interface ReorgFixtureState {
  auditCount: number;
  committed: boolean;
  released: boolean;
  mutations: string[];
}

class StatefulReorgDatabase {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  readonly state: ReorgFixtureState = {
    auditCount: 0,
    committed: false,
    released: false,
    mutations: [],
  };
  failOn: string | null = null;
  private pending: ReorgFixtureState | null = null;
  private savedImpact: unknown = null;

  async connect(): Promise<this> {
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
    if (normalized.includes('INSERT INTO chain_reorgs')) {
      if (staged.auditCount === 0) staged.auditCount = 1;
      staged.mutations.push('audit');
      return {
        rows: [{
          status: this.savedImpact ? 'RECONCILING' : String(values?.[7]),
          details: this.savedImpact
            ? { rollbackImpact: this.savedImpact }
            : JSON.parse(String(values?.[11])),
        }] as T[],
      };
    }
    if (normalized.includes('FROM discovered_tokens') && normalized.includes('FOR UPDATE')) {
      return {
        rows: [
          { pair_address: '0xpair-b' },
          { pair_address: '0xpair-a' },
        ] as T[],
      };
    }
    if (normalized.includes('FROM swap_events') && normalized.includes('FOR UPDATE')) {
      return {
        rows: [
          {
            event_id: 'event-late',
            pair_address: '0xpair-a',
            block_number: '12',
            transaction_index: 1,
            log_index: 0,
            session_before: '{"step":"late"}',
          },
          {
            event_id: 'event-early',
            pair_address: '0xpair-a',
            block_number: '11',
            transaction_index: 0,
            log_index: 2,
            session_before: '{"step":"baseline"}',
          },
          {
            event_id: 'event-wallet',
            pair_address: '0xpair-b',
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
          { trade_id: 'dry-trade', pair_address: '0xpair-a', has_transaction: false },
          { trade_id: 'wallet-trade', pair_address: '0xpair-b', has_transaction: true },
        ] as T[],
      };
    }
    if (
      normalized.includes('FROM swap_events')
      && normalized.includes('DISTINCT ON')
    ) {
      return {
        rows: [{
          pair_address: '0xpair-b',
          session_after: '{"step":"canonical"}',
        }] as T[],
      };
    }
    if (normalized.includes('UPDATE chain_reorgs') && normalized.includes('rollbackImpact')) {
      this.savedImpact = JSON.parse(String(values?.[2]));
      staged.mutations.push('impact');
      return { rows: [] };
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
      pairAddress: '0xpair-a',
      discoveryOrphaned: true,
      earliestSessionBefore: { step: 'baseline' },
      latestCanonicalSessionAfter: null,
      hasWalletConsequence: false,
    },
    {
      pairAddress: '0xpair-b',
      discoveryOrphaned: true,
      earliestSessionBefore: null,
      latestCanonicalSessionAfter: { step: 'canonical' },
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

  await repository.completeReorg('reorg-id', 7);
  await repository.requireManualReview(
    'reorg-id',
    'WALLET_CONSEQUENCE_REQUIRES_REVIEW',
  );

  const complete = database.calls.find(
    ({ sql }) => sql.includes("status = 'RECOVERED'"),
  );
  const manual = database.calls.find(
    ({ sql }) => sql.includes("'MANUAL_REVIEW'"),
  );
  assert.deepEqual(complete?.values, ['reorg-id', 7]);
  assert.deepEqual(manual?.values, [
    'reorg-id',
    '{"reason":"WALLET_CONSEQUENCE_REQUIRES_REVIEW"}',
  ]);
  assert.match(manual?.sql ?? '', /status = 'RECOVERED' THEN status/u);
});
