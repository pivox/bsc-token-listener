import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import type { SwapEvent, TokenSession } from '../../src/types/domain.js';
import { withMigratedSchema } from './test-database.js';

process.env.BSC_HTTP_RPC_URL ??= 'http://127.0.0.1:8545';
process.env.BSC_WS_RPC_URL ??= 'ws://127.0.0.1:8546';
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;

const address = (digit: string): Address =>
  `0x${digit.repeat(40)}` as Address;
const hash = (digit: string): Hash => `0x${digit.repeat(64)}` as Hash;

function fixture(): { event: SwapEvent; session: TokenSession } {
  const pair = address('2');
  const event: SwapEvent = {
    id: `${hash('a')}:7`,
    pair,
    transactionHash: hash('a'),
    blockHash: hash('b'),
    kind: 'BUY',
    sender: address('3'),
    recipient: address('4'),
    amount0In: 10n,
    amount1In: 0n,
    amount0Out: 0n,
    amount1Out: 20n,
    amountWbnb: 10n,
    amountToken: 20n,
    cursor: { blockNumber: 12n, transactionIndex: 3, logIndex: 7 },
    observedAtMs: 1_000,
  };
  return {
    event,
    session: {
      pair: {
        factory: address('1'),
        router: address('5'),
        wbnb: address('6'),
        pair,
        token: address('7'),
        token0: address('6'),
        token1: address('7'),
        createdBlock: 10n,
        blockHash: hash('8'),
        createdTransactionHash: hash('9'),
        createdLogIndex: 0,
        discoveredAtMs: 900,
      },
      metadata: {
        address: address('7'),
        name: 'Fixture',
        symbol: 'FIX',
        decimals: 18,
        totalSupply: 1_000n,
        codeSizeBytes: 10,
      },
      status: 'WAITING_FIRST_BUY',
      entryObservationBuys: [],
      subsequentBuyCount: 0,
      targetBuysAfterEntry: 2,
      countedBuyTransactionHashes: [],
      sellAttempts: 0,
      createdAtMs: 900,
      updatedAtMs: 900,
    },
  };
}

test('persiste transactionIndex/logIndex exacts et ne réclame pas un événement traité', async () => {
  await withMigratedSchema('swap_identity', async (database) => {
    const { SwapEventRepository } = await import(
      '../../src/storage/repositories.js'
    );
    const repository = new SwapEventRepository(database);
    const { event, session } = fixture();

    assert.equal(await repository.claim(event, session), true);
    await repository.markProcessed(event.id, session);
    assert.equal(await repository.claim(event, session), false);

    const result = await database.query<{
      transaction_index: number;
      log_index: number;
      kind: string;
      processing_status: string;
    }>(
      `SELECT transaction_index, log_index, kind, processing_status
       FROM swap_events
       WHERE event_id = $1`,
      [event.id],
    );
    assert.deepEqual(result.rows[0], {
      transaction_index: 3,
      log_index: 7,
      kind: 'BUY',
      processing_status: 'PROCESSED',
    });
  });
});

test('reprend FAILED et PROCESSING expiré mais pas PROCESSING récent', async () => {
  await withMigratedSchema('swap_retry', async (database) => {
    const { SwapEventRepository } = await import(
      '../../src/storage/repositories.js'
    );
    const repository = new SwapEventRepository(database);
    const { event, session } = fixture();

    assert.equal(await repository.claim(event, session), true);
    assert.equal(await repository.claim(event, session), false);
    await repository.markFailed(event.id, 'fixture');
    assert.equal(await repository.claim(event, session), true);
    await database.query(
      `UPDATE swap_events
       SET updated_at = NOW() - INTERVAL '61 seconds'
       WHERE event_id = $1`,
      [event.id],
    );
    assert.equal(await repository.claim(event, session), true);
  });
});
