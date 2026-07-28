import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
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
  const savedSessions: TokenSession[] = [];
  const savedReports: TokenRiskReport[] = [];
  let buyCalls = 0;
  const service = new RecoveryIntentService({
    sessions: {
      save: async (value) => {
        savedSessions.push(structuredClone(value));
      },
    },
    reports: {
      save: async (value) => {
        savedReports.push(structuredClone(value));
      },
      findById: async () => report(),
    },
    risk: { analyze: async () => report() },
    amounts: { resolve: async () => 100n },
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

  const resumed = await service.resumeRiskAndBuy(session('RISK_CHECKING'));

  assert.equal(savedReports.length, 1);
  assert.equal(savedSessions.some((value) => value.status === 'BUY_PENDING'), true);
  assert.equal(buyCalls, 1);
  assert.equal(resumed.status, 'HOLDING');
});

test('refuse un achat de reprise sans rapport ALLOW', async () => {
  let buyCalls = 0;
  const current = session('BUY_PENDING');
  current.riskReportId = 'report';
  const service = new RecoveryIntentService({
    sessions: { save: async () => undefined },
    reports: {
      save: async () => undefined,
      findById: async () => report('REVIEW'),
    },
    risk: { analyze: async () => report('REVIEW') },
    amounts: { resolve: async () => 100n },
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
