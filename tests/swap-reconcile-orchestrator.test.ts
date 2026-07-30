import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address } from 'viem';
import { SwapReconcileOrchestrator } from '../src/monitoring/swap-reconcile-orchestrator.js';

interface TimerHandle {
  callback: () => void;
  ms: number;
  cleared: boolean;
}

interface DeferredBarrier {
  promise: Promise<void>;
  resolve: () => void;
}

interface ReconcileTarget {
  pair: Address;
  calls: number;
  reconcileNow: () => Promise<void>;
}

function createDeferredBarrier(): DeferredBarrier {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createFakeTimer() {
  const handles: TimerHandle[] = [];
  return {
    handles,
    setInterval: (callback: () => void, ms: number): TimerHandle => {
      const handle = { callback, ms, cleared: false };
      handles.push(handle);
      return handle;
    },
    clearInterval: (handle: TimerHandle): void => {
      handle.cleared = true;
    },
  };
}

function createOrchestrator(
  canRun = (): boolean => true,
  timer = createFakeTimer(),
): SwapReconcileOrchestrator {
  return new SwapReconcileOrchestrator({
    intervalMs: 15_000,
    canRun,
    onError: () => {
      throw new Error('reconcile listener échoué');
    },
    setInterval: timer.setInterval as unknown as typeof setInterval,
    clearInterval: timer.clearInterval as unknown as typeof clearInterval,
  });
}

function createTarget(pair: Address): ReconcileTarget {
  return {
    pair,
    calls: 0,
    reconcileNow: async () => {},
  };
}

for (const pairCount of [0, 1, 10, 50]) {
  test(`un seul timer périodique est créé pour ${pairCount} paires`, () => {
    const timer = createFakeTimer();
    const orchestrator = createOrchestrator(() => true, timer);
    const allPairs = Array.from({ length: pairCount }, (_, index) =>
      `0x${String(index).padStart(40, '0')}` as Address,
    );

    for (const pair of allPairs) {
      orchestrator.register(createTarget(pair));
    }

    orchestrator.start();
    orchestrator.start();

    assert.equal(timer.handles.length, 1);
  });
}

test('plusieurs signaux WS proches sont coalisés en un seul passage', async () => {
  const timer = createFakeTimer();
  const orchestrator = createOrchestrator(() => true, timer);
  const target = createTarget('0x1111111111111111111111111111111111111111' as Address);
  orchestrator.register(target);
  orchestrator.start();

  target.reconcileNow = async () => {
    target.calls += 1;
  };

  orchestrator.signal(target.pair);
  orchestrator.signal(target.pair);
  orchestrator.signal(target.pair);
  await orchestrator.waitForIdle();

  assert.equal(target.calls, 1);
});

test('un signal reçu pendant un passage provoque exactement un passage supplémentaire', async () => {
  const barrier = createDeferredBarrier();
  const timer = createFakeTimer();
  const orchestrator = createOrchestrator(() => true, timer);
  const target = createTarget('0x1111111111111111111111111111111111111111' as Address);

  target.reconcileNow = async () => {
    target.calls += 1;
    await barrier.promise;
  };

  orchestrator.register(target);
  orchestrator.start();

  orchestrator.signal(target.pair);
  await Promise.resolve();
  orchestrator.signal(target.pair);
  barrier.resolve();
  await orchestrator.waitForIdle();

  assert.equal(target.calls, 2);
});

test('deux passages centraux ne s’exécutent jamais simultanément', async () => {
  const barrier = createDeferredBarrier();
  const timer = createFakeTimer();
  const orchestrator = createOrchestrator(() => true, timer);
  let inFlight = 0;
  let maxInFlight = 0;
  const target = createTarget('0x2222222222222222222222222222222222222222' as Address);

  target.reconcileNow = async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await barrier.promise;
    } finally {
      inFlight -= 1;
      target.calls += 1;
    }
  };

  orchestrator.register(target);
  orchestrator.start();

  orchestrator.signal(target.pair);
  await Promise.resolve();
  orchestrator.signal(target.pair);
  barrier.resolve();
  await orchestrator.waitForIdle();

  assert.equal(maxInFlight, 1);
  assert.equal(target.calls, 2);
});

test('une paire ajoutée pendant un passage est traitée au passage suivant', async () => {
  const firstBarrier = createDeferredBarrier();
  const secondBarrier = createDeferredBarrier();
  const timer = createFakeTimer();
  const orchestrator = createOrchestrator(() => true, timer);

  const first = createTarget('0x1111111111111111111111111111111111111111' as Address);
  const second = createTarget('0x2222222222222222222222222222222222222222' as Address);

  first.reconcileNow = async () => {
    first.calls += 1;
    await firstBarrier.promise;
  };
  second.reconcileNow = async () => {
    second.calls += 1;
    await secondBarrier.promise;
  };

  orchestrator.register(first);
  orchestrator.start();
  orchestrator.signal(first.pair);
  await Promise.resolve();

  orchestrator.register(second);
  orchestrator.signal(second.pair);

  firstBarrier.resolve();
  secondBarrier.resolve();
  await orchestrator.waitForIdle();

  assert.equal(first.calls, 1);
  assert.equal(second.calls, 1);
});

test('un retrait pendant un passage empêche tout traitement ultérieur après drain', async () => {
  const barrier = createDeferredBarrier();
  const timer = createFakeTimer();
  const orchestrator = createOrchestrator(() => true, timer);
  const target = createTarget('0x3333333333333333333333333333333333333333' as Address);

  target.reconcileNow = async () => {
    target.calls += 1;
    await barrier.promise;
  };

  orchestrator.register(target);
  orchestrator.start();
  orchestrator.signal(target.pair);
  await Promise.resolve();

  orchestrator.unregister(target.pair);
  orchestrator.signal(target.pair);

  barrier.resolve();
  await orchestrator.waitForIdle();

  assert.equal(target.calls, 1);
});

test('l’arrêt global draine le passage en cours et empêche un passage supplémentaire', async () => {
  const barrier = createDeferredBarrier();
  const timer = createFakeTimer();
  const orchestrator = createOrchestrator(() => true, timer);
  const target = createTarget('0x4444444444444444444444444444444444444444' as Address);

  target.reconcileNow = async () => {
    target.calls += 1;
    await barrier.promise;
  };

  orchestrator.register(target);
  orchestrator.start();

  orchestrator.signal(target.pair);
  await Promise.resolve();
  orchestrator.signal(target.pair);

  const stop = orchestrator.stopAndDrain();
  barrier.resolve();
  await stop;

  assert.equal(target.calls, 1);
  assert.equal(timer.handles.some((handle) => handle.cleared), true);
});

test('un signal reçu après arrêt global n’est jamais exécuté', async () => {
  const barrier = createDeferredBarrier();
  const timer = createFakeTimer();
  const orchestrator = createOrchestrator(() => true, timer);
  const target = createTarget('0x5555555555555555555555555555555555555555' as Address);

  target.reconcileNow = async () => {
    target.calls += 1;
    await barrier.promise;
  };

  orchestrator.register(target);
  orchestrator.start();

  orchestrator.stop();
  orchestrator.signal(target.pair);
  barrier.resolve();
  await orchestrator.waitForIdle();

  assert.equal(target.calls, 0);
});
