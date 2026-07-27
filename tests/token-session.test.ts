import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import type { ClassifiedSwap, PairInfo } from '../src/types/domain.js';
import { TokenSession } from '../src/strategy/token-session.js';

const address = (suffix: string) => `0x${suffix.padStart(40, '0')}` as Address;
const hash = (digit: string) => `0x${digit.repeat(64)}` as Hash;

const pair: PairInfo = {
  factory: address('1'),
  router: address('2'),
  pair: address('3'),
  token: address('4'),
  token0: address('5'),
  token1: address('4'),
  wbnb: address('5'),
  createdBlock: 1n,
  createdTransactionHash: hash('a'),
  createdLogIndex: 0,
  discoveredAtMs: 1,
};

function buy(index: number, txHash = hash(String(index % 10))): ClassifiedSwap {
  return {
    id: `${txHash}:${index}`,
    pair: pair.pair,
    transactionHash: txHash,
    cursor: { blockNumber: BigInt(index + 2), transactionIndex: 0, logIndex: index },
    sender: address('6'),
    recipient: address('7'),
    kind: 'BUY',
    amountWbnb: 1n,
    amountToken: 10n,
    amount0In: 1n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 10n,
    observedAtMs: index,
  };
}

test('compte dix transactions d’achat uniques après l’entrée', () => {
  const session = TokenSession.create(pair, 10);
  const trigger = buy(0, hash('1'));
  session.recordFirstBuy(trigger);
  session.markBuyPending();
  session.markHolding({
    mode: 'dry-run',
    transactionHash: undefined,
    cursor: trigger.cursor,
    amountInWei: 1n,
    amountOutToken: 100n,
    confirmedAtMs: 1,
  });

  for (let index = 1; index <= 10; index += 1) {
    const uniqueHash = `0x${index.toString(16).padStart(64, '0')}` as Hash;
    assert.equal(session.recordSubsequentBuy(buy(index, uniqueHash)), true);
  }

  assert.equal(session.snapshot.subsequentBuyCount, 10);
  assert.equal(session.shouldSell(), true);
});

test('ne compte pas deux swaps du même hash de transaction', () => {
  const session = TokenSession.create(pair, 2);
  const trigger = buy(0, hash('1'));
  session.recordFirstBuy(trigger);
  session.markBuyPending();
  session.markHolding({
    mode: 'live',
    transactionHash: hash('2'),
    cursor: { blockNumber: 3n, transactionIndex: 0, logIndex: 1 },
    amountInWei: 1n,
    amountOutToken: 100n,
    confirmedAtMs: 1,
  });

  const repeatedHash = hash('3');
  assert.equal(session.recordSubsequentBuy(buy(3, repeatedHash)), true);
  assert.equal(session.recordSubsequentBuy(buy(4, repeatedHash)), false);
  assert.equal(session.snapshot.subsequentBuyCount, 1);
});

test('ignore les achats antérieurs à notre curseur d’entrée et notre propre transaction', () => {
  const session = TokenSession.create(pair, 2);
  const trigger = buy(0, hash('1'));
  const ownHash = hash('2');
  session.recordFirstBuy(trigger);
  session.markBuyPending();
  session.markHolding({
    mode: 'live',
    transactionHash: ownHash,
    cursor: { blockNumber: 10n, transactionIndex: 5, logIndex: 2 },
    amountInWei: 1n,
    amountOutToken: 100n,
    confirmedAtMs: 1,
  });

  const beforeEntry = {
    ...buy(5, hash('3')),
    cursor: { blockNumber: 10n, transactionIndex: 4, logIndex: 99 },
  };
  const ownTransaction = {
    ...buy(6, ownHash),
    cursor: { blockNumber: 10n, transactionIndex: 5, logIndex: 3 },
  };

  assert.equal(session.recordSubsequentBuy(beforeEntry), false);
  assert.equal(session.recordSubsequentBuy(ownTransaction), false);
  assert.equal(session.snapshot.subsequentBuyCount, 0);
});

test('une vente échouée remet la session en HOLDING', () => {
  const session = TokenSession.create(pair, 1);
  const trigger = buy(0, hash('1'));
  session.recordFirstBuy(trigger);
  session.markBuyPending();
  session.markHolding({
    mode: 'dry-run',
    transactionHash: undefined,
    cursor: trigger.cursor,
    amountInWei: 1n,
    amountOutToken: 100n,
    confirmedAtMs: 1,
  });

  session.markSellPending();
  session.markSellFailed('échec simulé');

  assert.equal(session.status, 'HOLDING');
  assert.equal(session.snapshot.sellAttempts, 1);
  assert.equal(session.snapshot.lastError, 'échec simulé');
});
