import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hash } from 'viem';
import type { CanonicalChainState } from '../src/chain/canonical-chain.types.js';
import type { ListenerCheckpoint } from '../src/chain/canonical-chain.types.js';
import { HeartbeatService, type ChainHealth } from '../src/heartbeat/heartbeat.js';
import type { CheckpointRepository, SessionRepository } from '../src/storage/repositories.js';
import { RpcUsageTracker } from '../src/monitoring/rpc-usage.js';

const BLOCK_HASH = `0x${'1'.repeat(64)}` as Hash;

function createSessionStore(active: number): { countActive: () => Promise<number> } {
  return {
    async countActive(): Promise<number> {
      return active;
    },
  };
}

function createCheckpointStore(
  checkpoint: bigint | null,
  blockHash: Hash | null = BLOCK_HASH,
): { get: (key: string) => Promise<ListenerCheckpoint | null> } {
  return {
    async get(_key: string): Promise<ListenerCheckpoint | null> {
      return checkpoint === null
        ? null
        : { blockNumber: checkpoint, blockHash };
    },
  };
}

test('collecte et expose un heartbeat complet avec RPC disponibles', async () => {
  const usage = new RpcUsageTracker();
  usage.recordMethodCall('eth_blockNumber');
  usage.recordMethodSuccess('eth_blockNumber');
  const heartbeat = new HeartbeatService(
    createCheckpointStore(3_456n) as unknown as CheckpointRepository,
    createSessionStore(4) as unknown as SessionRepository,
    {
      getHttpLatestBlock: async () => 12_345n,
      getWsLatestBlock: async () => 12_346n,
      getRpcUsage: async () => usage.getSnapshot(),
    },
    'dry-run',
    {
      get currentStatus() {
        return {
          running: false,
          lastCompletedAtMs: 1_753_700_000_000,
          lastErrorType: null,
          lastProcessedSessions: 2,
          pendingSessions: 1,
          manualReviewSessions: 3,
        };
      },
    },
  );

  const snapshot = await heartbeat.refresh(2, {
    capacity: 5,
    activeMonitors: 2,
    waitingSessions: 3,
    abandonedSessions: 1,
    oldestWaitingAgeMs: 12_000,
  });

  assert.equal(snapshot.executionMode, 'dry-run');
  assert.equal(snapshot.latestBlock, '12345');
  assert.equal(snapshot.pairCreatedCheckpoint, '3456');
  assert.equal(snapshot.activeSwapMonitors, 2);
  assert.equal(snapshot.activeSessions, 4);
  assert.deepEqual(snapshot.monitoring, {
    capacity: 5,
    activeMonitors: 2,
    waitingSessions: 3,
    abandonedSessions: 1,
    oldestWaitingAgeMs: 12_000,
  });
  assert.equal(snapshot.http.status, 'up');
  assert.equal(snapshot.webSocket.status, 'up');
  assert.equal(snapshot.http.blockNumber, '12345');
  assert.equal(snapshot.webSocket.blockNumber, '12346');
  assert.equal(snapshot.http.error, null);
  assert.equal(snapshot.webSocket.error, null);
  assert.equal(snapshot.rpcUsage?.methods.eth_blocknumber?.calls, 1);
  assert.equal(snapshot.recovery.pendingSessions, 1);
  assert.equal(snapshot.recovery.manualReviewSessions, 3);
  assert.equal(snapshot.recovery.lastProcessedSessions, 2);
  assert.equal(
    snapshot.recovery.lastCompletedAt,
    new Date(1_753_700_000_000).toISOString(),
  );
  assert.equal(heartbeat.currentSnapshot?.activeSessions, 4);
});

test('expose le numéro d’un checkpoint legacy sans le confondre avec une absence', async () => {
  const heartbeat = new HeartbeatService(
    createCheckpointStore(3_456n, null) as unknown as CheckpointRepository,
    createSessionStore(0) as unknown as SessionRepository,
    {
      getHttpLatestBlock: async () => 12_345n,
      getWsLatestBlock: async () => 12_346n,
    },
    'dry-run',
  );

  const snapshot = await heartbeat.refresh(0);

  assert.equal(snapshot.pairCreatedCheckpoint, '3456');
});

test('garde le dernier bloc valide quand le RPC HTTP chute', async () => {
  const checkpoint = createCheckpointStore(9_999n);
  const sessionStore = createSessionStore(9);
  let httpCallCount = 0;

  const heartbeat = new HeartbeatService(
    checkpoint as unknown as CheckpointRepository,
    sessionStore as unknown as SessionRepository,
    {
      getHttpLatestBlock: async () => {
        if (httpCallCount === 0) {
          httpCallCount += 1;
          return 9_000n;
        }
        throw new Error('RPC HTTP indisponible');
      },
      getWsLatestBlock: async () => 9_001n,
    },
    'live',
  );

  const firstSnapshot = await heartbeat.refresh(1);
  assert.equal(firstSnapshot.latestBlock, '9000');
  assert.equal(firstSnapshot.http.status, 'up');

  const secondSnapshot = await heartbeat.refresh(1);
  assert.equal(secondSnapshot.latestBlock, '9000');
  assert.equal(secondSnapshot.http.status, 'down');
  assert.equal(secondSnapshot.http.blockNumber, null);
  assert.equal(secondSnapshot.http.error, 'RPC HTTP indisponible');
  assert.equal(secondSnapshot.webSocket.status, 'up');
});

test('expose la santé canonique et conserve un dernier état valide explicitement stale après une erreur RPC', async () => {
  let healthy = true;
  const chain: ChainHealth = {
    confirmations: 5,
    confirmedHead: '120',
    canonicalBlockNumber: '120',
    canonicalBlockHash: `0x${'2'.repeat(64)}`,
    state: 'HEALTHY' as CanonicalChainState,
    stale: false,
    lastReorg: {
      detectedAt: '2026-07-29T10:00:00.000Z',
      depth: 2,
      commonAncestorNumber: '118',
      commonAncestorHash: `0x${'3'.repeat(64)}`,
      status: 'RECOVERED',
      orphanedEvents: 4,
      replayedEvents: 3,
    },
  };
  const heartbeat = new HeartbeatService(
    createCheckpointStore(120n) as unknown as CheckpointRepository,
    createSessionStore(0) as unknown as SessionRepository,
    {
      getHttpLatestBlock: async () => {
        if (healthy) return 125n;
        throw new Error('RPC HTTP indisponible');
      },
      getWsLatestBlock: async () => 125n,
    },
    'dry-run',
    undefined,
    {
      confirmations: 5,
      async getHealth(): Promise<ChainHealth> {
        if (!healthy) throw new Error('Lecture canonique indisponible');
        return chain;
      },
    },
  );

  const first = await heartbeat.refresh(0);
  assert.deepEqual(first.chain, chain);

  healthy = false;
  const second = await heartbeat.refresh(0);
  assert.deepEqual(second.chain, {
    ...chain,
    state: 'RECONCILING',
    stale: true,
  });
  assert.equal(second.http.status, 'down');
});

test('conserve le fixture MANUAL_REVIEW lors d’un rafraîchissement canonique stale', async () => {
  let available = true;
  const heartbeat = new HeartbeatService(
    createCheckpointStore(null) as unknown as CheckpointRepository,
    createSessionStore(0) as unknown as SessionRepository,
    {
      getHttpLatestBlock: async () => 125n,
      getWsLatestBlock: async () => 125n,
    },
    'dry-run',
    undefined,
    {
      confirmations: 5,
      async getHealth(): Promise<ChainHealth> {
        if (!available) throw new Error('Lecture canonique indisponible');
        return {
          confirmations: 5,
          confirmedHead: '120',
          canonicalBlockNumber: '120',
          canonicalBlockHash: BLOCK_HASH,
          state: 'MANUAL_REVIEW',
          stale: false,
          lastReorg: {
            detectedAt: '2026-07-29T10:00:00.000Z',
            depth: null,
            commonAncestorNumber: null,
            commonAncestorHash: null,
            status: 'MANUAL_REVIEW',
            orphanedEvents: 0,
            replayedEvents: 0,
          },
        };
      },
    },
  );

  await heartbeat.refresh(0);
  available = false;
  const snapshot = await heartbeat.refresh(0);

  assert.equal(snapshot.chain.state, 'MANUAL_REVIEW');
  assert.equal(snapshot.chain.stale, true);
  assert.equal(snapshot.chain.lastReorg?.status, 'MANUAL_REVIEW');
});

test('au démarrage à froid avec HTTP indisponible, expose les confirmations configurées sans inventer de tête canonique', async () => {
  const heartbeat = new HeartbeatService(
    createCheckpointStore(null) as unknown as CheckpointRepository,
    createSessionStore(0) as unknown as SessionRepository,
    {
      getHttpLatestBlock: async () => { throw new Error('RPC HTTP indisponible'); },
      getWsLatestBlock: async () => 125n,
    },
    'dry-run',
    undefined,
    {
      async getHealth(): Promise<ChainHealth> {
        throw new Error('La santé canonique ne peut pas être relue sans head HTTP');
      },
      confirmations: 5,
    },
  );

  const snapshot = await heartbeat.refresh(0);

  assert.deepEqual(snapshot.chain, {
    confirmations: 5,
    confirmedHead: null,
    canonicalBlockNumber: null,
    canonicalBlockHash: null,
    state: 'RECONCILING',
    stale: true,
    lastReorg: null,
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  return {
    promise: new Promise<T>((nextResolve, nextReject) => {
      resolve = nextResolve;
      reject = nextReject;
    }),
    resolve,
    reject,
  };
}

test('sérialise les refresh et laisse le second snapshot gagner après l’échec lent du premier', async () => {
  const firstCheckpoint = deferred<ListenerCheckpoint | null>();
  let checkpointCalls = 0;
  const heartbeat = new HeartbeatService(
    {
      async get(): Promise<ListenerCheckpoint | null> {
        checkpointCalls += 1;
        if (checkpointCalls === 1) return firstCheckpoint.promise;
        return null;
      },
    } as unknown as CheckpointRepository,
    createSessionStore(0) as unknown as SessionRepository,
    {
      getHttpLatestBlock: async () => 200n,
      getWsLatestBlock: async () => 200n,
    },
    'dry-run',
  );

  const first = heartbeat.refresh(1);
  const firstFailure = assert.rejects(first, /premier refresh échoué/u);
  const second = heartbeat.refresh(2);
  await Promise.resolve();
  assert.equal(checkpointCalls, 1);

  firstCheckpoint.reject(new Error('premier refresh échoué'));
  await firstFailure;
  const secondSnapshot = await second;

  assert.equal(secondSnapshot.latestBlock, '200');
  assert.equal(secondSnapshot.activeSwapMonitors, 2);
  assert.equal(heartbeat.currentSnapshot?.latestBlock, '200');
});
