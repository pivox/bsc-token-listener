import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReorgRollbackImpact } from '../src/chain/canonical-chain.types.js';
import {
  finalizeShallowReorgReplay,
  resumePersistedShallowReorgReplay,
} from '../src/runtime/reorg-replay-lifecycle.js';

const impact: ReorgRollbackImpact = {
  reorgId: 'reorg-1',
  depth: 1,
  orphanedEvents: 2,
  replayedEvents: 0,
  orphanedEventIds: ['event-1', 'event-2'],
  affectedPairs: [],
};

test('finalise un reorg shallow seulement après les replays Pair puis Swap et leurs gates', async () => {
  const calls: string[] = [];

  const replayedEvents = await finalizeShallowReorgReplay(impact, {
    activateRecoveredSessions: async () => { calls.push('activate'); },
    reconcilePairs: async () => { calls.push('pairs'); },
    waitForMonitorIdle: async () => { calls.push('idle'); },
    reconcileActiveSwaps: async () => { calls.push('swaps'); },
    countCanonicalProcessedEvents: async (eventIds) => {
      assert.deepEqual(eventIds, impact.orphanedEventIds);
      assert.deepEqual(calls, ['activate', 'pairs', 'idle', 'swaps', 'idle']);
      calls.push('count');
      return 2;
    },
    completeReorg: async (reorgId, replayedEvents) => {
      assert.equal(reorgId, impact.reorgId);
      assert.equal(replayedEvents, 2);
      calls.push('complete');
    },
  });

  assert.equal(replayedEvents, 2);
  assert.deepEqual(calls, ['activate', 'pairs', 'idle', 'swaps', 'idle', 'count', 'complete']);
});

test('un échec de replay ne finalise jamais un audit reorg', async () => {
  let finalized = false;

  await assert.rejects(
    finalizeShallowReorgReplay(impact, {
      activateRecoveredSessions: async () => undefined,
      reconcilePairs: async () => { throw new Error('pair replay failed'); },
      waitForMonitorIdle: async () => undefined,
      reconcileActiveSwaps: async () => undefined,
      countCanonicalProcessedEvents: async () => 2,
      completeReorg: async () => { finalized = true; },
    }),
    /pair replay failed/u,
  );

  assert.equal(finalized, false);
});

test('au restart après rewind seul, réconcilie les projections avant replay et finalisation', async () => {
  const calls: string[] = [];

  const result = await resumePersistedShallowReorgReplay(impact, {
    reconcileProjections: async (rollback) => {
      assert.equal(rollback, impact);
      calls.push('projections');
    },
    replayAndFinalize: async (rollback) => {
      assert.equal(rollback, impact);
      calls.push('replay');
      return 2;
    },
  });

  assert.equal(result, 2);
  assert.deepEqual(calls, ['projections', 'replay']);
});

test('un échec de réconciliation des projections interdit replay et RECOVERED', async () => {
  let replayed = false;

  await assert.rejects(
    resumePersistedShallowReorgReplay(impact, {
      reconcileProjections: async () => {
        throw new Error('projection recovery failed');
      },
      replayAndFinalize: async () => {
        replayed = true;
        return 2;
      },
    }),
    /projection recovery failed/u,
  );

  assert.equal(replayed, false);
});

test('un rollback hydraté avec conséquence wallet devient manuel sans replay ni RECOVERED', async () => {
  const walletImpact: ReorgRollbackImpact = {
    ...impact,
    affectedPairs: [{
      pairAddress: '0x1111111111111111111111111111111111111111',
      discoveryOrphaned: false,
      earliestSessionBefore: null,
      latestCanonicalSessionAfter: null,
      hasWalletConsequence: true,
    }],
  };
  const calls: string[] = [];

  const result = await resumePersistedShallowReorgReplay(walletImpact, {
    reconcileProjections: async () => { calls.push('projections'); },
    requireManualReview: async (reorgId) => {
      assert.equal(reorgId, walletImpact.reorgId);
      calls.push('manual');
    },
    replayAndFinalize: async () => {
      calls.push('replay');
      return 1;
    },
  });

  assert.equal(result, null);
  assert.deepEqual(calls, ['projections', 'manual']);
});
