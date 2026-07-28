import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ClaimedRecovery,
  RecoveryDecision,
  ReconciliationStore,
} from '../src/recovery/recovery.types.js';
import { RecoveryCoordinator } from '../src/recovery/recovery-coordinator.js';
import { RuntimeRecoveryBarrier } from '../src/recovery/runtime-recovery-barrier.js';

class MemoryStore implements ReconciliationStore {
  claims: ClaimedRecovery[] = [];
  lockResults: boolean[] = [];
  lockAcquired = 0;
  lockReleased = 0;

  async claimNext(): Promise<ClaimedRecovery | null> {
    return this.claims.shift() ?? null;
  }

  async applyDecision(
    _claimed: ClaimedRecovery,
    _decision: RecoveryDecision,
  ): Promise<void> {}

  async tryAcquirePassLock(): Promise<boolean> {
    this.lockAcquired += 1;
    return this.lockResults.shift() ?? true;
  }

  async releasePassLock(): Promise<void> {
    this.lockReleased += 1;
  }

  async getBacklogCounts(): Promise<{
    pendingSessions: number;
    manualReviewSessions: number;
  }> {
    return {
      pendingSessions: this.claims.length,
      manualReviewSessions: 0,
    };
  }
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('la barrière initiale attend la fin de la réconciliation', async () => {
  const store = new MemoryStore();
  store.claims.push({
    owner: 'worker',
    statusBefore: 'BUY_PENDING',
    snapshot: {
      session: {
        pair: { pair: '0x0000000000000000000000000000000000000001' },
      } as unknown as ClaimedRecovery['snapshot']['session'],
      trades: [],
      transactions: [],
    },
  });
  const gate = deferred();
  let completed = false;
  const coordinator = new RecoveryCoordinator(
    store,
    { reconcile: async () => gate.promise },
    { intervalMs: 30_000, leaseMs: 60_000, owner: 'worker' },
  );

  const initial = coordinator.reconcileInitial().then(() => {
    completed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(completed, false);

  gate.resolve();
  await initial;
  assert.equal(completed, true);
  assert.equal(store.lockReleased, 1);
});

test('deux déclenchements ne chevauchent jamais leurs passes', async () => {
  const store = new MemoryStore();
  const gate = deferred();
  let running = 0;
  let maxRunning = 0;
  store.claims.push({
    owner: 'worker',
    statusBefore: 'BUY_PENDING',
    snapshot: {
      session: {
        pair: { pair: '0x0000000000000000000000000000000000000001' },
      } as unknown as ClaimedRecovery['snapshot']['session'],
      trades: [],
      transactions: [],
    },
  });
  const coordinator = new RecoveryCoordinator(
    store,
    {
      reconcile: async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await gate.promise;
        running -= 1;
      },
    },
    { intervalMs: 30_000, leaseMs: 60_000, owner: 'worker' },
  );

  const first = coordinator.reconcileInitial();
  const second = coordinator.reconcileInitial();
  await new Promise<void>((resolve) => setImmediate(resolve));
  gate.resolve();
  await Promise.all([first, second]);

  assert.equal(maxRunning, 1);
  assert.equal(store.lockAcquired, 1);
});

test('la barrière initiale attend aussi le verrou détenu par une autre instance', async () => {
  const store = new MemoryStore();
  store.lockResults.push(false, true);
  const coordinator = new RecoveryCoordinator(
    store,
    { reconcile: async () => {} },
    {
      intervalMs: 30_000,
      leaseMs: 60_000,
      owner: 'worker',
      initialRetryMs: 1,
    },
  );

  const result = await coordinator.reconcileInitial();

  assert.equal(result.acquired, true);
  assert.equal(store.lockAcquired, 2);
  assert.equal(store.lockReleased, 1);
});

test('la passe périodique resynchronise les sessions même après une erreur', async () => {
  const store = new MemoryStore();
  store.claims.push({
    owner: 'worker',
    statusBefore: 'BUY_PENDING',
    snapshot: {
      session: {
        pair: { pair: '0x0000000000000000000000000000000000000001' },
      } as unknown as ClaimedRecovery['snapshot']['session'],
      trades: [],
      transactions: [],
    },
  });
  const synchronized = deferred();
  let synchronizationCalls = 0;
  let coordinator: RecoveryCoordinator;
  coordinator = new RecoveryCoordinator(
    store,
    {
      reconcile: async () => {
        const error = new Error('détail sensible');
        error.name = 'RpcUnavailableError';
        throw error;
      },
    },
    {
      intervalMs: 1,
      leaseMs: 60_000,
      owner: 'worker',
      onPeriodicPassCompleted: async () => {
        synchronizationCalls += 1;
        coordinator.stop();
        synchronized.resolve();
      },
    },
  );

  coordinator.start();
  await synchronized.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(synchronizationCalls, 1);
  assert.equal(coordinator.currentStatus.lastErrorType, 'RpcUnavailableError');
});

test('la passe attend que les opérations listener actives soient drainées', async () => {
  const store = new MemoryStore();
  const barrier = new RuntimeRecoveryBarrier();
  const listener = deferred();
  const listenerRun = barrier.runListener(() => listener.promise);
  const coordinator = new RecoveryCoordinator(
    store,
    { reconcile: async () => {} },
    { intervalMs: 30_000, leaseMs: 60_000, owner: 'worker' },
    barrier,
  );

  const initial = coordinator.reconcileInitial();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(store.lockAcquired, 0);

  listener.resolve();
  await listenerRun;
  await initial;
  assert.equal(store.lockAcquired, 1);
});
