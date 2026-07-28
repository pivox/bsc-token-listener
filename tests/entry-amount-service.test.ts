import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config/env.js';
import { EntryAmountService } from '../src/execution/entry-amount.service.js';
import type { TokenSession, SwapEvent } from '../src/types/domain.js';

const baseSession: TokenSession = {
  pair: {
    factory: '0x0000000000000000000000000000000000000001',
    router: '0x0000000000000000000000000000000000000002',
    wbnb: '0x0000000000000000000000000000000000000003',
    pair: '0x0000000000000000000000000000000000000004',
    token: '0x0000000000000000000000000000000000000005',
    token0: '0x0000000000000000000000000000000000000006',
    token1: '0x0000000000000000000000000000000000000007',
    createdBlock: 1n,
    blockHash:
      '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    createdTransactionHash:
      '0x0000000000000000000000000000000000000000000000000000000000000001',
    createdLogIndex: 0,
    discoveredAtMs: 0,
  },
  metadata: {
    address: '0x0000000000000000000000000000000000000005',
    name: 'Test',
    symbol: 'TST',
    decimals: 18,
    totalSupply: 1n,
    codeSizeBytes: 0,
  },
  status: 'WAITING_FIRST_BUY',
  subsequentBuyCount: 0,
  targetBuysAfterEntry: 3,
  countedBuyTransactionHashes: [],
  sellAttempts: 0,
  createdAtMs: 0,
  updatedAtMs: 0,
};

const baseBuy: SwapEvent = {
  id: 'event-1',
  pair: '0x0000000000000000000000000000000000000004',
  transactionHash:
    '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  blockHash:
    '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  kind: 'BUY',
  sender: '0x0000000000000000000000000000000000000008',
  recipient: '0x0000000000000000000000000000000000000009',
  amount0In: 1n,
  amount1In: 2n,
  amount0Out: 3n,
  amount1Out: 4n,
  amountWbnb: 0n,
  amountToken: 6n,
  cursor: {
    blockNumber: 1n,
    transactionIndex: 1,
    logIndex: 1,
  },
  observedAtMs: 0,
};

function withObservedBuys(amountsWbnb: bigint[]): TokenSession {
  const session = structuredClone(baseSession) as TokenSession;
  session.entryObservationBuys = amountsWbnb.map((amountWbnb, index) => ({
    ...baseBuy,
    id: `event-${index}`,
    amountWbnb,
  }));
  return session;
}

test('calcule la taille d\'entrée limitée par le solde wallet réel', async () => {
  const walletCapWei = config.maxBuyBnbWei / 2n;
  const walletBalanceWei = config.gasReserveWei
    + (walletCapWei * 10_000n) / BigInt(config.buyWalletShareBps);
  const service = new EntryAmountService({
    getWalletBalanceWei: async () => walletBalanceWei,
  });
  const session = withObservedBuys([
    10_000_000_000_000_000_000n,
    10_000_000_000_000_000_000n,
    10_000_000_000_000_000_000n,
  ]);

  const amount = await service.resolve(
    session,
    100_000_000_000_000_000_000_000n,
  );

  assert.equal(amount, walletCapWei - (walletCapWei % config.buyAmountStepWei));
});

test('utilise un solde simulé quand le solde wallet est null', async () => {
  const service = new EntryAmountService({
    getWalletBalanceWei: async () => null,
  });
  const session = withObservedBuys([
    10_000_000_000_000_000_000n,
    10_000_000_000_000_000_000n,
    10_000_000_000_000_000_000n,
  ]);

  const amount = await service.resolve(
    session,
    100_000_000_000_000_000_000_000n,
  );

  assert.equal(amount, config.maxBuyBnbWei);
});
