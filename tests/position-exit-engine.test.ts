import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import { SessionEngine } from '../src/strategy/session-engine.js';
import { defaultPositionExitSettings } from '../src/strategy/position-exit-settings.js';
import type {
  PositionExitDecision,
  PositionExitDecisionStatus,
  PositionMetricsSnapshot,
} from '../src/strategy/position-exit.types.js';
import type { TokenSession } from '../src/types/domain.js';

const ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const TOKEN = '0x2222222222222222222222222222222222222222' as Address;
const HASH = `0x${'1'.repeat(64)}` as Hash;

function session(): TokenSession {
  return {
    pair: {
      factory: ADDRESS,
      router: ADDRESS,
      wbnb: ADDRESS,
      pair: ADDRESS,
      token: TOKEN,
      token0: ADDRESS,
      token1: TOKEN,
      createdBlock: 1n,
      blockHash: HASH,
      createdTransactionHash: HASH,
      createdLogIndex: 0,
      discoveredAtMs: 1,
    },
    metadata: {
      address: TOKEN,
      name: null,
      symbol: null,
      decimals: 18,
      totalSupply: 1n,
      codeSizeBytes: 1,
    },
    status: 'HOLDING',
    entry: {
      mode: 'dry-run',
      tradeId: 'entry',
      amountInWei: 1_000n,
      amountOutToken: 10n,
      confirmedAtMs: 1,
      cursor: { blockNumber: 1n, transactionIndex: 0, logIndex: 0 },
    },
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function metrics(
  patch: Partial<PositionMetricsSnapshot> = {},
): PositionMetricsSnapshot {
  return {
    quoteWei: 800n,
    entryCostWei: 1_000n,
    netExitValueWei: 800n,
    currentLiquidityWbnbWei: 1_000n,
    estimatedExitGasWei: 10n,
    sellTaxBps: 0,
    probeStatus: 'SAFE',
    probeMeasuredAtMs: 2,
    ...patch,
  };
}

function decision(): PositionExitDecision {
  return {
    id: 'decision',
    idempotencyKey: 'pair:entry:STOP_LOSS',
    pair: ADDRESS,
    token: TOKEN,
    settingsRevision: 0,
    primaryRule: 'STOP_LOSS',
    triggeredRules: ['STOP_LOSS'],
    action: 'SELL',
    status: 'PENDING',
    metrics: metrics(),
    reason: 'stop',
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function subject(probeStatus: PositionMetricsSnapshot['probeStatus'] = 'SAFE') {
  const order: string[] = [];
  let persisted = session();
  let sellCalls = 0;
  const transitions: Array<[PositionExitDecisionStatus, PositionExitDecisionStatus]> = [];
  const engine = new SessionEngine(
    {
      findByPair: async () => structuredClone(persisted),
      save: async (value: TokenSession) => {
        persisted = structuredClone(value);
        order.push(`session:${value.status}`);
      },
    } as never,
    {} as never,
    {} as never,
    {
      sell: async () => {
        sellCalls += 1;
        order.push('executor:sell');
        return {
          mode: 'dry-run',
          tradeId: 'sell',
          entryTradeId: 'entry',
          amountInToken: 10n,
          amountOutWei: 800n,
          confirmedAtMs: 3,
        };
      },
    } as never,
    {} as never,
    undefined,
    undefined,
    {
      settings: {
        get: async () => ({
          settings: defaultPositionExitSettings(),
          revision: 0,
          source: 'ENV',
          updatedAt: null,
        }),
      },
      metrics: {
        collect: async () => metrics({ probeStatus }),
      },
      decisions: {
        findDecision: async () => decision(),
        transitionDecision: async (
          _id: string,
          expected: PositionExitDecisionStatus,
          next: PositionExitDecisionStatus,
        ) => {
          transitions.push([expected, next]);
          order.push(`decision:${next}`);
          return true;
        },
      },
    },
  );
  return {
    engine,
    get order() {
      return order;
    },
    get persisted() {
      return persisted;
    },
    get sellCalls() {
      return sellCalls;
    },
    transitions,
  };
}

test('persiste EXECUTING et SELL_PENDING avant l’executor', async () => {
  const value = subject();
  await value.engine.requestPolicyExit(session(), decision());

  assert.deepEqual(value.order.slice(0, 3), [
    'decision:EXECUTING',
    'session:SELL_PENDING',
    'executor:sell',
  ]);
  assert.equal(value.persisted.status, 'CLOSED');
  assert.equal(value.persisted.pendingExitDecisionId, undefined);
  assert.deepEqual(value.transitions.at(-1), ['EXECUTING', 'EXECUTED']);
});

test('un probe inconnu juste avant vente passe en revue sans transaction', async () => {
  const value = subject('UNKNOWN');
  await value.engine.requestPolicyExit(session(), decision());

  assert.equal(value.sellCalls, 0);
  assert.equal(value.persisted.status, 'MANUAL_REVIEW');
  assert.deepEqual(value.transitions, [['PENDING', 'MANUAL_REVIEW']]);
});

test('deux demandes concurrentes ne vendent qu’une fois', async () => {
  const value = subject();
  await Promise.allSettled([
    value.engine.requestPolicyExit(session(), decision()),
    value.engine.sellManually(session()),
  ]);
  assert.equal(value.sellCalls, 1);
});
