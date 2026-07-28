import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import { canIgnoreAsset, canManuallySell } from '../src/dashboard/action-policy.js';
import type { TokenSession } from '../src/types/domain.js';

function session(status: TokenSession['status'], withEntry = false): TokenSession {
  const value: TokenSession = {
    pair: {
      factory: '0x0000000000000000000000000000000000000001' as Address,
      router: '0x0000000000000000000000000000000000000002' as Address,
      wbnb: '0x0000000000000000000000000000000000000003' as Address,
      pair: '0x0000000000000000000000000000000000000004' as Address,
      token: '0x0000000000000000000000000000000000000005' as Address,
      token0: '0x0000000000000000000000000000000000000005' as Address,
      token1: '0x0000000000000000000000000000000000000003' as Address,
      createdBlock: 1n,
      createdTransactionHash: `0x${'1'.repeat(64)}` as Hash,
      createdLogIndex: 0,
      discoveredAtMs: 1,
    },
    metadata: {
      address: '0x0000000000000000000000000000000000000005' as Address,
      name: 'Token',
      symbol: 'TKN',
      decimals: 18,
      totalSupply: 1_000n,
      codeSizeBytes: 1,
    },
    status,
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 10,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  if (withEntry) {
    value.entry = {
      mode: 'dry-run',
      amountInWei: 1n,
      amountOutToken: 10n,
      confirmedAtMs: 2,
      cursor: { blockNumber: 2n, transactionIndex: 0, logIndex: 0 },
    };
  }
  return value;
}

test('autorise la vente manuelle uniquement pour une position ouverte', () => {
  assert.equal(canManuallySell(session('HOLDING', true)), true);
  assert.equal(canManuallySell(session('MANUAL_REVIEW', true)), true);
  assert.equal(canManuallySell(session('WAITING_FIRST_BUY')), false);
  assert.equal(canManuallySell(session('CLOSED', true)), false);
});

test('bloque une nouvelle vente quand une vente confirmée reste à réconcilier', () => {
  const value = session('MANUAL_REVIEW', true);
  value.unreconciledExecution = {
    tradeId: 'sell-trade',
    step: 'SELL',
    transactionHash: `0x${'a'.repeat(64)}` as Hash,
    confirmedAtMs: 3,
  };

  assert.equal(canManuallySell(value), false);
});

test('refuse d’ignorer une position ouverte', () => {
  assert.equal(canIgnoreAsset(session('WAITING_FIRST_BUY')), true);
  assert.equal(canIgnoreAsset(session('REJECTED')), true);
  assert.equal(canIgnoreAsset(session('HOLDING', true)), false);
  assert.equal(canIgnoreAsset(null), true);
});
