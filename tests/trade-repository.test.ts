import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import {
  DiscoveredTokenRepository,
  RiskReportRepository,
  SwapEventRepository,
  TradeRepository,
} from '../src/storage/repositories.js';
import type {
  PairInfo,
  SwapEvent,
  TokenSession,
  TradeRecord,
  TradeTransactionRecord,
} from '../src/types/domain.js';
import type { TokenRiskReport } from '../src/security/token-risk.types.js';

const ADDRESS = `0x${'1'.repeat(40)}` as Address;
const TOKEN = `0x${'2'.repeat(40)}` as Address;
const HASH = `0x${'3'.repeat(64)}` as Hash;

class FakeClient {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  updateRows = 1;

  async query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ sql, ...(values ? { values } : {}) });
    if (sql.includes('UPDATE swap_events') && sql.includes('RETURNING event_id')) {
      return {
        rows: this.updateRows === 1 ? [{ event_id: 'event-1' } as T] : [],
      };
    }
    return { rows: [] };
  }

  release(): void {}
}

class StatefulSwapClient extends FakeClient {
  row: {
    canonical: boolean;
    processingStatus: 'PENDING' | 'PROCESSING' | 'PROCESSED' | 'FAILED';
    blockHash: string;
  } | null;

  constructor(row: StatefulSwapClient['row']) {
    super();
    this.row = row;
  }

  override async query<T>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }> {
    this.calls.push({ sql, ...(values ? { values } : {}) });
    if (sql.includes('INSERT INTO swap_events')) {
      assert.match(sql, /WHERE swap_events\.canonical = FALSE/u);
      if (this.row === null) {
        this.row = {
          canonical: true,
          processingStatus: 'PENDING',
          blockHash: String(values?.[3]),
        };
      } else if (!this.row.canonical) {
        this.row = {
          canonical: true,
          processingStatus: 'PENDING',
          blockHash: String(values?.[3]),
        };
      }
      return { rows: [] };
    }
    if (sql.includes('UPDATE swap_events') && sql.includes('RETURNING event_id')) {
      assert.match(sql, /processing_status IN \('PENDING', 'FAILED'\)/u);
      if (
        this.row?.processingStatus === 'PENDING'
        || this.row?.processingStatus === 'FAILED'
      ) {
        this.row.processingStatus = 'PROCESSING';
        return { rows: [{ event_id: 'event-1' } as T] };
      }
      return { rows: [] };
    }
    return { rows: [] };
  }
}

function pair(): PairInfo {
  return {
    factory: ADDRESS,
    router: `0x${'4'.repeat(40)}` as Address,
    wbnb: `0x${'5'.repeat(40)}` as Address,
    pair: ADDRESS,
    token: TOKEN,
    token0: TOKEN,
    token1: `0x${'5'.repeat(40)}` as Address,
    createdBlock: 12n,
    blockHash: HASH,
    createdTransactionHash: `0x${'6'.repeat(64)}` as Hash,
    createdLogIndex: 3,
    discoveredAtMs: 1_000,
  };
}

function swapEvent(): SwapEvent {
  return {
    id: 'event-1',
    pair: ADDRESS,
    transactionHash: `0x${'7'.repeat(64)}` as Hash,
    blockHash: HASH,
    kind: 'BUY',
    sender: ADDRESS,
    recipient: TOKEN,
    amount0In: 1n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 2n,
    amountWbnb: 1n,
    amountToken: 2n,
    cursor: {
      blockNumber: 12n,
      transactionIndex: 2,
      logIndex: 3,
    },
    observedAtMs: 1_000,
  };
}

function session(status: TokenSession['status']): TokenSession {
  return {
    pair: pair(),
    metadata: {
      address: TOKEN,
      name: 'Token',
      symbol: 'TKN',
      decimals: 18,
      totalSupply: 100n,
      codeSizeBytes: 42,
    },
    status,
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
}

test('persiste atomiquement le trade et la transaction préparée avec ses bigint', async () => {
  const client = new FakeClient();
  const database = {
    query: client.query.bind(client),
    connect: async () => client,
  };
  const repository = new TradeRepository(database);
  const trade: TradeRecord = {
    id: 'trade-1',
    pair: ADDRESS,
    token: TOKEN,
    side: 'BUY',
    mode: 'live',
    status: 'CREATED',
    amountIn: 100n,
    amountOut: 200n,
    quotedAmountOut: 200n,
    walletAddress: ADDRESS,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };
  const transaction: TradeTransactionRecord = {
    id: 'transaction-1',
    tradeId: trade.id,
    step: 'BUY',
    status: 'CREATED',
    walletAddress: ADDRESS,
    transactionHash: HASH,
    nonce: 9_007_199_254_740_993n,
    toAddress: ADDRESS,
    valueWei: 100n,
    nativeBalanceBefore: 1_000n,
    tokenBalanceBefore: 50n,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  };

  await repository.saveLifecycle(trade, transaction);

  assert.match(client.calls[0]?.sql ?? '', /^BEGIN$/u);
  assert.match(client.calls[1]?.sql ?? '', /INSERT INTO trades/u);
  assert.match(client.calls[2]?.sql ?? '', /INSERT INTO trade_transactions/u);
  assert.match(client.calls[3]?.sql ?? '', /^COMMIT$/u);
  assert.equal(client.calls[2]?.values?.includes(transaction.nonce.toString()), true);
  assert.match(String(client.calls[2]?.values?.at(-3)), /__bsc_bot_bigint__/u);
});

test('rollback la transition atomique lorsque la transaction enfant échoue', async () => {
  const client = new FakeClient();
  const query = client.query.bind(client);
  client.query = async (sql: string, values?: unknown[]) => {
    if (sql.includes('INSERT INTO trade_transactions')) {
      throw new Error('unique violation');
    }
    return query(sql, values);
  };
  const database = {
    query: client.query.bind(client),
    connect: async () => client,
  };
  const repository = new TradeRepository(database);
  const trade = {
    id: 'trade-1',
    pair: ADDRESS,
    token: TOKEN,
    side: 'BUY',
    mode: 'live',
    status: 'CREATED',
    amountIn: 100n,
    amountOut: 200n,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  } satisfies TradeRecord;
  const transaction = {
    id: 'transaction-1',
    tradeId: trade.id,
    step: 'BUY',
    status: 'CREATED',
    walletAddress: ADDRESS,
    transactionHash: HASH,
    nonce: 1n,
    toAddress: ADDRESS,
    valueWei: 100n,
    createdAtMs: 1_000,
    updatedAtMs: 1_000,
  } satisfies TradeTransactionRecord;

  await assert.rejects(repository.saveLifecycle(trade, transaction), /unique violation/u);
  assert.equal(client.calls.at(-1)?.sql, 'ROLLBACK');
});

test('réclame atomiquement un swap avec hash et snapshot avant traitement', async () => {
  const client = new FakeClient();
  const repository = new SwapEventRepository({
    query: client.query.bind(client),
    connect: async () => client,
  });
  const event = swapEvent();
  const before = session('WAITING_FIRST_BUY');

  assert.equal(await repository.claim(event, before), true);

  assert.equal(client.calls[0]?.sql, 'BEGIN');
  assert.match(client.calls[1]?.sql ?? '', /block_hash/u);
  assert.match(client.calls[1]?.sql ?? '', /session_before/u);
  assert.match(client.calls[1]?.sql ?? '', /canonical/u);
  assert.match(client.calls[1]?.sql ?? '', /ON CONFLICT \(event_id\) DO UPDATE/u);
  assert.match(client.calls[1]?.sql ?? '', /WHERE swap_events\.canonical = FALSE/u);
  assert.deepEqual(client.calls[1]?.values?.slice(0, 8), [
    event.id,
    event.pair.toLowerCase(),
    event.transactionHash.toLowerCase(),
    event.blockHash.toLowerCase(),
    event.cursor.blockNumber.toString(),
    event.cursor.transactionIndex,
    event.cursor.logIndex,
    event.kind,
  ]);
  assert.match(String(client.calls[1]?.values?.at(-2)), /WAITING_FIRST_BUY/u);
  assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
});

test('ne réclame pas un doublon canonique déjà traité', async () => {
  const client = new StatefulSwapClient({
    canonical: true,
    processingStatus: 'PROCESSED',
    blockHash: HASH,
  });
  const repository = new SwapEventRepository({
    query: client.query.bind(client),
    connect: async () => client,
  });

  assert.equal(await repository.claim(swapEvent(), session('HOLDING')), false);
  assert.deepEqual(client.row, {
    canonical: true,
    processingStatus: 'PROCESSED',
    blockHash: HASH,
  });
  assert.equal(client.calls.at(-1)?.sql, 'COMMIT');
});

test('réactive uniquement un événement orphelin avec la nouvelle provenance et PENDING', async () => {
  const client = new StatefulSwapClient({
    canonical: false,
    processingStatus: 'PROCESSED',
    blockHash: HASH,
  });
  const repository = new SwapEventRepository({
    query: client.query.bind(client),
    connect: async () => client,
  });
  const event = {
    ...swapEvent(),
    blockHash: `0x${'8'.repeat(64)}` as Hash,
  };

  assert.equal(
    await repository.claim(event, session('WAITING_FIRST_BUY')),
    true,
  );

  const upsert = client.calls[1];
  assert.match(upsert?.sql ?? '', /block_hash = EXCLUDED\.block_hash/u);
  assert.match(upsert?.sql ?? '', /canonical = TRUE/u);
  assert.match(upsert?.sql ?? '', /orphaned_at = NULL/u);
  assert.match(upsert?.sql ?? '', /processing_status = 'PENDING'/u);
  assert.match(upsert?.sql ?? '', /processed_at = NULL/u);
  assert.match(upsert?.sql ?? '', /session_after = NULL/u);
  assert.equal(upsert?.values?.[3], event.blockHash.toLowerCase());
  assert.deepEqual(client.row, {
    canonical: true,
    processingStatus: 'PROCESSING',
    blockHash: event.blockHash.toLowerCase(),
  });
});

test('finalise un swap avec le snapshot de session après traitement', async () => {
  const client = new FakeClient();
  const repository = new SwapEventRepository({
    query: client.query.bind(client),
    connect: async () => client,
  });
  const after = session('HOLDING');

  await repository.markProcessed('event-1', after);

  assert.match(client.calls[0]?.sql ?? '', /session_after = \$2::jsonb/u);
  assert.match(client.calls[0]?.sql ?? '', /processing_status = 'PROCESSED'/u);
  assert.deepEqual(client.calls[0]?.values?.slice(0, 1), ['event-1']);
  assert.match(String(client.calls[0]?.values?.[1]), /HOLDING/u);
});

test('persiste la provenance canonique de la découverte', async () => {
  const client = new FakeClient();
  const repository = new DiscoveredTokenRepository({
    query: client.query.bind(client),
    connect: async () => client,
  });

  await repository.upsert({ pair: pair() });

  assert.match(client.calls[0]?.sql ?? '', /block_hash/u);
  assert.match(client.calls[0]?.sql ?? '', /canonical/u);
  assert.match(client.calls[0]?.sql ?? '', /block_hash = EXCLUDED\.block_hash/u);
  assert.match(client.calls[0]?.sql ?? '', /canonical = TRUE/u);
  assert.deepEqual(client.calls[0]?.values?.slice(0, 7), [
    TOKEN.toLowerCase(),
    ADDRESS.toLowerCase(),
    'PAIR_CREATED',
    pair().createdTransactionHash.toLowerCase(),
    '12',
    HASH.toLowerCase(),
    true,
  ]);
});

test('lie optionnellement un rapport de risque à son événement source canonique', async () => {
  const client = new FakeClient();
  const repository = new RiskReportRepository({
    query: client.query.bind(client),
    connect: async () => client,
  });
  const report = {
    id: '00000000-0000-4000-8000-000000000001',
    token: TOKEN,
    pair: ADDRESS,
    blockNumber: 12n,
    score: 90,
    verdict: 'ALLOW',
    checks: [],
    summary: {
      liquidityWbnb: null,
      owner: null,
      implementation: null,
      lpBurnedBps: null,
      buyTaxBps: null,
      sellTaxBps: null,
      roundTripLossBps: null,
      sensitiveSelectors: [],
    },
    createdAtMs: 1_000,
  } satisfies TokenRiskReport;

  await repository.save(report, 'event-1');

  assert.match(client.calls[0]?.sql ?? '', /source_event_id/u);
  assert.match(client.calls[0]?.sql ?? '', /canonical/u);
  assert.deepEqual(client.calls[0]?.values?.slice(-3), [
    'event-1',
    true,
    report.createdAtMs,
  ]);
});
