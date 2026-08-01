import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import { PairAdmissionService } from '../src/discovery/pair-admission.service.js';
import type {
  PairInfo,
  TokenMetadata,
  TokenSession,
} from '../src/types/domain.js';

const address = (digit: string): Address =>
  `0x${digit.repeat(40)}` as Address;
const hash = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;

const pair: PairInfo = {
  factory: address('1'),
  router: address('2'),
  wbnb: address('3'),
  pair: address('4'),
  token: address('5'),
  token0: address('3'),
  token1: address('5'),
  createdBlock: 10n,
  blockHash: hash('a'),
  createdTransactionHash: hash('b'),
  createdLogIndex: 0,
  discoveredAtMs: 1_000,
};

const metadata: TokenMetadata = {
  address: pair.token,
  name: 'Fixture',
  symbol: 'FIX',
  decimals: 18,
  totalSupply: 1_000_000n,
  codeSizeBytes: 20,
};

function orphanedWaitingSession(): TokenSession {
  return {
    pair: structuredClone(pair),
    metadata: structuredClone(metadata),
    status: 'REJECTED',
    rejectionReason:
      'Découverte de paire invalidée par une réorganisation de chaîne.',
    entryObservationBuys: [],
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 2,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 900,
    updatedAtMs: 1_100,
  };
}

function createHarness(options: {
  monitored?: boolean;
  ignored?: boolean;
  existing?: TokenSession | null;
  metadataError?: Error;
} = {}) {
  const calls: string[] = [];
  let savedSession: TokenSession | undefined;
  const service = new PairAdmissionService({
    sessions: {
      findByPair: async () => {
        calls.push('find');
        return structuredClone(options.existing ?? null);
      },
      save: async (session) => {
        calls.push('session');
        savedSession = structuredClone(session);
      },
    },
    discovered: {
      upsert: async (input) => {
        calls.push(input.metadata ? 'discovery+metadata' : 'discovery');
      },
    },
    ignored: {
      isIgnored: async () => {
        calls.push('ignored');
        return options.ignored ?? false;
      },
    },
    metadata: {
      read: async () => {
        calls.push('metadata');
        if (options.metadataError) throw options.metadataError;
        return metadata;
      },
    },
    isMonitored: () => options.monitored ?? false,
    scheduleMonitor: () => {
      calls.push('schedule');
    },
    targetBuysAfterEntry: 2,
    now: () => 1_234,
  });
  return {
    calls,
    pair,
    service,
    get savedSession(): TokenSession | undefined {
      return savedSession;
    },
  };
}

test('persiste découverte, métadonnées et WAITING_FIRST_BUY avant de planifier le monitor', async () => {
  const harness = createHarness();

  await harness.service.admit(harness.pair);

  assert.deepEqual(harness.calls, [
    'find',
    'ignored',
    'discovery',
    'metadata',
    'discovery+metadata',
    'session',
    'schedule',
  ]);
  assert.equal(harness.savedSession?.status, 'WAITING_FIRST_BUY');
  assert.equal(harness.savedSession?.targetBuysAfterEntry, 2);
  assert.equal(harness.savedSession?.createdAtMs, 1_234);
});

test('ignore une paire déjà monitorée sans I/O', async () => {
  const harness = createHarness({ monitored: true });

  await harness.service.admit(harness.pair);

  assert.deepEqual(harness.calls, []);
});

test('restaure une paire réapparue et planifie le monitor sans relire les métadonnées', async () => {
  const harness = createHarness({ existing: orphanedWaitingSession() });

  await harness.service.admit(harness.pair);

  assert.deepEqual(harness.calls, [
    'find',
    'discovery+metadata',
    'session',
    'schedule',
  ]);
  assert.equal(harness.savedSession?.status, 'WAITING_FIRST_BUY');
  assert.equal(harness.savedSession?.updatedAtMs, 1_234);
});

test('ne crée rien pour un actif ignoré', async () => {
  const harness = createHarness({ ignored: true });

  await harness.service.admit(harness.pair);

  assert.deepEqual(harness.calls, ['find', 'ignored']);
  assert.equal(harness.savedSession, undefined);
});

test('conserve seulement la découverte si les métadonnées sont incompatibles', async () => {
  const harness = createHarness({
    metadataError: new Error('BEP-20 invalide'),
  });

  await harness.service.admit(harness.pair);

  assert.deepEqual(harness.calls, [
    'find',
    'ignored',
    'discovery',
    'metadata',
  ]);
  assert.equal(harness.savedSession, undefined);
});
