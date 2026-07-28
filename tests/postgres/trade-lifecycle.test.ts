import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import type { Address, Hash } from 'viem';
import type { TradeRecord, TradeTransactionRecord } from '../../src/types/domain.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL est obligatoire pour les tests PostgreSQL.');
}

process.env.DATABASE_URL = testDatabaseUrl;
process.env.BSC_HTTP_RPC_URL ??= 'http://127.0.0.1:8545';
process.env.BSC_WS_RPC_URL ??= 'ws://127.0.0.1:8546';

const { Client } = pg;
const ADDRESS = `0x${'1'.repeat(40)}` as Address;
const TOKEN = `0x${'2'.repeat(40)}` as Address;
const HASH = `0x${'3'.repeat(64)}` as Hash;

test('migration idempotente, bigint exact et contraintes de déduplication', async () => {
  const client = new Client({ connectionString: testDatabaseUrl });
  const schema = `trade_lifecycle_${randomUUID().replaceAll('-', '')}`;
  await client.connect();

  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE trades (
        trade_id TEXT PRIMARY KEY,
        pair_address TEXT NOT NULL,
        token_address TEXT NOT NULL,
        side TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        transaction_hash TEXT,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);

    const migration = await readFile('migrations/005_trade_lifecycle.sql', 'utf8');
    await client.query(migration);
    await client.query(migration);

    const { TradeRepository } = await import('../../src/storage/repositories.js');
    const database = {
      query: client.query.bind(client),
      connect: async () => ({
        query: client.query.bind(client),
        release(): void {},
      }),
    };
    const repository = new TradeRepository(database);
    const huge = 9_007_199_254_740_993n;
    const trade: TradeRecord = {
      id: 'trade-postgres',
      pair: ADDRESS,
      token: TOKEN,
      side: 'BUY',
      mode: 'live',
      status: 'CREATED',
      amountIn: huge,
      amountOut: huge + 1n,
      quotedAmountOut: huge + 1n,
      walletAddress: ADDRESS,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    };
    const transaction: TradeTransactionRecord = {
      id: 'transaction-postgres',
      tradeId: trade.id,
      step: 'BUY',
      status: 'CREATED',
      walletAddress: ADDRESS,
      transactionHash: HASH,
      nonce: huge,
      toAddress: ADDRESS,
      valueWei: huge,
      nativeBalanceBefore: huge + 100n,
      tokenBalanceBefore: 0n,
      createdAtMs: 1_000,
      updatedAtMs: 1_000,
    };

    await repository.saveLifecycle(trade, transaction);

    const stored = await client.query<{
      nonce: string;
      value_wei: string;
      payload_nonce: string;
    }>(`
      SELECT
        nonce::text,
        value_wei::text,
        payload #>> '{nonce,__bsc_bot_bigint__}' AS payload_nonce
      FROM trade_transactions
      WHERE transaction_id = $1
    `, [transaction.id]);
    assert.equal(stored.rows[0]?.nonce, huge.toString());
    assert.equal(stored.rows[0]?.value_wei, huge.toString());
    assert.equal(stored.rows[0]?.payload_nonce, huge.toString());

    await assert.rejects(
      repository.saveLifecycle(trade, {
        ...transaction,
        id: 'duplicate-hash',
        nonce: huge + 1n,
      }),
      /idx_trade_transactions_hash/u,
    );
    await assert.rejects(
      repository.saveLifecycle(trade, {
        ...transaction,
        id: 'duplicate-nonce',
        transactionHash: `0x${'4'.repeat(64)}`,
      }),
      /idx_trade_transactions_wallet_nonce/u,
    );
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
