import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import { SessionReconciler } from '../src/recovery/session-reconciler.js';
import type {
  ChainObservation,
  ClaimedRecovery,
  RecoveryDecision,
  RecoveryIntentExecutor,
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

  async getBacklogCounts(): Promise<{
    pendingSessions: number;
    manualReviewSessions: number;
  }> {
    return { pendingSessions: 0, manualReviewSessions: 0 };
  }
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
  laterBlockTransaction = false;
  readonly balanceBlockNumbers: bigint[] = [];

  async observeTransaction(): Promise<ChainObservation> {
    return this.observation;
  }

  async getNativeBalance(
    _wallet: Address,
    blockNumber: bigint,
  ): Promise<bigint> {
    this.balanceBlockNumbers.push(blockNumber);
    return this.nativeBalance;
  }

  async getTokenBalance(
    _token: Address,
    _wallet: Address,
    blockNumber: bigint,
  ): Promise<bigint> {
    this.balanceBlockNumbers.push(blockNumber);
    return this.tokenBalance;
  }

  async hasLaterWalletActivityInBlock(): Promise<boolean> {
    return this.laterBlockTransaction;
  }
}

class FakeIntents implements RecoveryIntentExecutor {
  buyCalls = 0;
  sellCalls = 0;
  riskCalls = 0;
  resumedSellStatus: TokenSession['status'] | null = null;
  recoveredApprovalGasWei: bigint | null = null;
  recoveredTradeId: string | null = null;

  async resumeRiskAndBuy(value: TokenSession): Promise<TokenSession> {
    this.riskCalls += 1;
    return value;
  }

  async resumeBuy(value: TokenSession): Promise<TokenSession> {
    this.buyCalls += 1;
    value.status = 'HOLDING';
    return value;
  }

  async resumeSell(
    value: TokenSession,
    recovered?: { trade: TradeRecord; approvalGasWei: bigint },
  ): Promise<TokenSession> {
    this.sellCalls += 1;
    this.resumedSellStatus = value.status;
    this.recoveredApprovalGasWei = recovered?.approvalGasWei ?? null;
    this.recoveredTradeId = recovered?.trade.id ?? null;
    value.status = 'CLOSED';
    return value;
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
  assert.deepEqual(gateway.balanceBlockNumbers, [10n, 10n]);
});

test('retente la mesure read-only d’une exécution en revue manuelle', async () => {
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  const currentSession = session('MANUAL_REVIEW');
  const currentTrade = trade('BUY');
  const currentTransaction = transaction(currentTrade, 'BUY');
  currentSession.unreconciledExecution = {
    tradeId: currentTrade.id,
    step: 'BUY',
    outcome: 'CONFIRMED',
    transactionHash: currentTransaction.transactionHash,
    recordedAtMs: 3,
  };
  const current = claim(currentSession, currentTrade, currentTransaction);
  const reconciler = new SessionReconciler(store, gateway, null, () => 20);

  await reconciler.reconcile(current);

  assert.equal(store.applied.at(-1)?.session.status, 'HOLDING');
  assert.equal(store.applied.at(-1)?.action, 'BUY_CONFIRMED');
  assert.equal(store.applied.at(-1)?.session.unreconciledExecution, undefined);
});

test('refuse une mesure contaminée par toute transaction ultérieure du même bloc', async () => {
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  gateway.laterBlockTransaction = true;
  const currentTrade = trade('BUY');
  const current = claim(
    session('BUY_PENDING'),
    currentTrade,
    transaction(currentTrade, 'BUY'),
  );
  const reconciler = new SessionReconciler(store, gateway, null, () => 20);

  await reconciler.reconcile(current);

  assert.equal(store.applied.at(-1)?.session.status, 'MANUAL_REVIEW');
  assert.match(store.applied.at(-1)?.reason ?? '', /Mesure/u);
  assert.deepEqual(gateway.balanceBlockNumbers, []);
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

test('reprend un achat uniquement lorsqu’aucune transaction enfant n’existe', async () => {
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  const intents = new FakeIntents();
  const currentTrade = trade('BUY');
  const current: ClaimedRecovery = {
    owner: 'worker',
    statusBefore: 'BUY_PENDING',
    snapshot: {
      session: session('BUY_PENDING'),
      trades: [currentTrade],
      transactions: [],
    },
  };
  const reconciler = new SessionReconciler(store, gateway, intents, () => 20);

  await reconciler.reconcile(current);

  assert.equal(intents.buyCalls, 1);
  assert.equal(store.applied.at(-1)?.session.status, 'HOLDING');
});

test('un approval confirmé reprend la vente sans rediffuser l’approval', async () => {
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  const intents = new FakeIntents();
  const currentSession = session('SELL_PENDING');
  currentSession.entry = {
    mode: 'live',
    amountInWei: 100n,
    amountOutToken: 100n,
    confirmedAtMs: 1,
    cursor: { blockNumber: 1n, transactionIndex: 0, logIndex: 0 },
  };
  const currentTrade = trade('SELL');
  const approval = {
    ...transaction(currentTrade, 'SELL'),
    id: 'transaction-approval',
    step: 'APPROVE' as const,
  };
  const current = claim(currentSession, currentTrade, approval);
  const reconciler = new SessionReconciler(store, gateway, intents, () => 20);

  await reconciler.reconcile(current);

  assert.equal(intents.sellCalls, 1);
  assert.equal(intents.resumedSellStatus, 'SELL_PENDING');
  assert.equal(intents.recoveredApprovalGasWei, 7n);
  assert.equal(intents.recoveredTradeId, currentTrade.id);
  assert.equal(store.applied[0]?.action, 'APPROVAL_CONFIRMED');
  assert.equal(store.applied[0]?.retainLease, true);
  assert.equal(store.applied.at(-1)?.action, 'RESUME_INTENT');
  assert.equal(store.applied.at(-1)?.session.status, 'CLOSED');
});

test('un approval confirmé restaure MANUAL_REVIEW en SELL_PENDING avant reprise', async () => {
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  const intents = new FakeIntents();
  const currentSession = session('MANUAL_REVIEW');
  currentSession.entry = {
    mode: 'live',
    amountInWei: 100n,
    amountOutToken: 100n,
    confirmedAtMs: 1,
    cursor: { blockNumber: 1n, transactionIndex: 0, logIndex: 0 },
  };
  currentSession.unreconciledExecution = {
    tradeId: 'trade-sell',
    step: 'APPROVE',
    outcome: 'CONFIRMED',
    transactionHash: HASH,
    recordedAtMs: 2,
  };
  const currentTrade = trade('SELL');
  const approval = {
    ...transaction(currentTrade, 'SELL'),
    id: 'transaction-approval',
    step: 'APPROVE' as const,
  };
  const reconciler = new SessionReconciler(
    store,
    gateway,
    intents,
    () => 20,
  );

  await reconciler.reconcile(claim(currentSession, currentTrade, approval));

  assert.equal(intents.sellCalls, 1);
  assert.equal(intents.resumedSellStatus, 'SELL_PENDING');
  assert.equal(store.applied[0]?.session.status, 'SELL_PENDING');
  assert.equal(store.applied.at(-1)?.session.status, 'CLOSED');
});

test('reconstruit un achat dry-run déjà simulé sans le rejouer', async () => {
  const store = new MemoryStore();
  const gateway = new FakeGateway();
  const intents = new FakeIntents();
  const currentSession = session('BUY_PENDING');
  currentSession.firstBuy = {
    id: 'event',
    pair: PAIR,
    transactionHash: HASH,
    kind: 'BUY',
    sender: WALLET,
    recipient: WALLET,
    amount0In: 1n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 1n,
    amountWbnb: 1n,
    amountToken: 1n,
    cursor: { blockNumber: 2n, transactionIndex: 0, logIndex: 0 },
    observedAtMs: 2,
  };
  const simulated = {
    ...trade('BUY'),
    mode: 'dry-run' as const,
    status: 'SIMULATED' as const,
    amountIn: 100n,
    amountOut: 200n,
  };
  const current: ClaimedRecovery = {
    owner: 'worker',
    statusBefore: 'BUY_PENDING',
    snapshot: {
      session: currentSession,
      trades: [simulated],
      transactions: [],
    },
  };
  const reconciler = new SessionReconciler(store, gateway, intents, () => 20);

  await reconciler.reconcile(current);

  assert.equal(intents.buyCalls, 0);
  assert.equal(store.applied.at(-1)?.session.status, 'HOLDING');
  assert.equal(store.applied.at(-1)?.session.entry?.amountOutToken, 200n);
});
