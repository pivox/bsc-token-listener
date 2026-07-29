import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import type { Address, Hash } from 'viem';
import { schemaName } from './schema-name.js';
import type { CanonicalChainRepository } from '../../src/chain/canonical-chain.repository.js';
import type {
  CanonicalBlock,
  ReorgReconciliation,
  ReorgRollbackImpact,
} from '../../src/chain/canonical-chain.types.js';
import type { ReorgSessionReconciler } from '../../src/chain/reorg-session-reconciler.js';
import type {
  CheckpointRepository,
  SessionRepository,
  SwapEventRepository,
} from '../../src/storage/repositories.js';
import type { SwapEvent, TokenSession } from '../../src/types/domain.js';
import { stringifyJson } from '../../src/utils/json.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL est obligatoire pour les tests PostgreSQL.');
}
process.env.DATABASE_URL = testDatabaseUrl;
process.env.BSC_HTTP_RPC_URL ??= 'http://127.0.0.1:8545';
process.env.BSC_WS_RPC_URL ??= 'ws://127.0.0.1:8546';

const { Client } = pg;
const FACTORY = address('1');
const ROUTER = address('2');
const WBNB = address('3');
const TOKEN = address('4');
const WALLET = address('5');

interface DatabaseClient {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  release(): void;
}

interface Database extends DatabaseClient {
  connect(): Promise<DatabaseClient>;
}

interface FixtureDatabaseClient extends DatabaseClient {
  drain(): Promise<void>;
}

interface FixtureDatabase extends Database {
  connect(): Promise<FixtureDatabaseClient>;
  drain(): Promise<void>;
}

function address(character: string): Address {
  return `0x${character.repeat(40)}` as Address;
}

function hash(character: string): Hash {
  return `0x${character.repeat(64)}` as Hash;
}

function block(number: bigint, value: Hash, parentHash: Hash): CanonicalBlock {
  return { number, hash: value, parentHash };
}

function session(
  pair: Address,
  status: TokenSession['status'] = 'WAITING_FIRST_BUY',
): TokenSession {
  return {
    pair: {
      factory: FACTORY,
      router: ROUTER,
      wbnb: WBNB,
      pair,
      token: TOKEN,
      token0: TOKEN,
      token1: WBNB,
      createdBlock: 10n,
      blockHash: hash('a'),
      createdTransactionHash: hash('b'),
      createdLogIndex: 0,
      discoveredAtMs: 1,
    },
    metadata: {
      address: TOKEN,
      name: 'Token',
      symbol: 'TKN',
      decimals: 18,
      totalSupply: 1_000n,
      codeSizeBytes: 1,
    },
    status,
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function swap(
  pair: Address,
  id: string,
  transactionHash: Hash,
  blockNumber: bigint,
  blockHash: Hash,
): SwapEvent {
  return {
    id,
    pair,
    transactionHash,
    blockHash,
    kind: 'BUY',
    sender: FACTORY,
    recipient: ROUTER,
    amount0In: 1n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 1n,
    amountWbnb: 1n,
    amountToken: 1n,
    cursor: { blockNumber, transactionIndex: 0, logIndex: 0 },
    observedAtMs: Number(blockNumber),
  };
}

function database(schema: string, failOn?: string): FixtureDatabase {
  const closing = new Set<Promise<void>>();
  const connect = async (): Promise<FixtureDatabaseClient> => {
    const client = new Client({ connectionString: testDatabaseUrl });
    await client.connect();
    await client.query(`SET search_path TO ${schema}`);
    let closingClient: Promise<void> | null = null;
    const close = (): Promise<void> => {
      closingClient ??= client.end();
      closing.add(closingClient);
      return closingClient;
    };
    return {
      query: async <T = Record<string, unknown>>(
        sql: string,
        values?: unknown[],
      ): Promise<{ rows: T[] }> => {
        if (failOn && sql.replace(/\s+/gu, ' ').includes(failOn)) {
          throw new Error(`injected SQL failure: ${failOn}`);
        }
        const result = await client.query(sql, values);
        return { rows: result.rows as T[] };
      },
      release: () => { void close(); },
      drain: close,
    };
  };
  return {
    async query<T = Record<string, unknown>>(sql: string, values?: unknown[]) {
      const client = await connect();
      try {
        return await client.query<T>(sql, values);
      } finally {
        client.release();
        await client.drain();
      }
    },
    connect,
    release: () => {},
    async drain(): Promise<void> {
      await Promise.all(closing);
    },
  };
}

async function withSchema(
  name: string,
  action: (value: Database) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: testDatabaseUrl });
  const schema = schemaName('chain_reorg', name);
  let scoped: FixtureDatabase | null = null;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    for (const migrationFile of [
      'migrations/001_init.sql',
      'migrations/005_trade_lifecycle.sql',
      'migrations/006_crash_reconciliation.sql',
      'migrations/007_chain_reorg_safety.sql',
    ]) {
      await client.query(await readFile(migrationFile, 'utf8'));
    }
    scoped = database(schema);
    await action(scoped);
  } finally {
    if (scoped) await scoped.drain();
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

async function insertSession(db: Database, value: TokenSession): Promise<void> {
  await db.query(
    `INSERT INTO token_sessions(
       pair_address, token_address, status, payload, canonical, created_at, updated_at
     ) VALUES ($1, $2, $3, $4::jsonb, TRUE, NOW(), NOW())`,
    [
      value.pair.pair.toLowerCase(),
      value.pair.token.toLowerCase(),
      value.status,
      stringifyJson(value),
    ],
  );
}

async function insertSwap(
  db: Database,
  value: SwapEvent,
  sessionBefore: TokenSession | null,
  sessionAfter: TokenSession | null = null,
): Promise<void> {
  await db.query(
    `INSERT INTO swap_events(
       event_id, pair_address, transaction_hash, block_hash, block_number,
       transaction_index, log_index, kind, payload, processing_status,
       session_before, session_after, canonical, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'PROCESSED',
       $10::jsonb, $11::jsonb, TRUE, NOW(), NOW())`,
    [
      value.id,
      value.pair.toLowerCase(),
      value.transactionHash.toLowerCase(),
      value.blockHash.toLowerCase(),
      value.cursor.blockNumber.toString(),
      value.cursor.transactionIndex,
      value.cursor.logIndex,
      value.kind,
      stringifyJson(value),
      sessionBefore === null ? null : stringifyJson(sessionBefore),
      sessionAfter === null ? null : stringifyJson(sessionAfter),
    ],
  );
}

async function insertDiscovery(db: Database, pair: Address, blockNumber: bigint): Promise<void> {
  await db.query(
    `INSERT INTO discovered_tokens(
       token_address, pair_address, deployment_transaction_hash, deployment_block,
       block_hash, probable_bep20, payload
     ) VALUES ($1, $2, $3, $4, $5, TRUE, '{}'::jsonb)`,
    [TOKEN.toLowerCase(), pair.toLowerCase(), hash('c'), blockNumber.toString(), hash('d')],
  );
}

async function rollbackProjectionState(
  db: Database,
): Promise<Record<string, unknown> | undefined> {
  const result = await db.query<{ state: Record<string, unknown> }>(
    `SELECT jsonb_build_object(
       'blocks', (SELECT jsonb_agg(jsonb_build_object('n', block_number, 'h', block_hash) ORDER BY block_number) FROM canonical_blocks),
       'checkpoints', (SELECT jsonb_agg(jsonb_build_object('key', listener_key, 'n', block_number, 'h', block_hash) ORDER BY listener_key) FROM listener_checkpoints),
       'discoveries', (SELECT jsonb_agg(jsonb_build_object('token', token_address, 'canonical', canonical) ORDER BY token_address) FROM discovered_tokens),
       'reports', (SELECT jsonb_agg(jsonb_build_object('source', source_event_id, 'canonical', canonical) ORDER BY source_event_id) FROM token_risk_reports),
       'swaps', (SELECT jsonb_agg(jsonb_build_object('id', event_id, 'canonical', canonical) ORDER BY event_id) FROM swap_events),
       'trades', (SELECT jsonb_agg(jsonb_build_object('id', trade_id, 'canonical', canonical) ORDER BY trade_id) FROM trades),
       'audits', (SELECT COUNT(*) FROM chain_reorgs)
     ) AS state`,
  );
  return result.rows[0]?.state;
}

function reorg(): ReorgReconciliation {
  return {
    ancestor: block(10n, hash('1'), hash('0')),
    oldTip: block(12n, hash('3'), hash('2')),
    newTip: block(13n, hash('4'), hash('3')),
    depth: 2,
  };
}

async function seedCanonicalWindow(db: Database): Promise<void> {
  const repository = await canonicalRepository(db);
  await repository.saveCanonicalBlocks([
    block(10n, hash('1'), hash('0')),
    block(11n, hash('2'), hash('1')),
    block(12n, hash('3'), hash('2')),
  ]);
}

async function canonicalRepository(db: Database): Promise<CanonicalChainRepository> {
  const { CanonicalChainRepository: Repository } =
    await import('../../src/chain/canonical-chain.repository.js');
  return new Repository(db);
}

async function checkpointRepository(db: Database): Promise<CheckpointRepository> {
  const { CheckpointRepository: Repository } =
    await import('../../src/storage/repositories.js');
  return new Repository(db);
}

async function sessionRepository(db: Database): Promise<SessionRepository> {
  const { SessionRepository: Repository } =
    await import('../../src/storage/repositories.js');
  return new Repository(db);
}

async function sessionStore(db: Database) {
  const sessions = await sessionRepository(db);
  const { SwapEventRepository: SwapRepository } =
    await import('../../src/storage/repositories.js');
  const swaps = new SwapRepository(db);
  return {
    findSession: (pair: Address) => sessions.findByPair(pair),
    listCanonicalProcessedEvents: (pair: Address) =>
      swaps.listCanonicalProcessedEvents(pair),
    saveReconciledSession: (value: TokenSession, canonical: boolean) =>
      sessions.saveReconciledSession(value, canonical),
  };
}

async function reorgReconciler(db: Database): Promise<ReorgSessionReconciler> {
  const { ReorgSessionReconciler: Reconciler } =
    await import('../../src/chain/reorg-session-reconciler.js');
  return new Reconciler(await sessionStore(db), () => 99);
}

async function assertRetainedAudit(
  repository: CanonicalChainRepository,
  expectedStatus: 'RECONCILING' | 'RECOVERED' | 'MANUAL_REVIEW' = 'RECONCILING',
): Promise<void> {
  const audit = await repository.getLastReorg();
  assert.ok(audit);
  assert.equal(audit.status, expectedStatus);
  assert.equal(audit.commonAncestor?.number, 10n);
  assert.equal(audit.impact.depth, 2);
  assert.equal(audit.impact.orphanedEvents, 1);
  assert.equal(
    (audit.details.rollbackImpact as { orphanedEventIds?: string[] })
      .orphanedEventIds?.length,
    1,
  );
}

test('chaîne normale conserve les blocs canoniques et un checkpoint hash-aware sans audit de reorg', async () => {
  await withSchema('normal', async (db) => {
    const canonical = await canonicalRepository(db);
    const checkpoints = await checkpointRepository(db);
    await seedCanonicalWindow(db);
    await checkpoints.set('pair-created', { blockNumber: 12n, blockHash: hash('3') });

    assert.deepEqual(await checkpoints.get('pair-created'), {
      blockNumber: 12n,
      blockHash: hash('3'),
    });
    assert.equal((await canonical.getCanonicalTip())?.hash, hash('3'));
    assert.equal((await canonical.listCanonicalDescending(10)).length, 3);
    const audits = await db.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM chain_reorgs');
    assert.equal(audits.rows[0]?.count, '0');
  });
});

test('un reorg dans la fenêtre retenue orpheline les projections et rembobine le checkpoint ancré', async () => {
  await withSchema('retained', async (db) => {
    const repository = await canonicalRepository(db);
    const checkpoints = await checkpointRepository(db);
    const pair = address('a');
    const before = session(pair);
    await seedCanonicalWindow(db);
    await checkpoints.set('swaps', { blockNumber: 12n, blockHash: hash('3') });
    await insertSwap(db, swap(pair, 'orphan-swap', hash('e'), 11n, hash('2')), before);

    const impact = await repository.rewindToAncestor(reorg());

    assert.deepEqual(impact.orphanedEventIds, ['orphan-swap']);
    assert.deepEqual(await checkpoints.get('swaps'), {
      blockNumber: 10n,
      blockHash: hash('1'),
    });
    const orphaned = await db.query<{ canonical: boolean }>(
      'SELECT canonical FROM swap_events WHERE event_id = $1', ['orphan-swap'],
    );
    assert.equal(orphaned.rows[0]?.canonical, false);
    assert.equal((await repository.getCanonicalTip())?.number, 10n);
    await assertRetainedAudit(repository);
  });
});

test('une divergence détectée après redémarrage par le coordinateur rembobine le fork A', async () => {
  await withSchema('restart', async (db) => {
    const pair = address('b');
    const initialRepository = await canonicalRepository(db);
    const initialCheckpoints = await checkpointRepository(db);
    await initialRepository.saveCanonicalBlocks([
      block(10n, hash('1'), hash('0')),
      block(11n, hash('2'), hash('1')),
      block(12n, hash('3'), hash('2')),
    ]);
    await initialCheckpoints.set('restart-listener', {
      blockNumber: 12n,
      blockHash: hash('3'),
    });
    await insertSwap(
      db,
      swap(pair, 'restart-orphan', hash('e'), 11n, hash('2')),
      session(pair),
    );

    const restartedRepository = await canonicalRepository(db);
    const restartedCheckpoints = await checkpointRepository(db);
    const { RuntimeRecoveryBarrier } =
      await import('../../src/recovery/runtime-recovery-barrier.js');
    const runtime = new RuntimeRecoveryBarrier();
    const { CanonicalChainCoordinator: Coordinator } =
      await import('../../src/chain/canonical-chain.coordinator.js');
    const forkB = new Map<bigint, CanonicalBlock>([
      [10n, block(10n, hash('1'), hash('0'))],
      [11n, block(11n, hash('4'), hash('1'))],
      [12n, block(12n, hash('5'), hash('4'))],
      [13n, block(13n, hash('6'), hash('5'))],
    ]);
    let rollback: ReorgRollbackImpact | null = null;
    let detectedFork: ReorgReconciliation | null = null;
    const restartedCoordinator = new Coordinator({
      blockReader: {
        getBlockNumber: async () => 13n,
        getBlock: async (number) => {
          const header = forkB.get(number);
          if (!header) throw new Error(`Header fork B absent: ${number}.`);
          return header;
        },
      },
      canonicalStore: restartedRepository,
      checkpoints: restartedCheckpoints,
      confirmations: 1,
      runtimeBarrier: runtime,
      reorgHandler: {
        reconcileReorg: (fork) => runtime.runRecovery(async () => {
          detectedFork = fork;
          rollback = await restartedRepository.rewindToAncestor(fork);
          return rollback;
        }),
      },
      afterReorg: async () => {
        const impact = rollback;
        const fork = detectedFork;
        assert.ok(impact);
        assert.ok(fork);
        await restartedRepository.completeReorg(impact.reorgId, 0);
        return {
          identity: `${fork.oldTip.hash.toLowerCase()}:${fork.newTip.hash.toLowerCase()}`,
          reorgId: impact.reorgId,
          replayedEvents: 0,
        };
      },
    });

    await restartedCoordinator.reconcile({
      listenerKey: 'restart-listener',
      startBlock: 10n,
      processChunk: async () => {
        assert.fail('aucun chunk métier avant le rewind après redémarrage');
      },
    });
    await restartedCoordinator.waitForIdle();

    assert.equal(restartedCoordinator.currentStatus.state, 'HEALTHY');
    assert.equal(restartedCoordinator.currentStatus.lastReorg?.status, 'RECOVERED');
    assert.equal(restartedCoordinator.currentStatus.lastReorg?.ancestor?.number, 10n);
    assert.equal((await restartedRepository.getCanonicalTip())?.number, 10n);
    assert.deepEqual(await restartedCheckpoints.get('restart-listener'), {
      blockNumber: 10n,
      blockHash: hash('1'),
    });
    const orphaned = await db.query<{ canonical: boolean }>(
      'SELECT canonical FROM swap_events WHERE event_id = $1',
      ['restart-orphan'],
    );
    assert.equal(orphaned.rows[0]?.canonical, false);
    await assertRetainedAudit(restartedRepository, 'RECOVERED');
  });
});

test('un PairCreated disparu rejette la session non canonique tout en conservant son audit', async () => {
  await withSchema('pair-created', async (db) => {
    const pair = address('c');
    const current = session(pair);
    const repository = await canonicalRepository(db);
    await seedCanonicalWindow(db);
    await insertSession(db, current);
    await insertDiscovery(db, pair, 11n);
    await insertSwap(db, swap(pair, 'pair-created-orphan', hash('e'), 11n, hash('2')), current);
    const impact = await repository.rewindToAncestor(reorg());

    const reconciler = await reorgReconciler(db);
    const result = await reconciler.reconcile(impact);
    const persisted = await (await sessionRepository(db)).findByPair(pair);
    assert.deepEqual(result.monitorsToStop, [pair]);
    assert.equal(persisted?.status, 'REJECTED');
    const discovery = await db.query<{ canonical: boolean }>(
      'SELECT canonical FROM discovered_tokens WHERE token_address = $1', [TOKEN.toLowerCase()],
    );
    assert.equal(discovery.rows[0]?.canonical, false);
    await assertRetainedAudit(repository);
  });
});

test('un premier achat disparu restaure WAITING_FIRST_BUY et conserve l’audit', async () => {
  await withSchema('first-buy', async (db) => {
    const pair = address('d');
    const orphan = swap(pair, 'first-buy-orphan', hash('e'), 11n, hash('2'));
    const current = session(pair, 'RISK_CHECKING');
    current.firstBuy = orphan;
    current.entryObservationBuys = [orphan];
    current.riskReportId = 'risk-orphan';
    const before = session(pair, 'WAITING_FIRST_BUY');
    const repository = await canonicalRepository(db);
    await seedCanonicalWindow(db);
    await insertSession(db, current);
    await insertSwap(db, orphan, before);
    await db.query(
      `INSERT INTO token_risk_reports(
         id, token_address, pair_address, block_number, score, verdict, checks, report, source_event_id
       ) VALUES ($1, $2, $3, 11, 10, 'ALLOW', '{}'::jsonb, '{}'::jsonb, $4)`,
      [randomUUID(), TOKEN.toLowerCase(), pair.toLowerCase(), orphan.id],
    );
    const impact = await repository.rewindToAncestor(reorg());
    await (await reorgReconciler(db)).reconcile(impact);

    const restored = await (await sessionRepository(db)).findByPair(pair);
    assert.equal(restored?.status, 'WAITING_FIRST_BUY');
    assert.equal(restored?.firstBuy, undefined);
    assert.equal(restored?.entryObservationBuys, undefined);
    assert.equal(restored?.riskReportId, undefined);
    const report = await db.query<{ canonical: boolean }>(
      'SELECT canonical FROM token_risk_reports WHERE source_event_id = $1', [orphan.id],
    );
    assert.equal(report.rows[0]?.canonical, false);
    await assertRetainedAudit(repository);
  });
});

test('un achat compté disparu reconstruit le compteur depuis les seuls swaps canoniques', async () => {
  await withSchema('counted-buy', async (db) => {
    const pair = address('e');
    const entryHash = hash('6');
    const canonicalHash = hash('7');
    const orphanHash = hash('8');
    const before = session(pair, 'HOLDING');
    before.entry = {
      mode: 'dry-run', amountInWei: 1n, amountOutToken: 1n, confirmedAtMs: 1,
      cursor: { blockNumber: 9n, transactionIndex: 0, logIndex: 0 }, transactionHash: entryHash,
    };
    const current = structuredClone(before);
    current.countedBuyTransactionHashes = [canonicalHash, orphanHash];
    current.subsequentBuyCount = 2;
    const repository = await canonicalRepository(db);
    await seedCanonicalWindow(db);
    await insertSession(db, current);
    await insertSwap(db, swap(pair, 'canonical-counted', canonicalHash, 10n, hash('1')), before, before);
    await insertSwap(db, swap(pair, 'orphan-counted', orphanHash, 11n, hash('2')), before);
    const impact = await repository.rewindToAncestor(reorg());
    await (await reorgReconciler(db)).reconcile(impact);

    const restored = await (await sessionRepository(db)).findByPair(pair);
    assert.deepEqual(restored?.countedBuyTransactionHashes, [canonicalHash]);
    assert.equal(restored?.subsequentBuyCount, 1);
    const orphaned = await db.query<{ canonical: boolean }>(
      'SELECT canonical FROM swap_events WHERE event_id = $1', ['orphan-counted'],
    );
    assert.equal(orphaned.rows[0]?.canonical, false);
    await assertRetainedAudit(repository);
  });
});

test('un signal de vente dry-run disparu restaure HOLDING et supersède sa projection', async () => {
  await withSchema('sell-signal', async (db) => {
    const pair = address('a');
    const canonicalHash = hash('7');
    const signalHash = hash('8');
    const before = session(pair, 'HOLDING');
    before.entry = {
      mode: 'dry-run',
      amountInWei: 10n,
      amountOutToken: 20n,
      confirmedAtMs: 1,
      cursor: { blockNumber: 9n, transactionIndex: 0, logIndex: 0 },
      transactionHash: hash('6'),
    };
    before.targetBuysAfterEntry = 2;
    before.countedBuyTransactionHashes = [canonicalHash];
    before.subsequentBuyCount = 1;
    const current = structuredClone(before);
    current.status = 'CLOSED';
    current.countedBuyTransactionHashes = [canonicalHash, signalHash];
    current.subsequentBuyCount = 2;
    current.sellAttempts = 1;
    current.exit = {
      mode: 'dry-run',
      amountInToken: 20n,
      amountOutWei: 12n,
      confirmedAtMs: 2,
      transactionHash: signalHash,
    };
    const signal = swap(
      pair,
      'orphan-sell-signal',
      signalHash,
      11n,
      hash('2'),
    );
    const repository = await canonicalRepository(db);
    await seedCanonicalWindow(db);
    await insertSession(db, current);
    await insertSwap(
      db,
      swap(pair, 'canonical-before-sell', canonicalHash, 10n, hash('1')),
      before,
      before,
    );
    await insertSwap(db, signal, before);
    await db.query(
      `INSERT INTO trades(
         trade_id, pair_address, token_address, side, mode, status,
         source_event_id, canonical, payload, created_at, updated_at
       ) VALUES ('orphan-dry-sell', $1, $2, 'SELL', 'dry-run', 'SIMULATED',
         $3, TRUE, '{}'::jsonb, NOW(), NOW())`,
      [pair.toLowerCase(), TOKEN.toLowerCase(), signal.id],
    );

    const impact = await repository.rewindToAncestor(reorg());
    await (await reorgReconciler(db)).reconcile(impact);

    const restored = await (await sessionRepository(db)).findByPair(pair);
    assert.equal(restored?.status, 'HOLDING');
    assert.equal(restored?.exit, undefined);
    assert.equal(restored?.sellAttempts, 0);
    assert.deepEqual(restored?.countedBuyTransactionHashes, [canonicalHash]);
    assert.equal(restored?.subsequentBuyCount, 1);
    const projection = await db.query<{ canonical: boolean }>(
      'SELECT canonical FROM trades WHERE trade_id = $1',
      ['orphan-dry-sell'],
    );
    const orphaned = await db.query<{ canonical: boolean }>(
      'SELECT canonical FROM swap_events WHERE event_id = $1',
      [signal.id],
    );
    assert.equal(projection.rows[0]?.canonical, false);
    assert.equal(orphaned.rows[0]?.canonical, false);
    await assertRetainedAudit(repository);
  });
});

test('une transaction wallet confirmée est préservée et force MANUAL_REVIEW avec audit retenu', async () => {
  await withSchema('wallet', async (db) => {
    const pair = address('f');
    const current = session(pair, 'HOLDING');
    const event = swap(pair, 'wallet-orphan', hash('e'), 11n, hash('2'));
    const repository = await canonicalRepository(db);
    await seedCanonicalWindow(db);
    await insertSession(db, current);
    await insertSwap(db, event, current);
    await db.query(
      `INSERT INTO trades(
         trade_id, pair_address, token_address, side, mode, status, source_event_id,
         canonical, payload, created_at, updated_at
       ) VALUES ('wallet-trade', $1, $2, 'BUY', 'live', 'CONFIRMED', $3, TRUE,
         '{}'::jsonb, NOW(), NOW())`,
      [pair.toLowerCase(), TOKEN.toLowerCase(), event.id],
    );
    await db.query(
      `INSERT INTO trade_transactions(
         transaction_id, trade_id, step, status, wallet_address, transaction_hash,
         nonce, to_address, value_wei, payload, created_at, updated_at
       ) VALUES ('wallet-tx', 'wallet-trade', 'BUY', 'CONFIRMED', $1, $2,
         1, $3, 1, '{}'::jsonb, NOW(), NOW())`,
      [WALLET.toLowerCase(), hash('9'), ROUTER.toLowerCase()],
    );
    const impact = await repository.rewindToAncestor(reorg());
    await (await reorgReconciler(db)).reconcile(impact);
    await repository.requireManualReview(impact.reorgId, 'WALLET_CONSEQUENCE_REQUIRES_REVIEW');

    const persisted = await (await sessionRepository(db)).findByPair(pair);
    assert.equal(persisted?.status, 'MANUAL_REVIEW');
    const transaction = await db.query<{ status: string }>(
      'SELECT status FROM trade_transactions WHERE transaction_id = $1', ['wallet-tx'],
    );
    const trade = await db.query<{ canonical: boolean }>(
      'SELECT canonical FROM trades WHERE trade_id = $1', ['wallet-trade'],
    );
    assert.equal(transaction.rows[0]?.status, 'CONFIRMED');
    assert.equal(trade.rows[0]?.canonical, true);
    await assertRetainedAudit(repository, 'MANUAL_REVIEW');
  });
});

test('un échec SQL rollback ne laisse aucune ligne mutée ni audit partiel', async () => {
  await withSchema('rollback', async (db) => {
    const pair = address('a');
    const original = session(pair);
    const event = swap(pair, 'rollback-orphan', hash('e'), 11n, hash('2'));
    const checkpoints = await checkpointRepository(db);
    await seedCanonicalWindow(db);
    await insertSession(db, original);
    await checkpoints.set('rollback-listener', { blockNumber: 12n, blockHash: hash('3') });
    await insertDiscovery(db, pair, 11n);
    await insertSwap(db, event, original);
    await db.query(
      `INSERT INTO token_risk_reports(
         id, token_address, pair_address, block_number, score, verdict, checks, report, source_event_id
       ) VALUES ($1, $2, $3, 11, 10, 'ALLOW', '{}'::jsonb, '{}'::jsonb, $4)`,
      [randomUUID(), TOKEN.toLowerCase(), pair.toLowerCase(), event.id],
    );
    await db.query(
      `INSERT INTO trades(
         trade_id, pair_address, token_address, side, mode, status, source_event_id,
         canonical, payload, created_at, updated_at
       ) VALUES ('rollback-trade', $1, $2, 'BUY', 'dry-run', 'SIMULATED', $3, TRUE,
         '{}'::jsonb, NOW(), NOW())`,
      [pair.toLowerCase(), TOKEN.toLowerCase(), event.id],
    );
    const before = await rollbackProjectionState(db);

    const failingDatabase = database(
      (await db.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0]?.schema ?? '',
      'UPDATE chain_reorgs SET orphaned_events',
    );
    const failingRepository = await canonicalRepository(failingDatabase);
    try {
      await assert.rejects(
        failingRepository.rewindToAncestor(reorg()),
        /injected SQL failure/u,
      );
    } finally {
      await failingDatabase.drain();
    }
    assert.deepEqual(await rollbackProjectionState(db), before);
    assert.equal((await (await canonicalRepository(db)).getLastReorg()), null);
  });
});

test('la migration 007 est idempotente et conserve ses structures canoniques', async () => {
  const client = new Client({ connectionString: testDatabaseUrl });
  const schema = `chain_reorg_migration_${randomUUID().replaceAll('-', '')}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    for (const migrationFile of [
      'migrations/001_init.sql',
      'migrations/005_trade_lifecycle.sql',
      'migrations/006_crash_reconciliation.sql',
    ]) await client.query(await readFile(migrationFile, 'utf8'));
    const migration = await readFile('migrations/007_chain_reorg_safety.sql', 'utf8');
    await client.query(migration);
    await client.query(migration);

    const columns = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'listener_checkpoints'`, [schema],
    );
    assert.equal(new Set(columns.rows.map(({ column_name }) => column_name)).has('block_hash'), true);
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name IN ('canonical_blocks', 'chain_reorgs')`, [schema],
    );
    assert.deepEqual(tables.rows.map(({ table_name }) => table_name).sort(), [
      'canonical_blocks', 'chain_reorgs',
    ]);
    const audits = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM chain_reorgs');
    assert.equal(audits.rows[0]?.count, '0');
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
