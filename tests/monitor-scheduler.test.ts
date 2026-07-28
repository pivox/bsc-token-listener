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

  scheduler(capacity = 1, now = 10_000): MonitorScheduler {
    return new MonitorScheduler({
      capacity,
      ttlMs: 1_000,
      now: () => now,
      loadSessions: async () => this.sessions.map((value) => structuredClone(value)),
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
        if (this.startFailures.has(value.pair.pair)) {
          throw new Error('listener indisponible');
        }
        this.active.add(value.pair.pair);
      },
      stop: (pair) => {
        this.stops.push(pair);
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

  await scheduler.reconcile();

  assert.deepEqual(harness.starts, [
    harness.sessions[0]!.pair.pair,
    harness.sessions[1]!.pair.pair,
  ]);
  assert.equal(scheduler.currentStatus.abandonedSessions, 1);
  assert.equal(scheduler.currentStatus.activeMonitors, 1);
});
