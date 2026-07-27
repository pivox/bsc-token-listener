import assert from 'node:assert/strict';
import test from 'node:test';
import { HeartbeatService } from '../src/heartbeat/heartbeat.js';
import type { CheckpointRepository, SessionRepository } from '../src/storage/repositories.js';

function createSessionStore(active: number): { countActive: () => Promise<number> } {
  return {
    async countActive(): Promise<number> {
      return active;
    },
  };
}

function createCheckpointStore(
  checkpoint: bigint | null,
): { get: (key: string) => Promise<bigint | null> } {
  return {
    async get(_key: string): Promise<bigint | null> {
      return checkpoint;
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
  );

  const snapshot = await heartbeat.refresh(2);

  assert.equal(snapshot.executionMode, 'dry-run');
  assert.equal(snapshot.latestBlock, '12345');
  assert.equal(snapshot.pairCreatedCheckpoint, '3456');
  assert.equal(snapshot.activeSwapMonitors, 2);
  assert.equal(snapshot.activeSessions, 4);
  assert.equal(snapshot.http.status, 'up');
  assert.equal(snapshot.webSocket.status, 'up');
  assert.equal(snapshot.http.blockNumber, '12345');
  assert.equal(snapshot.webSocket.blockNumber, '12346');
  assert.equal(snapshot.http.error, null);
  assert.equal(snapshot.webSocket.error, null);
  assert.equal(heartbeat.currentSnapshot?.activeSessions, 4);
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
