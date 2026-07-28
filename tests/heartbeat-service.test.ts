import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hash } from 'viem';
import type { ListenerCheckpoint } from '../src/chain/canonical-chain.types.js';
import { HeartbeatService } from '../src/heartbeat/heartbeat.js';
import type { CheckpointRepository, SessionRepository } from '../src/storage/repositories.js';

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
  const heartbeat = new HeartbeatService(
    createCheckpointStore(3_456n) as unknown as CheckpointRepository,
    createSessionStore(4) as unknown as SessionRepository,
    {
      getHttpLatestBlock: async () => 12_345n,
      getWsLatestBlock: async () => 12_346n,
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
