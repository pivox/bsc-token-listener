import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import {
  restoreReappearedPairSession,
} from '../src/discovery/reappeared-pair.js';
import type { PairInfo, TokenSession } from '../src/types/domain.js';

const ADDRESS = (digit: string): Address =>
  `0x${digit.repeat(40)}` as Address;
const HASH = (digit: string): Hash =>
  `0x${digit.repeat(64)}` as Hash;

function pair(): PairInfo {
  return {
    factory: ADDRESS('1'),
    router: ADDRESS('2'),
    wbnb: ADDRESS('3'),
    pair: ADDRESS('4'),
    token: ADDRESS('5'),
    token0: ADDRESS('3'),
    token1: ADDRESS('5'),
    createdBlock: 10n,
    blockHash: HASH('1'),
    createdTransactionHash: HASH('2'),
    createdLogIndex: 3,
    discoveredAtMs: 1,
  };
}

function orphanedSession(status: TokenSession['status'] = 'REJECTED'): TokenSession {
  const value: TokenSession = {
    pair: pair(),
    metadata: {
      address: ADDRESS('5'),
      name: 'Token',
      symbol: 'TKN',
      decimals: 18,
      totalSupply: 1n,
      codeSizeBytes: 1,
    },
    status,
    subsequentBuyCount: 2,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [HASH('9')],
    sellAttempts: 1,
    rejectionReason:
      'Découverte de paire invalidée par une réorganisation de chaîne.',
    createdAtMs: 1,
    updatedAtMs: 2,
  };
  return value;
}

test('restaure une PairCreated orpheline réapparue avec la même identité', () => {
  const restored = restoreReappearedPairSession(
    orphanedSession(),
    { ...pair(), discoveredAtMs: 100 },
    200,
  );

  assert.equal(restored?.status, 'WAITING_FIRST_BUY');
  assert.equal(restored?.pair.discoveredAtMs, 100);
  assert.equal(restored?.rejectionReason, undefined);
  assert.equal(restored?.subsequentBuyCount, 0);
  assert.deepEqual(restored?.countedBuyTransactionHashes, []);
  assert.equal(restored?.sellAttempts, 0);
  assert.equal(restored?.updatedAtMs, 200);
});

test('remplace la provenance bloc/hash quand la même identité PairCreated réapparaît sur la chaîne canonique', () => {
  const canonical = {
    ...pair(),
    createdBlock: 12n,
    blockHash: HASH('8'),
    discoveredAtMs: 100,
  };

  const restored = restoreReappearedPairSession(
    orphanedSession(),
    canonical,
    200,
  );

  assert.equal(restored?.status, 'WAITING_FIRST_BUY');
  assert.equal(restored?.pair.createdBlock, 12n);
  assert.equal(restored?.pair.blockHash, HASH('8'));
  assert.equal(restored?.pair.createdTransactionHash, pair().createdTransactionHash);
  assert.equal(restored?.pair.createdLogIndex, pair().createdLogIndex);
});

test('restaure la même paire recanonisée par un nouveau log PairCreated', () => {
  const replacement = {
    ...pair(),
    createdBlock: 12n,
    blockHash: HASH('8'),
    createdTransactionHash: HASH('7'),
    createdLogIndex: 9,
    discoveredAtMs: 100,
  };

  const restored = restoreReappearedPairSession(
    orphanedSession(),
    replacement,
    200,
  );

  assert.equal(restored?.status, 'WAITING_FIRST_BUY');
  assert.deepEqual(restored?.pair, replacement);
});

test('ne restaure ni une identité stable différente ni une conséquence wallet manuelle', () => {
  assert.equal(
    restoreReappearedPairSession(
      orphanedSession(),
      { ...pair(), factory: ADDRESS('6') },
      200,
    ),
    null,
  );
  assert.equal(
    restoreReappearedPairSession(orphanedSession('MANUAL_REVIEW'), pair(), 200),
    null,
  );
  const rejectedWithWalletConsequence = orphanedSession();
  rejectedWithWalletConsequence.unreconciledExecution = {
    tradeId: 'trade-wallet',
    step: 'BUY',
    outcome: 'UNKNOWN',
    transactionHash: HASH('6'),
    recordedAtMs: 10,
  };
  assert.equal(
    restoreReappearedPairSession(
      rejectedWithWalletConsequence,
      pair(),
      200,
    ),
    null,
  );
});
