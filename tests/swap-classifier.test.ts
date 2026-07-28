import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import { classifySwap } from '../src/strategy/swap-classifier.js';
import type { PairInfo } from '../src/types/domain.js';

const token = '0x0000000000000000000000000000000000000001' as Address;
const wbnb = '0x0000000000000000000000000000000000000002' as Address;
const pairAddress = '0x0000000000000000000000000000000000000003' as Address;
const blockHash = `0x${'3'.repeat(64)}` as Hash;
const pair: PairInfo = {
  factory: '0x0000000000000000000000000000000000000004' as Address,
  router: '0x0000000000000000000000000000000000000005' as Address,
  wbnb,
  pair: pairAddress,
  token,
  token0: token,
  token1: wbnb,
  createdBlock: 1n,
  blockHash,
  createdTransactionHash: `0x${'1'.repeat(64)}` as Hash,
  createdLogIndex: 1,
  discoveredAtMs: 1,
};

const base = {
  pair: pairAddress,
  transactionHash: `0x${'2'.repeat(64)}` as Hash,
  blockHash,
  blockNumber: 2n,
  transactionIndex: 1,
  logIndex: 2,
  sender: '0x0000000000000000000000000000000000000006' as Address,
  recipient: '0x0000000000000000000000000000000000000007' as Address,
};

test('classe un WBNB in / token out comme BUY', () => {
  const event = classifySwap(pair, {
    ...base,
    amount0In: 0n,
    amount1In: 10n,
    amount0Out: 100n,
    amount1Out: 0n,
  });
  assert.equal(event.kind, 'BUY');
  assert.equal(event.blockHash, blockHash);
  assert.equal(event.amountWbnb, 10n);
  assert.equal(event.amountToken, 100n);
});

test('classe un token in / WBNB out comme SELL', () => {
  const event = classifySwap(pair, {
    ...base,
    amount0In: 100n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 9n,
  });
  assert.equal(event.kind, 'SELL');
});
