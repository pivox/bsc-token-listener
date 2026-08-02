import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import type { EntryAmountService } from '../src/execution/entry-amount.service.js';
import type { TradeExecutor } from '../src/execution/trade-executor.js';
import type { TokenRiskService } from '../src/security/token-risk.service.js';
import type { TokenRiskReport } from '../src/security/token-risk.types.js';
import type {
  RiskReportRepository,
  SessionRepository,
} from '../src/storage/repositories.js';
import type {
  PairInfo,
  SwapEvent,
  TokenMetadata,
  TokenSession,
} from '../src/types/domain.js';

process.env.ENTRY_OBSERVATION_BUYS = '3';
process.env.RISK_POLICY = 'allow-only';
process.env.MAX_CONCURRENT_POSITIONS = '1';

const address = (digit: string): Address =>
  `0x${digit.repeat(40)}` as Address;
const hash = (value: number): Hash =>
  `0x${value.toString(16).padStart(64, '0')}` as Hash;

const pair: PairInfo = {
  factory: address('1'),
  router: address('2'),
  wbnb: address('3'),
  pair: address('4'),
  token: address('5'),
  token0: address('3'),
  token1: address('5'),
  createdBlock: 10n,
  blockHash: hash(10),
  createdTransactionHash: hash(100),
  createdLogIndex: 0,
  discoveredAtMs: 1_000,
};

const metadata: TokenMetadata = {
  address: pair.token,
  name: 'Early Risk Fixture',
  symbol: 'ERF',
  decimals: 18,
  totalSupply: 1_000_000n,
  codeSizeBytes: 128,
};

function waitingSession(): TokenSession {
  return {
    pair: structuredClone(pair),
    metadata: structuredClone(metadata),
    status: 'WAITING_FIRST_BUY',
    entryObservationBuys: [],
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 2,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

function buyEvent(sequence: number): SwapEvent {
  const transactionHash = hash(1_000 + sequence);
  return {
    id: `${transactionHash.toLowerCase()}:0`,
    pair: pair.pair,
    transactionHash,
    blockHash: hash(10 + sequence),
    kind: 'BUY',
    sender: address('6'),
    recipient: address('7'),
    amount0In: 10_000_000_000_000_000n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 1_000_000_000_000_000_000n,
    amountWbnb: 10_000_000_000_000_000n,
    amountToken: 1_000_000_000_000_000_000n,
    cursor: {
      blockNumber: BigInt(10 + sequence),
      transactionIndex: 0,
      logIndex: 0,
    },
    observedAtMs: 1_000 + sequence,
  };
}

function report(
  id: string,
  verdict: TokenRiskReport['verdict'],
  blockNumber: bigint,
): TokenRiskReport {
  return {
    id,
    token: pair.token,
    pair: pair.pair,
    blockNumber,
    score: verdict === 'ALLOW' ? 100 : 20,
    verdict,
    checks: [],
    summary: {
      liquidityWbnb: 10_000_000_000_000_000_000n,
      owner: null,
      implementation: null,
      lpBurnedBps: null,
      buyTaxBps: 0,
      sellTaxBps: 0,
      roundTripLossBps: 0,
      sensitiveSelectors: [],
    },
    createdAtMs: 1_000,
  };
}

type RiskOutcome = TokenRiskReport['verdict'] | Error;

async function createHarness(outcomes: readonly RiskOutcome[]) {
  const { SessionEngine } = await import('../src/strategy/session-engine.js');
  let stored = waitingSession();
  let analyzeCalls = 0;
  let buyCalls = 0;
  const persistedReports: Array<{
    report: TokenRiskReport;
    sourceEventId: string | undefined;
  }> = [];
  const trace: string[] = [];

  const sessions = {
    findByPair: async () => structuredClone(stored),
    save: async (session: TokenSession) => {
      stored = structuredClone(session);
    },
    countOpenPositions: async () => 0,
  } as unknown as SessionRepository;

  const reports = {
    save: async (value: TokenRiskReport, sourceEventId?: string) => {
      persistedReports.push({ report: structuredClone(value), sourceEventId });
      trace.push(`report:${value.id}`);
    },
  } as unknown as RiskReportRepository;

  const risk = {
    analyze: async (input: { blockNumber: bigint }) => {
      const outcome = outcomes[analyzeCalls];
      analyzeCalls += 1;
      if (outcome === undefined) {
        throw new Error('Résultat de risque manquant dans le test.');
      }
      if (outcome instanceof Error) throw outcome;
      return report(
        `00000000-0000-4000-8000-${String(analyzeCalls).padStart(12, '0')}`,
        outcome,
        input.blockNumber,
      );
    },
  } as unknown as TokenRiskService;

  const executor = {
    buy: async (
      session: TokenSession,
      amountInWei: bigint,
      sourceEventId?: string,
    ) => {
      buyCalls += 1;
      trace.push(`buy:${sourceEventId ?? 'none'}`);
      assert.ok(session.firstBuy);
      return {
        mode: 'dry-run' as const,
        amountInWei,
        amountOutToken: amountInWei * 100n,
        confirmedAtMs: 2_000,
        cursor: structuredClone(session.firstBuy.cursor),
      };
    },
  } as unknown as TradeExecutor;

  const amountService = {
    resolve: async () => 5_000_000_000_000_000n,
  } as unknown as EntryAmountService;

  const engine = new SessionEngine(
    sessions,
    reports,
    risk,
    executor,
    amountService,
  );
  const session = structuredClone(stored);

  return {
    engine,
    session,
    persistedReports,
    trace,
    get analyzeCalls(): number {
      return analyzeCalls;
    },
    get buyCalls(): number {
      return buyCalls;
    },
    get stored(): TokenSession {
      return structuredClone(stored);
    },
  };
}

test('pré-analyse au premier achat puis revalide avant l’entrée au troisième', async () => {
  const harness = await createHarness(['ALLOW', 'ALLOW']);
  const first = buyEvent(1);
  const second = buyEvent(2);
  const third = buyEvent(3);

  await harness.engine.onSwap(harness.session, first);

  assert.equal(harness.session.status, 'WAITING_FIRST_BUY');
  assert.equal(harness.session.entryObservationBuys?.length, 1);
  assert.equal(harness.analyzeCalls, 1);
  assert.equal(harness.buyCalls, 0);
  assert.equal(harness.persistedReports.length, 1);
  assert.equal(harness.persistedReports[0]?.sourceEventId, first.id);
  assert.equal(harness.session.riskReportId, harness.persistedReports[0]?.report.id);

  await harness.engine.onSwap(harness.session, second);

  assert.equal(harness.session.status, 'WAITING_FIRST_BUY');
  assert.equal(harness.session.entryObservationBuys?.length, 2);
  assert.equal(harness.analyzeCalls, 1);
  assert.equal(harness.persistedReports.length, 1);

  await harness.engine.onSwap(harness.session, third);

  assert.equal(harness.session.status, 'HOLDING');
  assert.equal(harness.analyzeCalls, 2);
  assert.equal(harness.buyCalls, 1);
  assert.equal(harness.persistedReports.length, 2);
  assert.equal(harness.persistedReports[1]?.sourceEventId, third.id);
  assert.equal(harness.session.riskReportId, harness.persistedReports[1]?.report.id);
  assert.deepEqual(harness.trace.slice(-2), [
    `report:${harness.persistedReports[1]?.report.id}`,
    `buy:${third.id}`,
  ]);
});

test('ne laisse pas un ALLOW précoce contourner un BLOCK juste avant l’entrée', async () => {
  const harness = await createHarness(['ALLOW', 'BLOCK']);

  await harness.engine.onSwap(harness.session, buyEvent(1));
  await harness.engine.onSwap(harness.session, buyEvent(2));
  await harness.engine.onSwap(harness.session, buyEvent(3));

  assert.equal(harness.session.status, 'REJECTED');
  assert.match(harness.session.rejectionReason ?? '', /TokenRiskReport BLOCK/u);
  assert.equal(harness.analyzeCalls, 2);
  assert.equal(harness.persistedReports.length, 2);
  assert.equal(harness.buyCalls, 0);
});

test('rejette immédiatement une pré-analyse bloquante sans attendre trois achats', async () => {
  const harness = await createHarness(['BLOCK']);
  const first = buyEvent(1);

  await harness.engine.onSwap(harness.session, first);

  assert.equal(harness.session.status, 'REJECTED');
  assert.match(harness.session.rejectionReason ?? '', /Pré-analyse de risque BLOCK/u);
  assert.equal(harness.session.entryObservationBuys?.length, 1);
  assert.equal(harness.analyzeCalls, 1);
  assert.equal(harness.persistedReports.length, 1);
  assert.equal(harness.buyCalls, 0);
});

test('réessaie la pré-analyse au prochain achat après une erreur RPC transitoire', async () => {
  const harness = await createHarness([
    new Error('RPC indisponible'),
    'ALLOW',
    'ALLOW',
  ]);
  const first = buyEvent(1);
  const second = buyEvent(2);
  const third = buyEvent(3);

  await harness.engine.onSwap(harness.session, first);

  assert.equal(harness.session.status, 'WAITING_FIRST_BUY');
  assert.equal(harness.session.riskReportId, undefined);
  assert.equal(harness.analyzeCalls, 1);
  assert.equal(harness.persistedReports.length, 0);

  await harness.engine.onSwap(harness.session, second);

  assert.equal(harness.session.status, 'WAITING_FIRST_BUY');
  assert.ok(harness.session.riskReportId);
  assert.equal(harness.analyzeCalls, 2);
  assert.equal(harness.persistedReports.length, 1);

  await harness.engine.onSwap(harness.session, third);

  assert.equal(harness.session.status, 'HOLDING');
  assert.equal(harness.analyzeCalls, 3);
  assert.equal(harness.persistedReports.length, 2);
  assert.equal(harness.buyCalls, 1);
  assert.equal(harness.stored.status, 'HOLDING');
});
