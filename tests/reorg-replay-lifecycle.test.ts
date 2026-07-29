import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReorgRollbackImpact } from '../src/chain/canonical-chain.types.js';
import {
  finalizeShallowReorgReplay,
  resumePersistedShallowReorgReplay,
} from '../src/runtime/reorg-replay-lifecycle.js';
import type {
  ShallowReorgReplayDependencies,
} from '../src/runtime/reorg-replay-lifecycle.js';
import {
  ReorgReplayAdmissionGate,
  startSwapMonitorForAdmission,
} from '../src/runtime/reorg-monitor-admission.js';

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

  const dependencies: ShallowReorgReplayDependencies = {
    withReplayAdmission: (operation) => operation(),
    prepareRecoveredSessions: async () => { calls.push('prepare'); },
    activateRecoveredSessions: async () => { calls.push('activate'); },
    reconcilePairs: async () => { calls.push('pairs'); },
    waitForMonitorIdle: async () => { calls.push('idle'); },
    reconcileActiveSwaps: async () => { calls.push('swaps'); },
    countCanonicalProcessedEvents: async (eventIds) => {
      assert.deepEqual(eventIds, impact.orphanedEventIds);
      assert.deepEqual(calls, [
        'prepare',
        'pairs',
        'activate',
        'idle',
        'swaps',
        'idle',
      ]);
      calls.push('count');
      return 2;
    },
    completeReorg: async (reorgId, replayedEvents) => {
      assert.equal(reorgId, impact.reorgId);
      assert.equal(replayedEvents, 2);
      calls.push('complete');
    },
  };
  const replayedEvents = await finalizeShallowReorgReplay(
    impact,
    dependencies,
  );

  assert.equal(replayedEvents, 2);
  assert.deepEqual(calls, [
    'prepare',
    'pairs',
    'activate',
    'idle',
    'swaps',
    'idle',
    'count',
    'complete',
  ]);
});

test('un échec de replay ne finalise jamais un audit reorg', async () => {
  let finalized = false;

  await assert.rejects(
    finalizeShallowReorgReplay(impact, {
      withReplayAdmission: (operation) => operation(),
      prepareRecoveredSessions: async () => undefined,
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

test('un failedPairs pendant admission Swap interdit tout replay et RECOVERED', async () => {
  let pairReplay = false;
  let finalized = false;

  await assert.rejects(
    finalizeShallowReorgReplay(impact, {
      withReplayAdmission: (operation) => operation(),
      prepareRecoveredSessions: async () => undefined,
      activateRecoveredSessions: async () => ({
        failedPairs: ['0x1111111111111111111111111111111111111111'],
      }),
      reconcilePairs: async () => { pairReplay = true; },
      waitForMonitorIdle: async () => undefined,
      reconcileActiveSwaps: async () => undefined,
      countCanonicalProcessedEvents: async () => 0,
      completeReorg: async () => { finalized = true; },
    }),
    /listener.*Swap|admission/u,
  );

  assert.equal(pairReplay, true);
  assert.equal(finalized, false);
});

test('garde l’admission replay active pendant un onPair concurrent et démarre uniquement startForReplay', async () => {
  const gate = new ReorgReplayAdmissionGate();
  const starts: string[] = [];
  let concurrentStart: Promise<void> | null = null;
  const dependencies = {
    withReplayAdmission: <T>(operation: () => Promise<T>) =>
      gate.run(operation),
    prepareRecoveredSessions: async () => undefined,
    reconcilePairs: async () => {
      concurrentStart = Promise.resolve().then(() =>
        startSwapMonitorForAdmission({
          start: async () => { starts.push('normal'); },
          startForReplay: async () => { starts.push('replay'); },
        }, gate)
      );
    },
    activateRecoveredSessions: async () => {
      await concurrentStart;
      return { failedPairs: [] };
    },
    waitForMonitorIdle: async () => undefined,
    reconcileActiveSwaps: async () => undefined,
    countCanonicalProcessedEvents: async () => 0,
    completeReorg: async () => undefined,
  };

  await finalizeShallowReorgReplay(impact, dependencies);

  assert.deepEqual(starts, ['replay']);
  assert.equal(gate.isActive, false);
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
