import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import { SessionReconciler } from '../src/recovery/session-reconciler.js';
import type {
  ChainObservation,
  ClaimedRecovery,
  RecoveryDecision,
  ReconciliationGateway,
  ReconciliationStore,
} from '../src/recovery/recovery.types.js';
import type {
  TokenSession,
  TradeRecord,
  TradeTransactionRecord,
} from '../src/types/domain.js';

const WALLET = `0x${'1'.repeat(40)}` as Address;
const PAIR = `0x${'2'.repeat(40)}` as Address;
const TOKEN = `0x${'3'.repeat(40)}` as Address;
const HASH = `0x${'4'.repeat(64)}` as Hash;

function session(status: TokenSession['status']): TokenSession {
  return {
    pair: {
      factory: WALLET,
      router: WALLET,
      wbnb: WALLET,
      pair: PAIR,
      token: TOKEN,
      token0: TOKEN,
      token1: WALLET,
      createdBlock: 1n,
      createdTransactionHash: HASH,
      createdLogIndex: 0,
      discoveredAtMs: 1,
    },
    metadata: {
      address: TOKEN,
      name: 'Token',
      symbol: 'TKN',
      decimals: 18,
      totalSupply: 1_000n,
      codeSizeBytes: 1,
    },
    status,
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function trade(side: 'BUY' | 'SELL'): TradeRecord {
  return {
    id: `trade-${side.toLowerCase()}`,
    pair: PAIR,
    token: TOKEN,
    side,
    mode: 'live',
    status: 'UNKNOWN',
    amountIn: side === 'BUY' ? 100n : 100n,
    amountOut: 0n,
    quotedAmountOut: 200n,
    transactionHash: HASH,
    walletAddress: WALLET,
    createdAtMs: 2,
    updatedAtMs: 2,
  };
}

function transaction(parent: TradeRecord, step: 'BUY' | 'SELL'): TradeTransactionRecord {
  return {
    id: `transaction-${step.toLowerCase()}`,
    tradeId: parent.id,
    step,
    status: 'UNKNOWN',
    walletAddress: WALLET,
    transactionHash: HASH,
    nonce: 1n,
    toAddress: WALLET,
    valueWei: step === 'BUY' ? 100n : 0n,
    nativeBalanceBefore: 1_000n,
    tokenBalanceBefore: step === 'BUY' ? 10n : 100n,
    createdAtMs: 2,
    updatedAtMs: 2,
  };
}

class MemoryStore implements ReconciliationStore {
  readonly applied: RecoveryDecision[] = [];

  async claimNext(): Promise<null> {
    return null;
  }

  async applyDecision(
    _claimed: ClaimedRecovery,
    decision: RecoveryDecision,
  ): Promise<void> {
    this.applied.push(structuredClone(decision));
  }

  async tryAcquirePassLock(): Promise<boolean> {
    return true;
  }

  async releasePassLock(): Promise<void> {}
}

class FakeGateway implements ReconciliationGateway {
  observation: ChainObservation = {
    kind: 'RECEIPT',
    receipt: {
      status: 'success',
      blockNumber: 10n,
      transactionIndex: 1,
      gasUsed: 7n,
      effectiveGasPrice: 1n,
    },
  };
  nativeBalance = 893n;
  tokenBalance = 170n;

  async observeTransaction(): Promise<ChainObservation> {
    return this.observation;
  }

  async getNativeBalance(): Promise<bigint> {
    return this.nativeBalance;
  }

  async getTokenBalance(): Promise<bigint> {
    return this.tokenBalance;
  }
}

function claim(
  currentSession: TokenSession,
  currentTrade: TradeRecord,
  currentTransaction: TradeTransactionRecord,
): ClaimedRecovery {
  return {
    owner: 'worker',
    statusBefore: currentSession.status,
    snapshot: {
      session: currentSession,
      trades: [currentTrade],
      transactions: [currentTransaction],
    },
  };
}

test('reconstruit un achat confirmé depuis les soldes réels', async () => {
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  const currentTrade = trade('BUY');
  const current = claim(
    session('BUY_PENDING'),
    currentTrade,
    transaction(currentTrade, 'BUY'),
  );
  const reconciler = new SessionReconciler(store, gateway, null, () => 20);

  await reconciler.reconcile(current);

  const decision = store.applied.at(-1);
  assert.equal(decision?.session.status, 'HOLDING');
  assert.equal(decision?.session.entry?.amountInWei, 100n);
  assert.equal(decision?.session.entry?.amountOutToken, 160n);
  assert.equal(decision?.session.entry?.transactionHash, HASH);
  assert.equal(decision?.trade?.status, 'CONFIRMED');
  assert.equal(decision?.transaction?.status, 'CONFIRMED');
});

test('reconstruit une vente confirmée sans doubler la vente', async () => {
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  gateway.nativeBalance = 1_093n;
  gateway.tokenBalance = 0n;
  const currentSession = session('SELL_PENDING');
  currentSession.entry = {
    mode: 'live',
    tradeId: 'trade-buy',
    amountInWei: 100n,
    amountOutToken: 100n,
    confirmedAtMs: 1,
    cursor: { blockNumber: 1n, transactionIndex: 0, logIndex: 0 },
  };
  const currentTrade = trade('SELL');
  const current = claim(
    currentSession,
    currentTrade,
    transaction(currentTrade, 'SELL'),
  );
  const reconciler = new SessionReconciler(store, gateway, null, () => 20);

  await reconciler.reconcile(current);

  const decision = store.applied.at(-1);
  assert.equal(decision?.session.status, 'CLOSED');
  assert.equal(decision?.session.exit?.amountInToken, 100n);
  assert.equal(decision?.session.exit?.amountOutWei, 100n);
  assert.equal(decision?.session.exit?.transactionHash, HASH);
});

test('classe un hash absent en revue manuelle sans exécution', async () => {
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  gateway.observation = { kind: 'ABSENT' };
  const currentTrade = trade('SELL');
  const currentSession = session('SELL_PENDING');
  currentSession.entry = {
    mode: 'live',
    amountInWei: 100n,
    amountOutToken: 100n,
    confirmedAtMs: 1,
    cursor: { blockNumber: 1n, transactionIndex: 0, logIndex: 0 },
  };
  const current = claim(
    currentSession,
    currentTrade,
    transaction(currentTrade, 'SELL'),
  );
  const reconciler = new SessionReconciler(store, gateway, null, () => 20);

  await reconciler.reconcile(current);

  assert.equal(store.applied.at(-1)?.session.status, 'MANUAL_REVIEW');
  assert.match(store.applied.at(-1)?.reason ?? '', /Hash absent/u);
});

test('un revert de vente revient à HOLDING', async () => {
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  gateway.observation = {
    kind: 'RECEIPT',
    receipt: {
      status: 'reverted',
      blockNumber: 10n,
      transactionIndex: 1,
      gasUsed: 7n,
      effectiveGasPrice: 1n,
    },
  };
  const currentTrade = trade('SELL');
  const current = claim(
    session('SELL_PENDING'),
    currentTrade,
    transaction(currentTrade, 'SELL'),
  );
  const reconciler = new SessionReconciler(store, gateway, null, () => 20);

  await reconciler.reconcile(current);

  assert.equal(store.applied.at(-1)?.session.status, 'HOLDING');
  assert.equal(store.applied.at(-1)?.trade?.status, 'REVERTED');
});
