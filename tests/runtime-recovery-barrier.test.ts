import assert from 'node:assert/strict';
import test from 'node:test';
import { RuntimeRecoveryBarrier } from '../src/recovery/runtime-recovery-barrier.js';

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

test('la reprise attend les opérations listener et bloque les nouvelles', async () => {
  const barrier = new RuntimeRecoveryBarrier();
  const firstListener = deferred();
  const recovery = deferred();
  const order: string[] = [];

  const listenerRun = barrier.runListener(async () => {
    order.push('listener-start');
    await firstListener.promise;
    order.push('listener-end');
  });
  const recoveryRun = barrier.runRecovery(async () => {
    order.push('recovery-start');
    await recovery.promise;
    order.push('recovery-end');
  });
  const secondListenerRun = barrier.runListener(async () => {
    order.push('listener-2');
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['listener-start']);
  firstListener.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['listener-start', 'listener-end', 'recovery-start']);
  recovery.resolve();
  await Promise.all([listenerRun, recoveryRun, secondListenerRun]);
  assert.deepEqual(order, [
    'listener-start',
    'listener-end',
    'recovery-start',
    'recovery-end',
    'listener-2',
  ]);
});

test('draine un listener obsolète seulement après la sortie de recovery', async () => {
  const barrier = new RuntimeRecoveryBarrier();
  const activeListener = deferred();
  const queuedListener = deferred();
  const recoveryGate = deferred();
  const order: string[] = [];

  const activeRun = barrier.runListener(async () => {
    order.push('active-listener');
    await activeListener.promise;
  });
  const recoverySection = barrier.runRecovery(async () => {
    order.push('recovery-start');
    order.push('monitor-stop');
    await recoveryGate.promise;
    order.push('recovery-end');
  });
  const queuedRun = barrier.runListener(async () => {
    order.push('queued-listener');
    await queuedListener.promise;
  });
  const recoveryRun = (async () => {
    await recoverySection;
    order.push('drain-start');
    await queuedRun;
    order.push('drain-end');
  })();

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['active-listener']);
  activeListener.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [
    'active-listener',
    'recovery-start',
    'monitor-stop',
  ]);
  recoveryGate.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, [
    'active-listener',
    'recovery-start',
    'monitor-stop',
    'recovery-end',
    'drain-start',
    'queued-listener',
  ]);
  queuedListener.resolve();
  await Promise.all([activeRun, recoveryRun]);
  assert.equal(order.at(-1), 'drain-end');
});

test('autorise un runListener imbriqué après la mise en attente d’une recovery', async () => {
  const barrier = new RuntimeRecoveryBarrier();
  const enterNested = deferred();
  const outerStarted = deferred();
  const recoveryGate = deferred();
  const order: string[] = [];

  const outerRun = barrier.runListener(async () => {
    order.push('outer-start');
    outerStarted.resolve();
    await enterNested.promise;
    await barrier.runListener(async () => {
      order.push('nested');
    });
    order.push('outer-end');
  });
  await outerStarted.promise;
  const recoveryRun = barrier.runRecovery(async () => {
    order.push('recovery-start');
    await recoveryGate.promise;
    order.push('recovery-end');
  });
  enterNested.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(order, [
    'outer-start',
    'nested',
    'outer-end',
    'recovery-start',
  ]);
  recoveryGate.resolve();
  await Promise.all([outerRun, recoveryRun]);
});

test('un contexte listener échappé ne contourne pas une recovery future', async () => {
  const barrier = new RuntimeRecoveryBarrier();
  const escapedGate = deferred();
  const recoveryStarted = deferred();
  const recoveryGate = deferred();
  const escapedEntered = deferred();
  let escapedRun: Promise<void> | null = null;

  await barrier.runListener(async () => {
    escapedRun = (async () => {
      await escapedGate.promise;
      await barrier.runListener(async () => {
        escapedEntered.resolve();
      });
    })();
  });
  const recoveryRun = barrier.runRecovery(async () => {
    recoveryStarted.resolve();
    await recoveryGate.promise;
  });
  await recoveryStarted.promise;
  escapedGate.resolve();
  let entered = false;
  void escapedEntered.promise.then(() => {
    entered = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(entered, false);
  recoveryGate.resolve();
  await Promise.all([recoveryRun, escapedRun]);
  assert.equal(entered, true);
});
