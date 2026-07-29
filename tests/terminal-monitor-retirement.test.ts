import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address } from 'viem';
import { retireTerminalMonitor } from '../src/runtime/terminal-monitor-retirement.js';

const PAIR = `0x${'1'.repeat(40)}` as Address;

test('draine puis supprime le checkpoint avant de libérer la capacité terminale', async () => {
  const calls: string[] = [];

  await retireTerminalMonitor(PAIR, {
    stopAndDrain: async () => { calls.push('drain'); },
    deleteCheckpoint: async (key) => { calls.push(`delete:${key}`); },
    releaseCapacity: () => { calls.push('release'); },
  });

  assert.deepEqual(calls, [
    'drain',
    `delete:swap:${PAIR.toLowerCase()}`,
    'release',
  ]);
});

test('un échec de suppression checkpoint conserve la capacité réservée', async () => {
  let released = false;

  await assert.rejects(
    retireTerminalMonitor(PAIR, {
      stopAndDrain: async () => undefined,
      deleteCheckpoint: async () => {
        throw new Error('database unavailable');
      },
      releaseCapacity: () => { released = true; },
    }),
    /database unavailable/u,
  );

  assert.equal(released, false);
});
