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
