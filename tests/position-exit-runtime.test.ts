import assert from 'node:assert/strict';
import test from 'node:test';
import { startPositionExitRuntime } from '../src/runtime/position-exit-runtime.js';

test('reprend les décisions puis réconcilie avant de démarrer les ticks', async () => {
  const order: string[] = [];
  await startPositionExitRuntime({
    reconcilePendingDecisions: async () => {
      order.push('pending');
    },
    reconcileNow: async () => {
      order.push('initial');
    },
    start: () => {
      order.push('start');
    },
  });
  assert.deepEqual(order, ['pending', 'initial', 'start']);
});
