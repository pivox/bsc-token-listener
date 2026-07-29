import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import { defaultPositionExitSettings } from '../src/strategy/position-exit-settings.js';
import {
  PositionMetricsService,
  StalePositionMetricsError,
  type PositionMetricsGateway,
} from '../src/strategy/position-metrics.service.js';
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
      amountInWei: 1_000n,
      amountOutToken: 10n,
      gasCostWei: 25n,
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

function gateway(
  patch: Partial<PositionMetricsGateway> = {},
): PositionMetricsGateway {
  return {
    quotePosition: async () => 2_000n,
    readLiquidityWbnb: async () => 5_000n,
    readFeePerGas: async () => 2_000_000_000n,
    probeSellability: async () => ({
      buyTaxBps: 100,
      sellTaxBps: 500,
      roundTripLossBps: 600,
      quotedTokens: 100n,
      receivedTokens: 99n,
      quotedNative: 100n,
      recoveredNative: 95n,
    }),
    ...patch,
  };
}

test('calcule quote, coût économique et gas prudent', async () => {
  const metrics = await new PositionMetricsService(gateway()).collect(
    session(),
    defaultPositionExitSettings(),
    {},
    61_000,
  );

  assert.equal(metrics.entryCostWei, 1_025n);
  assert.equal(metrics.quoteWei, 2_000n);
  assert.equal(metrics.sellTaxBps, 500);
  assert.equal(metrics.estimatedExitGasWei, 860_000_000_000_000n);
  assert.equal(metrics.probeStatus, 'SAFE');
  assert.equal(metrics.currentLiquidityWbnbWei, 5_000n);
});

test('réutilise un probe encore frais sans nouvel appel', async () => {
  let probes = 0;
  const metrics = await new PositionMetricsService(
    gateway({
      probeSellability: async () => {
        probes += 1;
        throw new Error('ne doit pas être appelé');
      },
    }),
  ).collect(
    session(),
    defaultPositionExitSettings(),
    {
      lastProbeAtMs: 50_000,
      lastProbeStatus: 'SAFE',
      lastSellTaxBps: 250,
    },
    61_000,
  );

  assert.equal(probes, 0);
  assert.equal(metrics.probeStatus, 'SAFE');
  assert.equal(metrics.sellTaxBps, 250);
  assert.equal(metrics.probeMeasuredAtMs, 50_000);
});

test('un probe RPC en échec devient UNKNOWN sans transaction', async () => {
  let sentTransactions = 0;
  const metrics = await new PositionMetricsService(
    gateway({
      probeSellability: async () => {
        sentTransactions += 0;
        throw new Error('RPC');
      },
    }),
  ).collect(session(), defaultPositionExitSettings(), {}, 61_000);

  assert.equal(metrics.probeStatus, 'UNKNOWN');
  assert.equal(sentTransactions, 0);
});

test('une erreur quote, liquidité ou fee rend les métriques stale', async () => {
  for (const method of ['quotePosition', 'readLiquidityWbnb', 'readFeePerGas'] as const) {
    const failing = gateway({
      [method]: async () => {
        throw new Error('RPC');
      },
    });
    await assert.rejects(
      new PositionMetricsService(failing).collect(
        session(),
        defaultPositionExitSettings(),
        {},
        61_000,
      ),
      StalePositionMetricsError,
    );
  }
});
