import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import type { PairInfo } from '../src/types/domain.js';
import { classifySwap } from '../src/strategy/swap-classifier.js';

const WBNB = '0x0000000000000000000000000000000000000001' as Address;
const TOKEN = '0x0000000000000000000000000000000000000002' as Address;
const PAIR = '0x0000000000000000000000000000000000000003' as Address;
const HASH = `0x${'1'.repeat(64)}` as Hash;
const SENDER = '0x0000000000000000000000000000000000000004' as Address;
const RECIPIENT = '0x0000000000000000000000000000000000000005' as Address;

function pair(token0: Address, token1: Address): PairInfo {
  return {
    factory: '0x0000000000000000000000000000000000000006',
    router: '0x0000000000000000000000000000000000000007',
    pair: PAIR,
    token: TOKEN,
    token0,
    token1,
    wbnb: WBNB,
    createdBlock: 1n,
    createdTransactionHash: HASH,
    createdLogIndex: 0,
    discoveredAtMs: 1,
  };
}

const base = {
  transactionHash: HASH,
  blockNumber: 2n,
  transactionIndex: 1,
  logIndex: 3,
  sender: SENDER,
  recipient: RECIPIENT,
};

test('classifie un achat lorsque WBNB est token0', () => {
  const event = classifySwap(pair(WBNB, TOKEN), {
    ...base,
    amount0In: 10n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 100n,
  });
  assert.equal(event.kind, 'BUY');
  assert.equal(event.amountWbnb, 10n);
  assert.equal(event.amountToken, 100n);
});

test('classifie un achat lorsque WBNB est token1', () => {
  const event = classifySwap(pair(TOKEN, WBNB), {
    ...base,
    amount0In: 0n,
    amount1In: 10n,
    amount0Out: 100n,
    amount1Out: 0n,
  });
  assert.equal(event.kind, 'BUY');
  assert.equal(event.amountWbnb, 10n);
  assert.equal(event.amountToken, 100n);
});

test('classifie une vente', () => {
  const event = classifySwap(pair(WBNB, TOKEN), {
    ...base,
    amount0In: 0n,
    amount1In: 100n,
    amount0Out: 9n,
    amount1Out: 0n,
  });
  assert.equal(event.kind, 'SELL');
  assert.equal(event.amountWbnb, 9n);
  assert.equal(event.amountToken, 100n);
});

test('classe OTHER lorsqu’un swap mélange les deux directions', () => {
  const event = classifySwap(pair(WBNB, TOKEN), {
    ...base,
    amount0In: 10n,
    amount1In: 5n,
    amount0Out: 2n,
    amount1Out: 100n,
  });
  assert.equal(event.kind, 'OTHER');
  assert.equal(event.amountWbnb, 0n);
  assert.equal(event.amountToken, 0n);
});
