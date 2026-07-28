import assert from 'node:assert/strict';
import test from 'node:test';
import type { TokenSession } from '../src/types/domain.js';
import { isSessionMonitorable } from '../src/strategy/session-monitor-policy.js';
import { SessionEngine } from '../src/strategy/session-engine.js';

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
    {} as never,
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
