import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import type { ReorgRollbackImpact } from '../src/chain/canonical-chain.types.js';
import { MonitorScheduler } from '../src/monitoring/monitor-scheduler.js';
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
import type { TokenSession } from '../src/types/domain.js';

const impact: ReorgRollbackImpact = {
  reorgId: 'reorg-1',
  depth: 1,
  orphanedEvents: 2,
  replayedEvents: 0,
  orphanedEventIds: ['event-1', 'event-2'],
  affectedPairs: [],
};

const REPLAY_ADDRESS = `0x${'1'.repeat(40)}` as Address;
const REPLAY_BLOCK_HASH = `0x${'2'.repeat(64)}` as Hash;

function replaySession(): TokenSession {
  return {
    pair: {
      factory: REPLAY_ADDRESS,
      router: REPLAY_ADDRESS,
      wbnb: REPLAY_ADDRESS,
      pair: REPLAY_ADDRESS,
      token: REPLAY_ADDRESS,
      token0: REPLAY_ADDRESS,
      token1: REPLAY_ADDRESS,
      createdBlock: 1n,
      blockHash: REPLAY_BLOCK_HASH,
      createdTransactionHash: REPLAY_BLOCK_HASH,
      createdLogIndex: 0,
      discoveredAtMs: 1,
    },
    metadata: {
      address: REPLAY_ADDRESS,
      name: null,
      symbol: null,
      decimals: 18,
      totalSupply: 1n,
      codeSizeBytes: 1,
    },
    status: 'WAITING_FIRST_BUY',
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

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
        'idle',
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
    'idle',
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
  let concurrentStart: Promise<boolean> | null = null;
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

test('draine une passe scheduler externe puis remonte les failedPairs du replay interne', async () => {
  const gate = new ReorgReplayAdmissionGate();
  const starts: string[] = [];
  const session = replaySession();
  const address = session.pair.pair;
  const activePairs = new Set<string>();
  let signalExternalLoad!: () => void;
  const externalLoadStarted = new Promise<void>((resolve) => {
    signalExternalLoad = resolve;
  });
  let releaseExternalLoad!: () => void;
  const externalLoadReleased = new Promise<void>((resolve) => {
    releaseExternalLoad = resolve;
  });
  let firstLoad = true;
  const scheduler = new MonitorScheduler({
    capacity: 1,
    ttlMs: 60_000,
    now: () => 1,
    loadSessions: async () => {
      if (firstLoad) {
        firstLoad = false;
        signalExternalLoad();
        await externalLoadReleased;
      }
      return [structuredClone(session)];
    },
    loadSession: async () => structuredClone(session),
    activePairs: () => [...activePairs],
    isIgnored: async () => false,
    expire: async () => undefined,
    ignore: async () => undefined,
    canStart: () => gate.canStartMonitor(true),
    start: async () => {
      await startSwapMonitorForAdmission({
        start: async () => { starts.push('normal'); },
        startForReplay: async () => {
          starts.push('replay');
          throw new Error('replay listener unavailable');
        },
      }, gate);
      activePairs.add(address);
    },
    stop: async () => undefined,
  });
  let signalFirstAdmissionStep!: (step: 'idle' | 'activate') => void;
  const firstAdmissionStep = new Promise<'idle' | 'activate'>((resolve) => {
    signalFirstAdmissionStep = resolve;
  });
  let admissionStepSignaled = false;
  const signalAdmissionStep = (step: 'idle' | 'activate'): void => {
    if (admissionStepSignaled) return;
    admissionStepSignaled = true;
    signalFirstAdmissionStep(step);
  };
  let finalized = false;

  const externalPass = scheduler.reconcile();
  await externalLoadStarted;
  const finalization = finalizeShallowReorgReplay(impact, {
    withReplayAdmission: (operation) => gate.run(operation),
    prepareRecoveredSessions: async () => undefined,
    reconcilePairs: async () => undefined,
    activateRecoveredSessions: async () => {
      signalAdmissionStep('activate');
      assert.equal(gate.isActive, true);
      return scheduler.reconcile();
    },
    waitForMonitorIdle: () => {
      signalAdmissionStep('idle');
      return scheduler.waitForIdle();
    },
    reconcileActiveSwaps: async () => undefined,
    countCanonicalProcessedEvents: async () => 0,
    completeReorg: async () => { finalized = true; },
  });

  const firstStep = await firstAdmissionStep;
  assert.equal(gate.isActive, false);
  assert.equal(gate.canStartMonitor(true), false);
  releaseExternalLoad();
  await Promise.all([
    externalPass,
    assert.rejects(finalization, /Admission de 1 listener/u),
  ]);

  assert.equal(firstStep, 'idle');
  assert.deepEqual(starts, ['replay']);
  assert.equal(finalized, false);
});

test('revalide le gate entre canStart et start sans faux failedPair externe', async () => {
  const gate = new ReorgReplayAdmissionGate();
  const session = replaySession();
  const activePairs = new Set<string>();
  const starts: string[] = [];
  let signalExternalLoadSession!: () => void;
  const externalLoadSessionStarted = new Promise<void>((resolve) => {
    signalExternalLoadSession = resolve;
  });
  let releaseExternalLoadSession!: () => void;
  const externalLoadSessionReleased = new Promise<void>((resolve) => {
    releaseExternalLoadSession = resolve;
  });
  let firstLoadSession = true;
  const scheduler = new MonitorScheduler({
    capacity: 1,
    ttlMs: 60_000,
    now: () => 1,
    loadSessions: async () => [structuredClone(session)],
    loadSession: async () => {
      if (firstLoadSession) {
        firstLoadSession = false;
        signalExternalLoadSession();
        await externalLoadSessionReleased;
      }
      return structuredClone(session);
    },
    activePairs: () => [...activePairs],
    isIgnored: async () => false,
    expire: async () => undefined,
    ignore: async () => undefined,
    canStart: () => gate.canStartMonitor(true),
    start: async () => {
      const started = await startSwapMonitorForAdmission({
        start: async () => { starts.push('normal'); },
        startForReplay: async () => { starts.push('replay'); },
      }, gate);
      if (!started) return false;
      activePairs.add(session.pair.pair);
      return true;
    },
    stop: async () => undefined,
  });
  let signalFinalizing!: () => void;
  const finalizingStarted = new Promise<void>((resolve) => {
    signalFinalizing = resolve;
  });
  let finalized = false;

  const externalPass = scheduler.reconcile();
  await externalLoadSessionStarted;
  const finalization = finalizeShallowReorgReplay(impact, {
    withReplayAdmission: (operation) => gate.run(operation),
    prepareRecoveredSessions: async () => { signalFinalizing(); },
    reconcilePairs: async () => undefined,
    activateRecoveredSessions: () => scheduler.reconcile(),
    waitForMonitorIdle: () => scheduler.waitForIdle(),
    reconcileActiveSwaps: async () => undefined,
    countCanonicalProcessedEvents: async () => 0,
    completeReorg: async () => { finalized = true; },
  });

  await finalizingStarted;
  assert.equal(gate.isFinalizing, true);
  assert.equal(gate.isActive, false);
  releaseExternalLoadSession();
  const externalResult = await externalPass;
  await finalization;

  assert.deepEqual(externalResult.failedPairs, []);
  assert.deepEqual(starts, ['replay']);
  assert.equal(finalized, true);
});

test('annule un start externe déjà queued avant finalisation puis rejoue en scope interne', async () => {
  const gate = new ReorgReplayAdmissionGate();
  const session = replaySession();
  const activePairs = new Set<string>();
  const starts: string[] = [];
  let signalExternalStartEntered!: () => void;
  const externalStartEntered = new Promise<void>((resolve) => {
    signalExternalStartEntered = resolve;
  });
  let releaseQueuedTurn!: () => void;
  const queuedTurn = new Promise<void>((resolve) => {
    releaseQueuedTurn = resolve;
  });
  let queuedContinuation: Promise<void> = Promise.resolve();
  let externalSignal: AbortSignal | null = null;
  let externalBusinessExecutions = 0;
  const monitor = {
    start: async (options?: { signal?: AbortSignal }) => {
      externalSignal = options?.signal ?? null;
      signalExternalStartEntered();
      if (!externalSignal) return;
      queuedContinuation = queuedTurn.then(() => {
        if (!externalSignal?.aborted) externalBusinessExecutions += 1;
      });
      if (externalSignal.aborted) return;
      await new Promise<void>((resolve) => {
        externalSignal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
    },
    startForReplay: async () => { starts.push('replay'); },
  };
  const scheduler = new MonitorScheduler({
    capacity: 1,
    ttlMs: 60_000,
    now: () => 1,
    loadSessions: async () => [structuredClone(session)],
    loadSession: async () => structuredClone(session),
    activePairs: () => [...activePairs],
    isIgnored: async () => false,
    expire: async () => undefined,
    ignore: async () => undefined,
    canStart: () => gate.canStartMonitor(true),
    start: async () => {
      const started = await startSwapMonitorForAdmission(monitor, gate);
      if (!started) return false;
      activePairs.add(session.pair.pair);
      return true;
    },
    stop: async () => undefined,
  });
  let finalized = false;

  const externalPass = scheduler.reconcile();
  await externalStartEntered;
  const finalization = finalizeShallowReorgReplay(impact, {
    withReplayAdmission: (operation) => gate.run(operation),
    prepareRecoveredSessions: async () => undefined,
    reconcilePairs: async () => undefined,
    activateRecoveredSessions: () => scheduler.reconcile(),
    waitForMonitorIdle: () => scheduler.waitForIdle(),
    reconcileActiveSwaps: async () => undefined,
    countCanonicalProcessedEvents: async () => 0,
    completeReorg: async () => { finalized = true; },
  });

  const externalResult = await externalPass;
  await finalization;
  releaseQueuedTurn();
  await queuedContinuation;

  assert.notEqual(externalSignal, null);
  assert.equal((externalSignal as AbortSignal | null)?.aborted, true);
  assert.deepEqual(externalResult.failedPairs, []);
  assert.deepEqual(starts, ['replay']);
  assert.equal(finalized, true);
  assert.equal(externalBusinessExecutions, 0);
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
