import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('termine la première réconciliation avant d’activer les listeners', async () => {
  const source = await readFile('src/app.ts', 'utf8');
  const activation = source.slice(
    source.indexOf('activateListeners: async () => {'),
    source.indexOf('cleanup:', source.indexOf('activateListeners: async () => {')),
  );
  assert.ok(
    activation.indexOf('await startPositionExitRuntime') <
      activation.indexOf('await pairListener.start()'),
  );
  assert.ok(
    activation.indexOf('await startPositionExitRuntime') <
      activation.indexOf('recovery.start()'),
  );
});
