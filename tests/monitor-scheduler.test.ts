import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import {
  MonitorScheduler,
  compareMonitorPriority,
} from '../src/monitoring/monitor-scheduler.js';
import type { TokenSession } from '../src/types/domain.js';

const TOKEN = `0x${'1'.repeat(40)}` as Address;
const HASH = `0x${'2'.repeat(64)}` as Hash;

function session(
  id: string,
  status: TokenSession['status'],
  createdAtMs: number,
): TokenSession {
  const pair = `0x${id.padStart(40, '0')}` as Address;
  return {
    pair: {
      factory: TOKEN,
      router: TOKEN,
      wbnb: TOKEN,
      pair,
      token: pair,
      token0: TOKEN,
      token1: pair,
      createdBlock: 1n,
      blockHash: HASH,
      createdTransactionHash: HASH,
      createdLogIndex: 0,
      discoveredAtMs: createdAtMs,
    },
    metadata: {
      address: pair,
      name: id,
      symbol: id,
      decimals: 18,
      totalSupply: 1_000n,
      codeSizeBytes: 1,
    },
    status,
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs,
    updatedAtMs: createdAtMs,
  };
}

class Harness {
  sessions: TokenSession[] = [];
  readonly active = new Set<string>();
  readonly starts: string[] = [];
  readonly stops: string[] = [];
  readonly expired: string[] = [];
  readonly ignored = new Set<string>();
  readonly ignoredSessions: string[] = [];
  readonly startFailures = new Set<string>();
  allowStart = true;
  startBarrier: Promise<void> | null = null;
  onStart: (() => void) | null = null;
  stopBarrier: Promise<void> | null = null;
  onStop: (() => void) | null = null;
  onLoadSession: (() => void) | null = null;

  scheduler(capacity = 1, now = 10_000): MonitorScheduler {
    return new MonitorScheduler({
      capacity,
      ttlMs: 1_000,
      now: () => now,
      loadSessions: async () => this.sessions.map((value) => structuredClone(value)),
      loadSession: async (pair) => {
        this.onLoadSession?.();
        const value = this.sessions.find(
          (session) => session.pair.pair.toLowerCase() === pair.toLowerCase(),
        );
        return value ? structuredClone(value) : null;
      },
      activePairs: () => [...this.active],
      isIgnored: async (token) => this.ignored.has(token.toLowerCase()),
      expire: async (value) => {
        this.expired.push(value.pair.pair);
        this.sessions = this.sessions.filter(
          (candidate) => candidate.pair.pair !== value.pair.pair,
        );
      },
      ignore: async (value) => {
        this.ignoredSessions.push(value.pair.pair);
        this.sessions = this.sessions.filter(
          (candidate) => candidate.pair.pair !== value.pair.pair,
        );
      },
      canStart: () => this.allowStart,
      start: async (value) => {
        this.starts.push(value.pair.pair);
        this.onStart?.();
        if (this.startBarrier) await this.startBarrier;
        if (this.startFailures.has(value.pair.pair)) {
          throw new Error('listener indisponible');
        }
        this.active.add(value.pair.pair);
      },
      stop: async (pair) => {
        this.stops.push(pair);
        this.onStop?.();
        if (this.stopBarrier) await this.stopBarrier;
        this.active.delete(pair);
      },
    });
  }
}

test('ordonne HOLDING avant WAITING puis par ancienneté', () => {
  const values = [
    session('3', 'WAITING_FIRST_BUY', 3),
    session('2', 'HOLDING', 2),
    session('1', 'HOLDING', 1),
    session('4', 'WAITING_FIRST_BUY', 1),
  ];

  values.sort(compareMonitorPriority);

  assert.deepEqual(values.map((value) => value.metadata.name), ['1', '2', '4', '3']);
});

test('admet immédiatement lorsque la capacité est disponible', async () => {
  const harness = new Harness();
  harness.sessions = [session('1', 'WAITING_FIRST_BUY', 9_500)];
  const scheduler = harness.scheduler();

  await scheduler.reconcile();

  assert.equal(harness.starts.length, 1);
  assert.equal(scheduler.currentStatus.activeMonitors, 1);
  assert.equal(scheduler.currentStatus.waitingSessions, 0);
});

test('conserve la paire en attente lorsque la capacité est saturée', async () => {
  const harness = new Harness();
  harness.sessions = [
    session('1', 'HOLDING', 9_500),
    session('2', 'WAITING_FIRST_BUY', 9_600),
  ];
  harness.active.add(harness.sessions[0]!.pair.pair);
  const scheduler = harness.scheduler();

  await scheduler.reconcile();

  assert.deepEqual(harness.starts, []);
  assert.equal(scheduler.currentStatus.waitingSessions, 1);
  assert.equal(scheduler.currentStatus.oldestWaitingAgeMs, 400);
});

test('admet la prochaine paire après libération de capacité', async () => {
  const harness = new Harness();
  harness.sessions = [
    session('1', 'HOLDING', 9_500),
    session('2', 'WAITING_FIRST_BUY', 9_600),
  ];
  harness.active.add(harness.sessions[0]!.pair.pair);
  const scheduler = harness.scheduler();
  await scheduler.reconcile();

  const waitingPair = harness.sessions[1]!.pair.pair;
  harness.active.clear();
  harness.sessions = [harness.sessions[1]!];
  await scheduler.reconcile();

  assert.deepEqual(harness.starts, [waitingPair]);
});

test('ne démarre jamais deux fois la même paire', async () => {
  const harness = new Harness();
  harness.sessions = [session('1', 'WAITING_FIRST_BUY', 9_500)];
  const scheduler = harness.scheduler();

  await Promise.all([
    scheduler.reconcile(),
    scheduler.reconcile(),
    scheduler.reconcile(),
  ]);

  assert.equal(harness.starts.length, 1);
});

test('bloque les admissions tant que le démarrage des listeners est interdit', async () => {
  const harness = new Harness();
  harness.sessions = [session('1', 'WAITING_FIRST_BUY', 9_500)];
  harness.allowStart = false;
  const scheduler = harness.scheduler();

  await scheduler.reconcile();
  assert.deepEqual(harness.starts, []);

  harness.allowStart = true;
  await scheduler.reconcile();
  assert.equal(harness.starts.length, 1);
});

test('expire une session en attente sans moniteur', async () => {
  const harness = new Harness();
  harness.sessions = [session('1', 'WAITING_FIRST_BUY', 1)];
  const scheduler = harness.scheduler();

  await scheduler.reconcile();

  assert.equal(harness.expired.length, 1);
  assert.equal(harness.starts.length, 0);
});

test('laisse le listener actif sérialiser sa propre expiration', async () => {
  const harness = new Harness();
  const waiting = session('1', 'WAITING_FIRST_BUY', 1);
  harness.sessions = [waiting];
  harness.active.add(waiting.pair.pair);
  const scheduler = harness.scheduler();

  await scheduler.reconcile();

  assert.deepEqual(harness.expired, []);
  assert.deepEqual(harness.stops, []);
  assert.equal(scheduler.currentStatus.activeMonitors, 1);
});

test('retire immédiatement un actif ignoré pendant l’attente', async () => {
  const harness = new Harness();
  const waiting = session('1', 'WAITING_FIRST_BUY', 9_500);
  harness.sessions = [waiting];
  harness.ignored.add(waiting.pair.token.toLowerCase());
  const scheduler = harness.scheduler();

  await scheduler.reconcile();

  assert.deepEqual(harness.ignoredSessions, [waiting.pair.pair]);
  assert.equal(harness.starts.length, 0);
});

test('revalide un actif ignoré juste avant son admission', async () => {
  const harness = new Harness();
  const waiting = session('1', 'WAITING_FIRST_BUY', 9_500);
  harness.sessions = [waiting];
  harness.onLoadSession = () => {
    harness.ignored.add(waiting.pair.token.toLowerCase());
  };
  const scheduler = harness.scheduler();

  await scheduler.reconcile();

  assert.deepEqual(harness.starts, []);
  assert.deepEqual(harness.ignoredSessions, [waiting.pair.pair]);
});

test('retire immédiatement un moniteur dont la session est terminale', async () => {
  const harness = new Harness();
  const closed = session('1', 'CLOSED', 9_500);
  harness.sessions = [closed];
  harness.active.add(closed.pair.pair);
  const scheduler = harness.scheduler();

  await scheduler.reconcile();

  assert.deepEqual(harness.stops, [closed.pair.pair]);
  assert.equal(scheduler.currentStatus.activeMonitors, 0);
  assert.equal(scheduler.currentStatus.waitingSessions, 0);
});

test('préserve la capacité pendant une entrée en cours', async () => {
  const harness = new Harness();
  const entering = session('1', 'RISK_CHECKING', 9_500);
  const waiting = session('2', 'WAITING_FIRST_BUY', 9_600);
  harness.sessions = [entering, waiting];
  harness.active.add(entering.pair.pair);
  const scheduler = harness.scheduler();

  await scheduler.reconcile();

  assert.deepEqual(harness.stops, []);
  assert.deepEqual(harness.starts, []);
  assert.equal(scheduler.currentStatus.activeMonitors, 1);
  assert.equal(scheduler.currentStatus.waitingSessions, 1);

  entering.status = 'HOLDING';
  await scheduler.reconcile();

  assert.deepEqual(harness.stops, []);
  assert.deepEqual(harness.starts, []);
});

test('reconstruit la file au redémarrage', async () => {
  const harness = new Harness();
  harness.sessions = [
    session('2', 'WAITING_FIRST_BUY', 9_600),
    session('1', 'WAITING_FIRST_BUY', 9_500),
  ];

  await harness.scheduler(2).reconcile();

  assert.deepEqual(harness.starts, [
    harness.sessions[1]!.pair.pair,
    harness.sessions[0]!.pair.pair,
  ]);
});

test('continue après une erreur de démarrage et expose l’abandon', async () => {
  const harness = new Harness();
  harness.sessions = [
    session('1', 'WAITING_FIRST_BUY', 9_500),
    session('2', 'WAITING_FIRST_BUY', 9_600),
  ];
  harness.startFailures.add(harness.sessions[0]!.pair.pair);
  const scheduler = harness.scheduler(1);

  const result = await scheduler.reconcile();

  assert.deepEqual(harness.starts, [
    harness.sessions[0]!.pair.pair,
    harness.sessions[1]!.pair.pair,
  ]);
  assert.equal(scheduler.currentStatus.abandonedSessions, 1);
  assert.equal(scheduler.currentStatus.activeMonitors, 1);
  assert.deepEqual(result.failedPairs, [harness.sessions[0]!.pair.pair]);
});

test('réserve la capacité après l’échec d’une position HOLDING', async () => {
  const harness = new Harness();
  harness.sessions = [
    session('1', 'HOLDING', 9_500),
    session('2', 'WAITING_FIRST_BUY', 9_600),
  ];
  harness.startFailures.add(harness.sessions[0]!.pair.pair);
  const scheduler = harness.scheduler(1);

  await scheduler.reconcile();

  assert.deepEqual(harness.starts, [harness.sessions[0]!.pair.pair]);
  assert.equal(scheduler.currentStatus.abandonedSessions, 1);
  assert.equal(scheduler.currentStatus.activeMonitors, 0);
  assert.equal(scheduler.currentStatus.waitingSessions, 2);
});

test('préempte une observation pour une position HOLDING', async () => {
  const harness = new Harness();
  const observation = session('1', 'WAITING_FIRST_BUY', 9_500);
  const holding = session('2', 'HOLDING', 9_600);
  harness.sessions = [observation, holding];
  harness.active.add(observation.pair.pair);
  const scheduler = harness.scheduler(1);

  await scheduler.reconcile();

  assert.deepEqual(harness.stops, [observation.pair.pair]);
  assert.deepEqual(harness.starts, [holding.pair.pair]);
  assert.equal(scheduler.currentStatus.activeMonitors, 1);
  assert.equal(scheduler.currentStatus.waitingSessions, 1);
});

test('attend le drain du moniteur préempté avant de réutiliser sa place', async () => {
  const harness = new Harness();
  const observation = session('1', 'WAITING_FIRST_BUY', 9_500);
  const holding = session('2', 'HOLDING', 9_600);
  harness.sessions = [observation, holding];
  harness.active.add(observation.pair.pair);
  let releaseStop!: () => void;
  let signalStop!: () => void;
  const stopEntered = new Promise<void>((resolve) => {
    signalStop = resolve;
  });
  harness.stopBarrier = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  harness.onStop = signalStop;
  const scheduler = harness.scheduler(1);

  const reconciliation = scheduler.reconcile();
  await stopEntered;
  assert.deepEqual(harness.starts, []);

  releaseStop();
  await reconciliation;
  assert.deepEqual(harness.starts, [holding.pair.pair]);
});

test('attend la fin d’une admission déjà engagée', async () => {
  const harness = new Harness();
  harness.sessions = [session('1', 'WAITING_FIRST_BUY', 9_500)];
  let releaseStart!: () => void;
  let signalStart!: () => void;
  const startEntered = new Promise<void>((resolve) => {
    signalStart = resolve;
  });
  harness.startBarrier = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  harness.onStart = signalStart;
  const scheduler = harness.scheduler();

  void scheduler.reconcile();
  await startEntered;
  let idle = false;
  const drained = scheduler.waitForIdle().then(() => {
    idle = true;
  });
  await Promise.resolve();
  assert.equal(idle, false);

  releaseStart();
  await drained;
  assert.equal(idle, true);
});
