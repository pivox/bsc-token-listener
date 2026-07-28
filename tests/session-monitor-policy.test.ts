import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import type { SwapEvent, TokenSession } from '../src/types/domain.js';
import { isSessionMonitorable } from '../src/strategy/session-monitor-policy.js';
import { SessionEngine } from '../src/strategy/session-engine.js';
import type { TokenRiskReport } from '../src/security/token-risk.types.js';

const ADDRESS = `0x${'1'.repeat(40)}` as Address;

function buy(id: number): SwapEvent {
  return {
    id: `event-${id}`,
    pair: ADDRESS,
    transactionHash: `0x${id.toString(16).padStart(64, '0')}` as Hash,
    blockHash: `0x${id.toString(16).padStart(64, '0')}` as Hash,
    kind: 'BUY',
    sender: ADDRESS,
    recipient: ADDRESS,
    amount0In: 1n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 1n,
    amountWbnb: 1n,
    amountToken: 1n,
    cursor: { blockNumber: BigInt(id), transactionIndex: 0, logIndex: 0 },
    observedAtMs: id,
  };
}

function allowReport(): TokenRiskReport {
  return {
    id: 'report',
    token: ADDRESS,
    pair: ADDRESS,
    blockNumber: 3n,
    score: 100,
    verdict: 'ALLOW',
    checks: [],
    summary: {
      liquidityWbnb: 1_000n,
      owner: null,
      implementation: null,
      lpBurnedBps: null,
      buyTaxBps: 0,
      sellTaxBps: 0,
      roundTripLossBps: 0,
      sensitiveSelectors: [],
    },
    createdAtMs: 3,
  };
}

function session(status: TokenSession['status']): TokenSession {
  return {
    pair: {} as TokenSession['pair'],
    metadata: {} as TokenSession['metadata'],
    status,
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

test('active uniquement les sessions qui peuvent consommer des swaps', () => {
  assert.equal(isSessionMonitorable(session('WAITING_FIRST_BUY')), true);
  assert.equal(isSessionMonitorable(session('HOLDING')), true);
  for (const status of [
    'RISK_CHECKING',
    'BUY_PENDING',
    'SELL_PENDING',
    'MANUAL_REVIEW',
    'CLOSED',
    'REJECTED',
    'EXPIRED',
  ] as const) {
    assert.equal(isSessionMonitorable(session(status)), false, status);
  }
});

test('laisse rejouable un swap arrivé après désactivation de la session', async () => {
  const current = session('MANUAL_REVIEW');
  current.pair = {
    pair: '0x0000000000000000000000000000000000000001',
  } as unknown as TokenSession['pair'];
  const engine = new SessionEngine(
    { findByPair: async () => structuredClone(current) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  const consumed = await engine.onSwap(current, {
    id: 'event',
    pair: '0x0000000000000000000000000000000000000001',
    transactionHash:
      '0x0000000000000000000000000000000000000000000000000000000000000001',
    blockHash:
      '0x0000000000000000000000000000000000000000000000000000000000000001',
    kind: 'BUY',
    sender: '0x0000000000000000000000000000000000000001',
    recipient: '0x0000000000000000000000000000000000000001',
    amount0In: 0n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 0n,
    amountWbnb: 0n,
    amountToken: 0n,
    cursor: { blockNumber: 2n, transactionIndex: 0, logIndex: 0 },
    observedAtMs: 2,
  });

  assert.equal(consumed, false);
  assert.equal(current.lastProcessedCursor, undefined);
});

test('sérialise l’expiration avec une entrée déjà en cours', async () => {
  let releaseRisk!: () => void;
  let signalRiskStarted!: () => void;
  const riskStarted = new Promise<void>((resolve) => {
    signalRiskStarted = resolve;
  });
  const riskRelease = new Promise<void>((resolve) => {
    releaseRisk = resolve;
  });
  const savedStatuses: TokenSession['status'][] = [];
  const current = session('WAITING_FIRST_BUY');
  current.pair = {
    pair: ADDRESS,
    token: ADDRESS,
  } as TokenSession['pair'];
  current.entryObservationBuys = [buy(1), buy(2)];
  current.createdAtMs = 0;

  const engine = new SessionEngine(
    {
      save: async (value: TokenSession) => {
        savedStatuses.push(value.status);
      },
      findByPair: async () => structuredClone(current),
      countOpenPositions: async () => 0,
    } as never,
    {} as never,
    {
      analyze: async () => {
        signalRiskStarted();
        await riskRelease;
        throw new Error('analyse indisponible');
      },
    } as never,
    {} as never,
    {} as never,
  );

  const entry = engine.onSwap(current, buy(3));
  await riskStarted;
  const expiration = engine.expireIfNeeded(current);
  releaseRisk();

  await entry;
  assert.equal(await expiration, false);
  assert.equal(current.status, 'REJECTED');
  assert.equal(savedStatuses.includes('EXPIRED'), false);
});

test('recharge la session persistée avant de l’ignorer après une entrée', async () => {
  let releaseRisk!: () => void;
  let signalRiskStarted!: () => void;
  const riskStarted = new Promise<void>((resolve) => {
    signalRiskStarted = resolve;
  });
  const riskRelease = new Promise<void>((resolve) => {
    releaseRisk = resolve;
  });
  const current = session('WAITING_FIRST_BUY');
  current.pair = {
    pair: ADDRESS,
    token: ADDRESS,
  } as TokenSession['pair'];
  current.entryObservationBuys = [buy(1), buy(2)];
  const staleWaiting = structuredClone(current);
  let persisted = structuredClone(current);
  const savedStatuses: TokenSession['status'][] = [];

  const engine = new SessionEngine(
    {
      save: async (value: TokenSession) => {
        persisted = structuredClone(value);
        savedStatuses.push(value.status);
      },
      findByPair: async () => structuredClone(persisted),
      countOpenPositions: async () => 0,
    } as never,
    { save: async () => {} } as never,
    {
      analyze: async () => {
        signalRiskStarted();
        await riskRelease;
        return allowReport();
      },
    } as never,
    {
      buy: async () => ({
        mode: 'dry-run',
        amountInWei: 100n,
        amountOutToken: 200n,
        confirmedAtMs: 4,
        cursor: { blockNumber: 3n, transactionIndex: 1, logIndex: 0 },
      }),
    } as never,
    { resolve: async () => 100n } as never,
  );

  const entry = engine.onSwap(current, buy(3));
  await riskStarted;
  const ignored = engine.ignoreManually(staleWaiting);
  releaseRisk();

  await entry;
  await assert.rejects(ignored, /position ouverte/u);
  assert.equal(persisted.status, 'HOLDING');
  assert.equal(savedStatuses.includes('REJECTED'), false);
});
