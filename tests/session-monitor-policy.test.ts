import assert from 'node:assert/strict';
import test from 'node:test';
import type { TokenSession } from '../src/types/domain.js';
import { isSessionMonitorable } from '../src/strategy/session-monitor-policy.js';

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
