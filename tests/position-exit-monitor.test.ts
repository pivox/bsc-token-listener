import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import { defaultPositionExitSettings } from '../src/strategy/position-exit-settings.js';
import {
  PositionExitMonitor,
  type PositionExitMonitorDependencies,
} from '../src/strategy/position-exit-monitor.js';
import { StalePositionMetricsError } from '../src/strategy/position-metrics.service.js';
import type { PositionExitDecision } from '../src/strategy/position-exit.types.js';
import type { TokenSession } from '../src/types/domain.js';

const ADDRESS = '0x1111111111111111111111111111111111111111' as Address;
const TOKEN = '0x2222222222222222222222222222222222222222' as Address;
const HASH = `0x${'1'.repeat(64)}` as Hash;

function holding(): TokenSession {
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

function dependencies(
  patch: Partial<PositionExitMonitorDependencies> = {},
): PositionExitMonitorDependencies {
  return {
    sessions: {
      loadHolding: async () => [holding()],
      findByPair: async () => holding(),
      save: async () => {},
    },
    settings: {
      get: async () => ({
        settings: defaultPositionExitSettings(),
        revision: 0,
        source: 'ENV',
        updatedAt: null,
      }),
    },
    metrics: {
      collect: async () => ({
        quoteWei: 1_000n,
        entryCostWei: 1_000n,
        netExitValueWei: 1_000n,
        currentLiquidityWbnbWei: 1_000n,
        estimatedExitGasWei: 1n,
        sellTaxBps: 0,
        probeStatus: 'SAFE',
        probeMeasuredAtMs: 1_000,
      }),
    },
    decisions: {
      createDecision: async (input) => ({
        ...input,
        id: 'decision',
        status: 'PENDING',
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      }),
      listRecoverableDecisions: async () => [],
      transitionDecision: async () => true,
    },
    engine: {
      requestPolicyExit: async (value) => value,
    },
    barrier: {
      runListener: async (operation) => operation(),
    },
    now: () => 1_000,
    ...patch,
  };
}

test('deux ticks ne se chevauchent jamais', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  const monitor = new PositionExitMonitor(
    dependencies({
      sessions: {
        loadHolding: async () => {
          calls += 1;
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          if (calls === 1) await blocked;
          concurrent -= 1;
          return [];
        },
        findByPair: async () => null,
        save: async () => {},
      },
    }),
  );

  const first = monitor.reconcileNow();
  const second = monitor.reconcileNow();
  assert.equal(monitor.currentStatus.running, true);
  release();
  await Promise.all([first, second]);
  assert.equal(maxConcurrent, 1);
  assert.equal(calls, 2);
});

test('un RPC marché indisponible persiste STALE sans décision', async () => {
  let saved: TokenSession | undefined;
  let decisions = 0;
  let exits = 0;
  const monitor = new PositionExitMonitor(
    dependencies({
      sessions: {
        loadHolding: async () => [holding()],
        findByPair: async () => holding(),
        save: async (value) => {
          saved = structuredClone(value);
        },
      },
      metrics: {
        collect: async () => {
          throw new StalePositionMetricsError('MARKET_RPC_ERROR');
        },
      },
      decisions: {
        createDecision: async () => {
          decisions += 1;
          throw new Error('unexpected');
        },
        listRecoverableDecisions: async () => [],
        transitionDecision: async () => true,
      },
      engine: {
        requestPolicyExit: async (value) => {
          exits += 1;
          return value;
        },
      },
    }),
  );

  await monitor.reconcileNow();
  assert.equal(saved?.exitPolicy?.staleReason, 'MARKET_RPC_ERROR');
  assert.equal(decisions, 0);
  assert.equal(exits, 0);
});

test('persiste l’état avant de créer et soumettre une décision idempotente', async () => {
  const order: string[] = [];
  let created: PositionExitDecision | undefined;
  const monitor = new PositionExitMonitor(
    dependencies({
      sessions: {
        loadHolding: async () => [holding()],
        findByPair: async () => holding(),
        save: async () => {
          order.push('session');
        },
      },
      metrics: {
        collect: async () => ({
          quoteWei: 800n,
          entryCostWei: 1_000n,
          netExitValueWei: 800n,
          currentLiquidityWbnbWei: 1_000n,
          estimatedExitGasWei: 10n,
          sellTaxBps: 0,
          probeStatus: 'SAFE',
          probeMeasuredAtMs: 1_000,
        }),
      },
      decisions: {
        createDecision: async (input) => {
          order.push('decision');
          created = {
            ...input,
            id: 'decision',
            status: 'PENDING',
            createdAtMs: 1_000,
            updatedAtMs: 1_000,
          };
          return created;
        },
        listRecoverableDecisions: async () => [],
        transitionDecision: async () => true,
      },
      engine: {
        requestPolicyExit: async (value, valueDecision) => {
          order.push('engine');
          assert.equal(valueDecision, created);
          return value;
        },
      },
    }),
  );

  await monitor.reconcileNow();
  assert.deepEqual(order, ['session', 'decision', 'engine']);
  assert.match(created?.idempotencyKey ?? '', /STOP_LOSS/u);
});
