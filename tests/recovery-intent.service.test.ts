import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import { ExecutionRecoverySafetyError } from '../src/execution/trade-executor.js';
import { RecoveryIntentService } from '../src/recovery/recovery-intent.service.js';
import type { TokenRiskReport } from '../src/security/token-risk.types.js';
import type { TokenSession } from '../src/types/domain.js';

const ADDRESS = `0x${'1'.repeat(40)}` as Address;
const HASH = `0x${'2'.repeat(64)}` as Hash;

function session(status: TokenSession['status']): TokenSession {
  return {
    pair: {
      factory: ADDRESS,
      router: ADDRESS,
      wbnb: ADDRESS,
      pair: ADDRESS,
      token: ADDRESS,
      token0: ADDRESS,
      token1: ADDRESS,
      createdBlock: 1n,
      blockHash: HASH,
      createdTransactionHash: HASH,
      createdLogIndex: 0,
      discoveredAtMs: 1,
    },
    metadata: {
      address: ADDRESS,
      name: 'Token',
      symbol: 'TKN',
      decimals: 18,
      totalSupply: 1_000n,
      codeSizeBytes: 1,
    },
    status,
    firstBuy: {
      id: 'event',
      pair: ADDRESS,
      transactionHash: HASH,
      blockHash: HASH,
      kind: 'BUY',
      sender: ADDRESS,
      recipient: ADDRESS,
      amount0In: 1n,
      amount1In: 0n,
      amount0Out: 0n,
      amount1Out: 1n,
      amountWbnb: 1n,
      amountToken: 1n,
      cursor: { blockNumber: 2n, transactionIndex: 0, logIndex: 0 },
      observedAtMs: 2,
    },
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function report(verdict: TokenRiskReport['verdict'] = 'ALLOW'): TokenRiskReport {
  return {
    id: 'report',
    token: ADDRESS,
    pair: ADDRESS,
    blockNumber: 2n,
    score: 100,
    verdict,
    checks: [],
    summary: {
      liquidityWbnb: 1_000n,
      buyTaxBps: 0,
      sellTaxBps: 0,
      roundTripLossBps: 0,
      owner: null,
      implementation: null,
      lpBurnedBps: null,
      sensitiveSelectors: [],
    },
    createdAtMs: 2,
  };
}

test('reprend RISK_CHECKING jusqu’à l’achat avec un rapport ALLOW persisté', async () => {
  const savedReports: TokenRiskReport[] = [];
  let buyCalls = 0;
  const service = new RecoveryIntentService({
    reports: {
      save: async (value) => {
        savedReports.push(structuredClone(value));
      },
      findById: async () => report(),
    },
    risk: { analyze: async () => report() },
    amounts: { resolve: async () => 100n },
    positions: { countOpenPositions: async () => 0 },
    maxConcurrentPositions: 1,
    executor: {
      buy: async () => {
        assert.equal(savedReports.length, 1);
        buyCalls += 1;
        return {
          mode: 'dry-run',
          amountInWei: 100n,
          amountOutToken: 200n,
          confirmedAtMs: 3,
          cursor: { blockNumber: 2n, transactionIndex: 1, logIndex: 0 },
        };
      },
      sell: async () => {
        throw new Error('vente inattendue');
      },
    },
    riskPolicy: 'allow-only',
    now: () => 3,
  });

  const resumed = await service.resumeRiskAndBuy(session('RISK_CHECKING'));

  assert.equal(savedReports.length, 1);
  assert.equal(buyCalls, 1);
  assert.equal(resumed.status, 'HOLDING');
});

test('refuse un achat de reprise sans rapport ALLOW', async () => {
  let buyCalls = 0;
  const current = session('BUY_PENDING');
  current.riskReportId = 'report';
  const service = new RecoveryIntentService({
    reports: {
      save: async () => undefined,
      findById: async () => report('REVIEW'),
    },
    risk: { analyze: async () => report('REVIEW') },
    amounts: { resolve: async () => 100n },
    positions: { countOpenPositions: async () => 1 },
    maxConcurrentPositions: 1,
    executor: {
      buy: async () => {
        buyCalls += 1;
        throw new Error('achat interdit');
      },
      sell: async () => {
        throw new Error('vente inattendue');
      },
    },
    riskPolicy: 'allow-only',
    now: () => 3,
  });

  const resumed = await service.resumeBuy(current);

  assert.equal(buyCalls, 0);
  assert.equal(resumed.status, 'REJECTED');
  assert.match(resumed.rejectionReason ?? '', /ALLOW/u);
});

test('block-only refuse aussi un rapport BLOCK persisté', async () => {
  let buyCalls = 0;
  const current = session('BUY_PENDING');
  current.riskReportId = 'report';
  const service = new RecoveryIntentService({
    reports: {
      save: async () => undefined,
      findById: async () => report('BLOCK'),
    },
    risk: { analyze: async () => report('BLOCK') },
    amounts: { resolve: async () => 100n },
    positions: { countOpenPositions: async () => 1 },
    maxConcurrentPositions: 1,
    executor: {
      buy: async () => {
        buyCalls += 1;
        throw new Error('achat interdit');
      },
      sell: async () => {
        throw new Error('vente inattendue');
      },
    },
    riskPolicy: 'block-only',
    now: () => 3,
  });

  const resumed = await service.resumeBuy(current);

  assert.equal(buyCalls, 0);
  assert.equal(resumed.status, 'REJECTED');
});

test('la reprise du risque respecte la capacité maximale de positions', async () => {
  let buyCalls = 0;
  const service = new RecoveryIntentService({
    reports: {
      save: async () => undefined,
      findById: async () => report(),
    },
    risk: { analyze: async () => report() },
    amounts: { resolve: async () => 100n },
    positions: { countOpenPositions: async () => 1 },
    maxConcurrentPositions: 1,
    executor: {
      buy: async () => {
        buyCalls += 1;
        throw new Error('achat au-delà de la capacité');
      },
      sell: async () => {
        throw new Error('vente inattendue');
      },
    },
    riskPolicy: 'allow-only',
    now: () => 3,
  });

  const resumed = await service.resumeRiskAndBuy(session('RISK_CHECKING'));

  assert.equal(buyCalls, 0);
  assert.equal(resumed.status, 'REJECTED');
  assert.match(resumed.rejectionReason ?? '', /maximal/u);
});

test('BUY_PENDING exclut la session courante du calcul de capacité', async () => {
  let buyCalls = 0;
  const current = session('BUY_PENDING');
  current.riskReportId = 'report';
  const service = new RecoveryIntentService({
    reports: {
      save: async () => undefined,
      findById: async () => report(),
    },
    risk: { analyze: async () => report() },
    amounts: { resolve: async () => 100n },
    positions: { countOpenPositions: async () => 1 },
    maxConcurrentPositions: 1,
    executor: {
      buy: async () => {
        buyCalls += 1;
        return {
          mode: 'dry-run',
          amountInWei: 100n,
          amountOutToken: 200n,
          confirmedAtMs: 3,
          cursor: { blockNumber: 2n, transactionIndex: 1, logIndex: 0 },
        };
      },
      sell: async () => {
        throw new Error('vente inattendue');
      },
    },
    riskPolicy: 'allow-only',
    now: () => 3,
  });

  const resumed = await service.resumeBuy(current);

  assert.equal(buyCalls, 1);
  assert.equal(resumed.status, 'HOLDING');
});

test('une incompatibilité de reprise de vente exige une revue manuelle', async () => {
  const current = session('SELL_PENDING');
  current.entry = {
    mode: 'live',
    amountInWei: 100n,
    amountOutToken: 200n,
    confirmedAtMs: 2,
    cursor: { blockNumber: 2n, transactionIndex: 0, logIndex: 0 },
  };
  const service = new RecoveryIntentService({
    reports: {
      save: async () => undefined,
      findById: async () => report(),
    },
    risk: { analyze: async () => report() },
    amounts: { resolve: async () => 100n },
    positions: { countOpenPositions: async () => 1 },
    maxConcurrentPositions: 1,
    executor: {
      buy: async () => {
        throw new Error('achat inattendu');
      },
      sell: async () => {
        throw new ExecutionRecoverySafetyError('wallet différent');
      },
    },
    riskPolicy: 'allow-only',
    now: () => 3,
  });

  const resumed = await service.resumeSell(current);

  assert.equal(resumed.status, 'MANUAL_REVIEW');
  assert.equal(resumed.unreconciledExecution, undefined);
});
