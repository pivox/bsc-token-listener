import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import { TradeRepository } from '../src/storage/repositories.js';
import type { TradeRecord, TradeTransactionRecord } from '../src/types/domain.js';

const ADDRESS = `0x${'1'.repeat(40)}` as Address;
const TOKEN = `0x${'2'.repeat(40)}` as Address;
const HASH = `0x${'3'.repeat(64)}` as Hash;

class FakeClient {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];

  async query(sql: string, values?: unknown[]): Promise<{ rows: never[] }> {
    this.calls.push({ sql, ...(values ? { values } : {}) });
    return { rows: [] };
  }

  release(): void {}
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
