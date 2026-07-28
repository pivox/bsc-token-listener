import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Hash } from 'viem';
import { CanonicalChainRepository } from '../src/chain/canonical-chain.repository.js';
import type { CanonicalBlock } from '../src/chain/canonical-chain.types.js';
import { CheckpointRepository } from '../src/storage/repositories.js';

const HASH_10 = `0x${'1'.repeat(64)}` as Hash;
const HASH_11 = `0x${'2'.repeat(64)}` as Hash;
const HASH_12 = `0x${'3'.repeat(64)}` as Hash;

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
