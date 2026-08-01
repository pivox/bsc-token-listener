import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import type { CanonicalBlock } from '../../src/chain/canonical-chain.types.js';
import type { ExecutionGateway } from '../../src/execution/execution.types.js';
import type { TokenRiskReport } from '../../src/security/token-risk.types.js';
import type {
  EntryExecution,
  PairInfo,
  TokenMetadata,
  TokenSession,
} from '../../src/types/domain.js';
import { withMigratedSchema } from './test-database.js';

process.env.BSC_HTTP_RPC_URL ??= 'http://127.0.0.1:8545';
process.env.BSC_WS_RPC_URL ??= 'ws://127.0.0.1:8546';
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
process.env.EXECUTION_MODE = 'dry-run';
process.env.RISK_POLICY = 'allow-only';
process.env.ENTRY_OBSERVATION_BUYS = '1';
process.env.TARGET_BUYS_AFTER_ENTRY = '2';

const address = (digit: string): Address =>
  `0x${digit.repeat(40)}` as Address;
const hash = (value: number): Hash =>
  `0x${value.toString(16).padStart(64, '0')}` as Hash;
const header = (number: bigint): CanonicalBlock => ({
  number,
  hash: hash(Number(number)),
  parentHash: hash(Number(number - 1n)),
});

function buyLog(blockNumber: bigint, logIndex = 0) {
  return {
    args: {
      sender: address('7'),
      to: address('8'),
      amount0In: 10_000_000_000_000_000n,
      amount1In: 0n,
      amount0Out: 0n,
      amount1Out: 1_000_000_000_000_000_000n,
    },
    blockNumber,
    blockHash: header(blockNumber).hash,
    transactionHash: hash(Number(blockNumber) + 1_000),
    transactionIndex: 1,
    logIndex,
  };
}

const forbiddenWalletOperation = async (): Promise<never> => {
  throw new Error('Une opération wallet ne doit jamais être appelée en dry-run.');
};

const deterministicGateway: ExecutionGateway = {
  walletAddress: null,
  quote: async ({ amountIn }) => amountIn * 100n,
  getTokenBalance: forbiddenWalletOperation,
  getNativeBalance: forbiddenWalletOperation,
  getAllowance: forbiddenWalletOperation,
  prepareBuy: forbiddenWalletOperation,
  prepareApproval: forbiddenWalletOperation,
  prepareSell: forbiddenWalletOperation,
  sendRawTransaction: forbiddenWalletOperation,
  waitForReceipt: forbiddenWalletOperation,
};

function holdingSession(pair: PairInfo, metadata: TokenMetadata): TokenSession {
  const entry: EntryExecution = {
    mode: 'dry-run',
    tradeId: 'entry-fixture',
    amountInWei: 5_000_000_000_000_000n,
    amountOutToken: 500_000_000_000_000_000n,
    confirmedAtMs: 2_000,
    cursor: { blockNumber: 11n, transactionIndex: 1, logIndex: 0 },
  };
  return {
    pair,
    metadata,
    status: 'HOLDING',
    entryObservationBuys: [],
    entry,
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 2,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1_000,
    updatedAtMs: 2_000,
  };
}

test('parcourt PairCreated jusqu’à CLOSED en dry-run avec audit PostgreSQL idempotent', async () => {
  await withMigratedSchema('complete_journey', async (database) => {
    const [
      { config },
      { PairAdmissionService },
      { EntryAmountService },
      { TradeExecutor },
      { PairCreatedListener },
      { SwapListener },
      { RuntimeRecoveryBarrier },
      {
        DiscoveredTokenRepository,
        RiskReportRepository,
        SessionRepository,
        SwapEventRepository,
        TradeRepository,
      },
      { SessionEngine },
    ] = await Promise.all([
      import('../../src/config/env.js'),
      import('../../src/discovery/pair-admission.service.js'),
      import('../../src/execution/entry-amount.service.js'),
      import('../../src/execution/trade-executor.js'),
      import('../../src/listeners/pair-created.listener.js'),
      import('../../src/listeners/swap.listener.js'),
      import('../../src/recovery/runtime-recovery-barrier.js'),
      import('../../src/storage/repositories.js'),
      import('../../src/strategy/session-engine.js'),
    ]);

    const pairAddress = address('4');
    const tokenAddress = address('5');
    const metadata: TokenMetadata = {
      address: tokenAddress,
      name: 'Deterministic Token',
      symbol: 'DET',
      decimals: 18,
      totalSupply: 1_000_000_000_000_000_000_000_000n,
      codeSizeBytes: 128,
    };
    const report: TokenRiskReport = {
      id: '00000000-0000-4000-8000-000000000001',
      token: tokenAddress,
      pair: pairAddress,
      blockNumber: 11n,
      score: 100,
      verdict: 'ALLOW',
      checks: [],
      summary: {
        liquidityWbnb: 100_000_000_000_000_000_000n,
        owner: null,
        implementation: null,
        lpBurnedBps: null,
        buyTaxBps: 0,
        sellTaxBps: 0,
        roundTripLossBps: 0,
        sensitiveSelectors: [],
      },
      createdAtMs: 1_100,
    };

    const sessions = new SessionRepository(database);
    const discovered = new DiscoveredTokenRepository(database);
    const events = new SwapEventRepository(database);
    const reports = new RiskReportRepository(database);
    const trades = new TradeRepository(database);
    const executor = new TradeExecutor(
      trades,
      deterministicGateway,
      'dry-run',
    );
    const engine = new SessionEngine(
      sessions,
      reports,
      { analyze: async () => report } as never,
      executor,
      new EntryAmountService({ getWalletBalanceWei: async () => null }),
      new RuntimeRecoveryBarrier(),
      events,
    );

    let scheduled = 0;
    const admission = new PairAdmissionService({
      sessions,
      discovered,
      ignored: { isIgnored: async () => false },
      metadata: { read: async () => metadata },
      isMonitored: () => false,
      scheduleMonitor: () => {
        scheduled += 1;
      },
      targetBuysAfterEntry: config.targetBuysAfterEntry,
      now: () => 1_000,
    });

    let activeRange = { from: 10n, to: 10n };
    let pairLogs: readonly unknown[] = [{
      args: {
        token0: config.wbnb,
        token1: tokenAddress,
        pair: pairAddress,
      },
      blockNumber: 10n,
      blockHash: header(10n).hash,
      transactionHash: hash(100),
      transactionIndex: 0,
      logIndex: 0,
    }];
    let swapLogs: readonly unknown[] = [];
    const silentWatcher = {
      watchContractEvent: () => () => {},
    };
    const coordinator = {
      reconcile: async (request: {
        processChunk(
          fromBlock: bigint,
          toBlock: bigint,
          headers: readonly CanonicalBlock[],
        ): Promise<boolean>;
      }) => {
        const headers = Array.from(
          { length: Number(activeRange.to - activeRange.from + 1n) },
          (_, index) => header(activeRange.from + BigInt(index)),
        );
        await request.processChunk(activeRange.from, activeRange.to, headers);
      },
    };

    const pairListener = new PairCreatedListener(
      admission.admit.bind(admission),
      {
        watcher: silentWatcher,
        logReader: { getContractEvents: async () => pairLogs },
        coordinator,
        reconcileIntervalMs: 60_000,
      },
    );
    await pairListener.reconcileNow();
    pairListener.stop();
    pairLogs = [];

    assert.equal(scheduled, 1);
    const discoveredSession = await sessions.findByPair(pairAddress);
    assert.equal(discoveredSession?.status, 'WAITING_FIRST_BUY');
    assert.ok(discoveredSession);

    const swapListener = new SwapListener(
      discoveredSession,
      engine,
      () => {},
      {
        watcher: silentWatcher,
        logReader: { getContractEvents: async () => swapLogs },
        coordinator,
        reconcileIntervalMs: 60_000,
      },
    );

    const entryLog = buyLog(11n);
    const entryHash = entryLog.transactionHash;
    activeRange = { from: 11n, to: 11n };
    swapLogs = [entryLog];
    assert.equal(await swapListener.runCanonicalReconcile(), undefined);
    assert.equal(discoveredSession.status, 'HOLDING');
    const buyCountAfterEntry = (
      await database.query("SELECT 1 FROM trades WHERE side = 'BUY'")
    ).rows.length;
    assert.equal(buyCountAfterEntry, 1);

    swapLogs = [entryLog];
    await swapListener.runCanonicalReconcile();
    assert.equal(discoveredSession.status, 'HOLDING');
    assert.equal(
      (await database.query("SELECT 1 FROM trades WHERE side = 'BUY'")).rows
        .length,
      buyCountAfterEntry,
    );

    activeRange = { from: 12n, to: 13n };
    swapLogs = [buyLog(12n), buyLog(13n)];
    await swapListener.runCanonicalReconcile();
    await swapListener.stopAndDrain();

    const finalSession = await sessions.findByPair(pairAddress);
    assert.equal(finalSession?.status, 'CLOSED');
    assert.equal(finalSession?.entry?.mode, 'dry-run');
    assert.equal(finalSession?.exit?.mode, 'dry-run');
    assert.equal(finalSession?.subsequentBuyCount, 2);
    assert.ok(finalSession?.riskReportId);

    const riskRows = await database.query<{
      verdict: string;
      source_event_id: string;
    }>('SELECT verdict, source_event_id FROM token_risk_reports');
    assert.deepEqual(riskRows.rows, [{
      verdict: 'ALLOW',
      source_event_id: `${entryHash.toLowerCase()}:0`,
    }]);

    const tradeRows = await database.query<{
      side: string;
      mode: string;
      status: string;
    }>(
      `SELECT side, mode, status
       FROM trades
       ORDER BY created_at, side`,
    );
    assert.deepEqual(tradeRows.rows, [
      { side: 'BUY', mode: 'dry-run', status: 'SIMULATED' },
      { side: 'SELL', mode: 'dry-run', status: 'SIMULATED' },
    ]);
    assert.equal(
      (await database.query('SELECT 1 FROM trade_transactions')).rows.length,
      0,
    );
    assert.equal(
      (await database.query('SELECT 1 FROM swap_events')).rows.length,
      3,
    );
    assert.equal(
      (
        await database.query(
          "SELECT 1 FROM swap_events WHERE processing_status <> 'PROCESSED'",
        )
      ).rows.length,
      0,
    );
    assert.equal(
      (
        await database.query(
          'SELECT 1 FROM discovered_tokens WHERE canonical = TRUE',
        )
      ).rows.length,
      1,
    );
  });
});

test('sérialise deux ventes manuelles concurrentes sans double trade', async () => {
  await withMigratedSchema('concurrent_sale', async (database) => {
    const [
      { EntryAmountService },
      { TradeExecutor },
      { SessionRepository, TradeRepository },
      { SessionEngine },
    ] = await Promise.all([
      import('../../src/execution/entry-amount.service.js'),
      import('../../src/execution/trade-executor.js'),
      import('../../src/storage/repositories.js'),
      import('../../src/strategy/session-engine.js'),
    ]);

    const pair: PairInfo = {
      factory: address('1'),
      router: address('2'),
      wbnb: address('3'),
      pair: address('6'),
      token: address('9'),
      token0: address('3'),
      token1: address('9'),
      createdBlock: 10n,
      blockHash: hash(10),
      createdTransactionHash: hash(110),
      createdLogIndex: 0,
      discoveredAtMs: 1_000,
    };
    const metadata: TokenMetadata = {
      address: pair.token,
      name: 'Position Fixture',
      symbol: 'POS',
      decimals: 18,
      totalSupply: 1_000_000n,
      codeSizeBytes: 100,
    };
    const holding = holdingSession(pair, metadata);
    const sessions = new SessionRepository(database);
    await sessions.save(holding);
    const executor = new TradeExecutor(
      new TradeRepository(database),
      deterministicGateway,
      'dry-run',
    );
    const engine = new SessionEngine(
      sessions,
      {} as never,
      {} as never,
      executor,
      new EntryAmountService({ getWalletBalanceWei: async () => null }),
    );

    const results = await Promise.allSettled([
      engine.sellManually(structuredClone(holding)),
      engine.sellManually(structuredClone(holding)),
    ]);

    assert.equal(
      results.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    const rejected = results.find(
      (result): result is PromiseRejectedResult =>
        result.status === 'rejected',
    );
    assert.match(
      rejected?.reason instanceof Error
        ? rejected.reason.message
        : String(rejected?.reason),
      /Aucune position ouverte à vendre/u,
    );
    assert.equal(
      (
        await database.query(
          "SELECT 1 FROM trades WHERE side = 'SELL'",
        )
      ).rows.length,
      1,
    );
    assert.equal(
      (await sessions.findByPair(holding.pair.pair))?.status,
      'CLOSED',
    );
  });
});
