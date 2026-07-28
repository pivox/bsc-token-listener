import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash, Hex } from 'viem';
import {
  ExecutionMeasurementError,
  ExecutionOutcomeUnknownError,
  ExecutionRevertedError,
  TradeExecutor,
} from '../src/execution/trade-executor.js';
import type {
  ExecutionGateway,
  ExecutionReceipt,
  PreparedExecutionTransaction,
} from '../src/execution/execution.types.js';
import type {
  TokenSession,
  TradeRecord,
  TradeTransactionRecord,
} from '../src/types/domain.js';

const WALLET = `0x${'1'.repeat(40)}` as Address;
const PAIR = `0x${'2'.repeat(40)}` as Address;
const TOKEN = `0x${'3'.repeat(40)}` as Address;
const ROUTER = `0x${'4'.repeat(40)}` as Address;
const WBNB = `0x${'5'.repeat(40)}` as Address;
const HASH = `0x${'6'.repeat(64)}` as Hash;

function session(): TokenSession {
  return {
    pair: {
      factory: `0x${'7'.repeat(40)}`,
      router: ROUTER,
      wbnb: WBNB,
      pair: PAIR,
      token: TOKEN,
      token0: WBNB,
      token1: TOKEN,
      createdBlock: 1n,
      blockHash: `0x${'7'.repeat(64)}`,
      createdTransactionHash: `0x${'8'.repeat(64)}`,
      createdLogIndex: 0,
      discoveredAtMs: 1,
    },
    metadata: {
      address: TOKEN,
      name: 'Token',
      symbol: 'TKN',
      decimals: 18,
      totalSupply: 1_000n,
      codeSizeBytes: 10,
    },
    status: 'BUY_PENDING',
    firstBuy: {
      id: 'event',
      pair: PAIR,
      transactionHash: `0x${'9'.repeat(64)}`,
      blockHash: `0x${'a'.repeat(64)}`,
      kind: 'BUY',
      sender: WALLET,
      recipient: WALLET,
      amount0In: 1n,
      amount1In: 0n,
      amount0Out: 0n,
      amount1Out: 2n,
      amountWbnb: 1n,
      amountToken: 2n,
      cursor: { blockNumber: 2n, transactionIndex: 0, logIndex: 0 },
      observedAtMs: 2,
    },
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

class MemoryTradeStore {
  readonly trades: TradeRecord[] = [];
  readonly lifecycles: Array<{
    trade: TradeRecord;
    transaction: TradeTransactionRecord;
  }> = [];
  private lifecycleCallCount = 0;

  constructor(private readonly failLifecycleFromCall?: number) {}

  async save(trade: TradeRecord): Promise<void> {
    this.trades.push(structuredClone(trade));
  }

  async saveLifecycle(
    trade: TradeRecord,
    transaction: TradeTransactionRecord,
  ): Promise<void> {
    this.lifecycleCallCount += 1;
    if (
      this.failLifecycleFromCall !== undefined
      && this.lifecycleCallCount >= this.failLifecycleFromCall
    ) {
      throw new Error('PostgreSQL indisponible après diffusion');
    }
    this.trades.push(structuredClone(trade));
    this.lifecycles.push({
      trade: structuredClone(trade),
      transaction: structuredClone(transaction),
    });
  }
}

class FakeExecutionGateway implements ExecutionGateway {
  constructor(readonly walletAddress: Address | null = WALLET) {}

  quoteAmount = 200n;
  allowance = 1_000n;
  tokenBalances: Array<bigint | Error> = [10n, 170n];
  nativeBalances: Array<bigint | Error> = [1_000n, 893n];
  receipts: Array<ExecutionReceipt | Error> = [{
    status: 'success',
    blockNumber: 10n,
    transactionIndex: 1,
    gasUsed: 7n,
    effectiveGasPrice: 1n,
  }];
  sendError: Error | null = null;
  preparedApprovalAmount: bigint | null = null;
  preparedSellAmount: bigint | null = null;
  beforeSend: (() => void) | null = null;
  private nonce = 1n;

  async quote(): Promise<bigint> {
    return this.quoteAmount;
  }

  async getTokenBalance(): Promise<bigint> {
    const value = this.tokenBalances.shift();
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error('solde token non préparé');
    return value;
  }

  async getNativeBalance(): Promise<bigint> {
    const value = this.nativeBalances.shift();
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error('solde natif non préparé');
    return value;
  }

  async getAllowance(): Promise<bigint> {
    return this.allowance;
  }

  async prepareBuy(): Promise<PreparedExecutionTransaction> {
    return this.prepared('BUY', 100n);
  }

  async prepareApproval(input: { amount: bigint }): Promise<PreparedExecutionTransaction> {
    this.preparedApprovalAmount = input.amount;
    return this.prepared('APPROVE', 0n);
  }

  async prepareSell(input: { amountInToken: bigint }): Promise<PreparedExecutionTransaction> {
    this.preparedSellAmount = input.amountInToken;
    return this.prepared('SELL', 0n);
  }

  async sendRawTransaction(): Promise<Hash> {
    this.beforeSend?.();
    if (this.sendError) throw this.sendError;
    return HASH;
  }

  async waitForReceipt(): Promise<ExecutionReceipt> {
    const receipt = this.receipts.shift();
    if (!receipt) throw new Error('receipt indisponible');
    if (receipt instanceof Error) throw receipt;
    return receipt;
  }

  private prepared(
    step: 'BUY' | 'APPROVE' | 'SELL',
    valueWei: bigint,
  ): PreparedExecutionTransaction {
    const nonce = this.nonce;
    this.nonce += 1n;
    return {
      step,
      hash: HASH,
      nonce,
      walletAddress: WALLET,
      toAddress: step === 'APPROVE' ? TOKEN : ROUTER,
      valueWei,
      serializedTransaction: '0x1234' as Hex,
    };
  }
}

test('persiste hash et nonce avant diffusion puis mesure un achat taxé', async () => {
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway();
  gateway.beforeSend = () => {
    assert.equal(store.lifecycles.at(-1)?.transaction.status, 'CREATED');
    assert.equal(store.lifecycles.at(-1)?.transaction.transactionHash, HASH);
    assert.equal(store.lifecycles.at(-1)?.transaction.nonce, 1n);
  };
  const executor = new TradeExecutor(store, gateway, 'live');

  const entry = await executor.buy(session(), 100n);

  assert.equal(entry.amountInWei, 100n);
  assert.equal(entry.quotedAmountOutToken, 200n);
  assert.equal(entry.amountOutToken, 160n);
  assert.equal(entry.gasCostWei, 7n);
  assert.equal(store.trades.at(-1)?.actualAmountOut, 160n);
  assert.equal(store.trades.at(-1)?.status, 'CONFIRMED');
});

test('attache l’événement source à chaque sauvegarde du trade d’achat', async () => {
  const store = new MemoryTradeStore();
  const executor = new TradeExecutor(store, new FakeExecutionGateway(), 'dry-run');

  await executor.buy(session(), 100n, 'event-buy');

  assert.ok(store.trades.length > 1);
  assert.equal(
    store.trades.every((trade) => trade.sourceEventId === 'event-buy'),
    true,
  );
});

test('attache l’événement persisté au trade de vente créé en reprise', async () => {
  const store = new MemoryTradeStore();
  const openSession = session();
  openSession.status = 'SELL_PENDING';
  openSession.entry = {
    mode: 'dry-run',
    amountInWei: 100n,
    amountOutToken: 200n,
    confirmedAtMs: 2,
    cursor: { blockNumber: 2n, transactionIndex: 0, logIndex: 0 },
  };
  const executor = new TradeExecutor(store, new FakeExecutionGateway(), 'dry-run');

  await executor.sell(openSession, undefined, 'event-sell-recovery');

  assert.ok(store.trades.length > 1);
  assert.equal(
    store.trades.every(
      (trade) => trade.sourceEventId === 'event-sell-recovery',
    ),
    true,
  );
});

test('classe une erreur de diffusion comme UNKNOWN sans la confondre avec un échec', async () => {
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway();
  const signedTransaction = '0xf86c_signed_transaction_secret';
  gateway.sendError = new Error(`RPC indisponible, body: ${signedTransaction}`);
  const executor = new TradeExecutor(store, gateway, 'live');

  const error = await executor.buy(session(), 100n).catch((caught: unknown) => caught);

  assert.ok(error instanceof ExecutionOutcomeUnknownError);
  assert.equal(error.executionToReconcile?.outcome, 'UNKNOWN');
  assert.equal(error.executionToReconcile?.step, 'BUY');
  assert.equal(error.executionToReconcile?.transactionHash, HASH);
  assert.doesNotMatch(error.message, new RegExp(signedTransaction, 'u'));
  assert.doesNotMatch(store.trades.at(-1)?.error ?? '', new RegExp(signedTransaction, 'u'));
  assert.doesNotMatch(
    store.lifecycles.at(-1)?.transaction.error ?? '',
    new RegExp(signedTransaction, 'u'),
  );
  assert.equal(store.trades.at(-1)?.status, 'UNKNOWN');
  assert.equal(store.lifecycles.at(-1)?.transaction.status, 'UNKNOWN');
});

test('persiste un reçu d’achat revert', async () => {
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway();
  gateway.receipts = [{
    status: 'reverted',
    blockNumber: 10n,
    transactionIndex: 1,
    gasUsed: 7n,
    effectiveGasPrice: 1n,
  }];
  const executor = new TradeExecutor(store, gateway, 'live');

  await assert.rejects(executor.buy(session(), 100n), ExecutionRevertedError);

  assert.equal(store.trades.at(-1)?.status, 'REVERTED');
  assert.equal(store.lifecycles.at(-1)?.transaction.receiptStatus, 'reverted');
  assert.equal(store.lifecycles.at(-1)?.transaction.gasCostWei, 7n);
});

test('vend exactement la quantité de la position et laisse le surplus intact', async () => {
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway();
  gateway.tokenBalances = [250n, 250n, 150n];
  gateway.nativeBalances = [1_000n, 1_090n];
  gateway.quoteAmount = 120n;
  gateway.receipts = [{
    status: 'success',
    blockNumber: 11n,
    transactionIndex: 2,
    gasUsed: 10n,
    effectiveGasPrice: 1n,
  }];
  const openSession = session();
  openSession.status = 'HOLDING';
  openSession.entry = {
    mode: 'live',
    tradeId: 'entry-trade',
    amountInWei: 90n,
    amountOutToken: 100n,
    confirmedAtMs: 3,
    cursor: { blockNumber: 3n, transactionIndex: 0, logIndex: 0 },
  };
  const executor = new TradeExecutor(store, gateway, 'live');

  const exit = await executor.sell(openSession);

  assert.equal(gateway.preparedSellAmount, 100n);
  assert.equal(gateway.preparedApprovalAmount, null);
  assert.equal(exit.amountInToken, 100n);
  assert.equal(exit.amountOutWei, 100n);
  assert.equal(exit.quotedAmountOutWei, 120n);
  assert.equal(exit.gasCostWei, 10n);
  assert.equal(store.trades.at(-1)?.relatedTradeId, 'entry-trade');
});

test('approuve uniquement la quantité exacte lorsque allowance est insuffisante', async () => {
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway();
  gateway.allowance = 0n;
  gateway.tokenBalances = [100n, 100n, 0n];
  gateway.nativeBalances = [1_000n, 998n, 998n, 1_088n];
  gateway.receipts = [
    {
      status: 'success',
      blockNumber: 10n,
      transactionIndex: 1,
      gasUsed: 2n,
      effectiveGasPrice: 1n,
    },
    {
      status: 'success',
      blockNumber: 11n,
      transactionIndex: 2,
      gasUsed: 10n,
      effectiveGasPrice: 1n,
    },
  ];
  const openSession = session();
  openSession.status = 'HOLDING';
  openSession.entry = {
    mode: 'live',
    tradeId: 'entry-trade',
    amountInWei: 90n,
    amountOutToken: 100n,
    confirmedAtMs: 3,
    cursor: { blockNumber: 3n, transactionIndex: 0, logIndex: 0 },
  };
  const executor = new TradeExecutor(store, gateway, 'live');

  const exit = await executor.sell(openSession);

  assert.equal(gateway.preparedApprovalAmount, 100n);
  assert.deepEqual(
    [...new Set(
      store.lifecycles
        .filter(({ transaction }) => transaction.status === 'CONFIRMED')
        .map(({ transaction }) => transaction.step),
    )],
    ['APPROVE', 'SELL'],
  );
  assert.equal(exit.gasCostWei, 12n);
});

test('refuse la vente avant diffusion si le solde est inférieur à la position', async () => {
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway();
  gateway.tokenBalances = [99n];
  const openSession = session();
  openSession.status = 'HOLDING';
  openSession.entry = {
    mode: 'live',
    amountInWei: 90n,
    amountOutToken: 100n,
    confirmedAtMs: 3,
    cursor: { blockNumber: 3n, transactionIndex: 0, logIndex: 0 },
  };
  const executor = new TradeExecutor(store, gateway, 'live');

  await assert.rejects(executor.sell(openSession), /Solde token insuffisant/u);

  assert.equal(store.trades.at(-1)?.status, 'FAILED');
  assert.equal(store.lifecycles.length, 0);
  assert.equal(gateway.preparedSellAmount, null);
});

test('classe un timeout de reçu comme UNKNOWN', async () => {
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway();
  gateway.receipts = [new Error('timeout receipt')];
  const executor = new TradeExecutor(store, gateway, 'live');

  await assert.rejects(
    executor.buy(session(), 100n),
    ExecutionOutcomeUnknownError,
  );

  assert.equal(store.trades.at(-1)?.status, 'UNKNOWN');
  assert.equal(store.lifecycles.at(-1)?.transaction.status, 'UNKNOWN');
});

test('un approval revert empêche toute tentative de vente', async () => {
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway();
  gateway.allowance = 0n;
  gateway.tokenBalances = [100n];
  gateway.nativeBalances = [1_000n];
  gateway.receipts = [{
    status: 'reverted',
    blockNumber: 10n,
    transactionIndex: 1,
    gasUsed: 2n,
    effectiveGasPrice: 1n,
  }];
  const openSession = session();
  openSession.status = 'HOLDING';
  openSession.entry = {
    mode: 'live',
    amountInWei: 90n,
    amountOutToken: 100n,
    confirmedAtMs: 3,
    cursor: { blockNumber: 3n, transactionIndex: 0, logIndex: 0 },
  };
  const executor = new TradeExecutor(store, gateway, 'live');

  await assert.rejects(executor.sell(openSession), ExecutionRevertedError);

  assert.equal(gateway.preparedApprovalAmount, 100n);
  assert.equal(gateway.preparedSellAmount, null);
  assert.equal(store.trades.at(-1)?.status, 'REVERTED');
});

test('reprend le trade d’approval et conserve son gas dans la vente', async () => {
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway();
  gateway.tokenBalances = [100n, 100n, 0n];
  gateway.nativeBalances = [1_000n, 1_093n];
  const openSession = session();
  openSession.status = 'SELL_PENDING';
  openSession.entry = {
    mode: 'live',
    tradeId: 'trade-buy',
    amountInWei: 90n,
    amountOutToken: 100n,
    confirmedAtMs: 3,
    cursor: { blockNumber: 3n, transactionIndex: 0, logIndex: 0 },
  };
  const recoveredTrade: TradeRecord = {
    id: 'trade-sell-recovered',
    pair: PAIR,
    token: TOKEN,
    side: 'SELL',
    mode: 'live',
    status: 'CREATED',
    amountIn: 100n,
    amountOut: 200n,
    quotedAmountOut: 200n,
    walletAddress: WALLET,
    relatedTradeId: 'trade-buy',
    gasCostWei: 2n,
    sourceEventId: 'event-sell',
    createdAtMs: 2,
    updatedAtMs: 2,
  };
  const executor = new TradeExecutor(store, gateway, 'live');

  const exit = await executor.sell(openSession, {
    trade: recoveredTrade,
    approvalGasWei: 2n,
  }, 'event-new');

  assert.equal(gateway.preparedApprovalAmount, null);
  assert.equal(exit.tradeId, recoveredTrade.id);
  assert.equal(exit.gasCostWei, 9n);
  assert.equal(store.trades.at(-1)?.id, recoveredTrade.id);
  assert.equal(store.trades.at(-1)?.gasCostWei, 9n);
  assert.equal(
    store.trades.every((trade) => trade.sourceEventId === 'event-sell'),
    true,
  );
});

test('ne rediffuse jamais un approval déjà confirmé pendant la reprise', async () => {
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway();
  gateway.allowance = 0n;
  gateway.tokenBalances = [100n];
  const openSession = session();
  openSession.status = 'SELL_PENDING';
  openSession.entry = {
    mode: 'live',
    amountInWei: 90n,
    amountOutToken: 100n,
    confirmedAtMs: 3,
    cursor: { blockNumber: 3n, transactionIndex: 0, logIndex: 0 },
  };
  const recoveredTrade: TradeRecord = {
    id: 'trade-sell-recovered',
    pair: PAIR,
    token: TOKEN,
    side: 'SELL',
    mode: 'live',
    status: 'CREATED',
    amountIn: 100n,
    amountOut: 200n,
    walletAddress: WALLET,
    gasCostWei: 2n,
    createdAtMs: 2,
    updatedAtMs: 2,
  };
  const executor = new TradeExecutor(store, gateway, 'live');

  await assert.rejects(
    executor.sell(openSession, {
      trade: recoveredTrade,
      approvalGasWei: 2n,
    }),
    /Allowance insuffisante après reprise/u,
  );

  assert.equal(gateway.preparedApprovalAmount, null);
  assert.equal(gateway.preparedSellAmount, null);
});

test('refuse de reprendre un approval appartenant à un autre wallet', async () => {
  const otherWallet = `0x${'a'.repeat(40)}` as Address;
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway(otherWallet);
  gateway.quote = async () => {
    throw new Error('quote RPC indisponible');
  };
  const openSession = session();
  openSession.status = 'SELL_PENDING';
  openSession.entry = {
    mode: 'live',
    amountInWei: 90n,
    amountOutToken: 100n,
    confirmedAtMs: 3,
    cursor: { blockNumber: 3n, transactionIndex: 0, logIndex: 0 },
  };
  const recoveredTrade: TradeRecord = {
    id: 'trade-sell-recovered',
    pair: PAIR,
    token: TOKEN,
    side: 'SELL',
    mode: 'live',
    status: 'CREATED',
    amountIn: 100n,
    amountOut: 200n,
    walletAddress: WALLET,
    gasCostWei: 2n,
    createdAtMs: 2,
    updatedAtMs: 2,
  };
  const executor = new TradeExecutor(store, gateway, 'live');

  await assert.rejects(
    executor.sell(openSession, {
      trade: recoveredTrade,
      approvalGasWei: 2n,
    }),
    /Wallet.*différent/u,
  );

  assert.equal(gateway.preparedApprovalAmount, null);
  assert.equal(gateway.preparedSellAmount, null);
  assert.equal(recoveredTrade.walletAddress, WALLET);
});

test('conserve le reçu confirmé quand la mesure post-achat échoue', async () => {
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway();
  gateway.tokenBalances = [10n, new Error('RPC balance indisponible')];
  const executor = new TradeExecutor(store, gateway, 'live');

  await assert.rejects(
    executor.buy(session(), 100n),
    { name: 'ExecutionMeasurementError' },
  );

  assert.equal(store.lifecycles.at(-1)?.transaction.status, 'CONFIRMED');
  assert.match(
    store.lifecycles.at(-1)?.transaction.measurementError ?? '',
    /RPC balance indisponible/u,
  );
  assert.equal(store.trades.at(-1)?.status, 'CONFIRMED');
  assert.equal(store.trades.at(-1)?.actualAmountOut, undefined);
});

test('expose la vente confirmée à réconcilier quand sa mesure échoue', async () => {
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway();
  gateway.tokenBalances = [100n, 100n, 0n];
  gateway.nativeBalances = [1_000n, new Error('RPC balance indisponible')];
  const openSession = session();
  openSession.status = 'HOLDING';
  openSession.entry = {
    mode: 'live',
    amountInWei: 90n,
    amountOutToken: 100n,
    confirmedAtMs: 3,
    cursor: { blockNumber: 3n, transactionIndex: 0, logIndex: 0 },
  };
  const executor = new TradeExecutor(store, gateway, 'live');

  await assert.rejects(
    executor.sell(openSession),
    (error: unknown) =>
      error instanceof ExecutionMeasurementError
      && error.executionToReconcile?.outcome === 'CONFIRMED'
      && error.executionToReconcile.step === 'SELL'
      && error.executionToReconcile.tradeId === store.trades[0]?.id
      && error.executionToReconcile.transactionHash === HASH,
  );

  assert.equal(store.lifecycles.at(-1)?.transaction.status, 'CONFIRMED');
  assert.equal(store.trades.at(-1)?.status, 'CONFIRMED');
  assert.equal(store.trades.at(-1)?.actualAmountOut, undefined);
});

test('une mesure d’approval incomplète ne confirme pas la vente métier', async () => {
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway();
  gateway.allowance = 0n;
  gateway.tokenBalances = [100n];
  gateway.nativeBalances = [1_000n, new Error('RPC balance indisponible')];
  gateway.receipts = [{
    status: 'success',
    blockNumber: 10n,
    transactionIndex: 1,
    gasUsed: 2n,
    effectiveGasPrice: 1n,
  }];
  const openSession = session();
  openSession.status = 'HOLDING';
  openSession.entry = {
    mode: 'live',
    amountInWei: 90n,
    amountOutToken: 100n,
    confirmedAtMs: 3,
    cursor: { blockNumber: 3n, transactionIndex: 0, logIndex: 0 },
  };
  const executor = new TradeExecutor(store, gateway, 'live');

  await assert.rejects(
    executor.sell(openSession),
    { name: 'ExecutionMeasurementError' },
  );

  assert.equal(store.lifecycles.at(-1)?.transaction.status, 'CONFIRMED');
  assert.equal(store.trades.at(-1)?.status, 'UNKNOWN');
  assert.equal(gateway.preparedSellAmount, null);
});

test('dry-run reste simulé sans transaction enfant on-chain', async () => {
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway();
  const executor = new TradeExecutor(store, gateway, 'dry-run');

  const entry = await executor.buy(session(), 100n);

  assert.equal(entry.mode, 'dry-run');
  assert.equal(entry.amountOutToken, gateway.quoteAmount);
  assert.equal(store.trades.at(-1)?.status, 'SIMULATED');
  assert.equal(store.trades.at(-1)?.actualAmountOut, undefined);
  assert.equal(store.lifecycles.length, 0);
});

test('persiste l’absence de wallet live comme un échec avant diffusion', async () => {
  const store = new MemoryTradeStore();
  const gateway = new FakeExecutionGateway(null);
  const executor = new TradeExecutor(store, gateway, 'live');

  await assert.rejects(executor.buy(session(), 100n), /Wallet live non initialisé/u);

  assert.equal(store.trades.at(-1)?.status, 'FAILED');
  assert.equal(store.lifecycles.length, 0);
});

test('conserve une erreur typée UNKNOWN si PostgreSQL échoue après diffusion', async () => {
  const store = new MemoryTradeStore(2);
  const gateway = new FakeExecutionGateway();
  const executor = new TradeExecutor(store, gateway, 'live');

  await assert.rejects(
    executor.buy(session(), 100n),
    (error: unknown) =>
      error instanceof ExecutionOutcomeUnknownError
      && error.message.includes('PostgreSQL indisponible après diffusion'),
  );

  assert.equal(store.lifecycles[0]?.transaction.status, 'CREATED');
});
