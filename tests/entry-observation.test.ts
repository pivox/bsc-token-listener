import assert from 'node:assert/strict';
import test from 'node:test';
import { recordEntryObservationBuy } from '../src/strategy/entry-observation.js';
import type { TokenSession, SwapEvent } from '../src/types/domain.js';

const tokenSession: TokenSession = {
  pair: {
    factory: '0x0000000000000000000000000000000000000001',
    router: '0x0000000000000000000000000000000000000002',
    wbnb: '0x0000000000000000000000000000000000000003',
    pair: '0x0000000000000000000000000000000000000004',
    token: '0x0000000000000000000000000000000000000005',
    token0: '0x0000000000000000000000000000000000000006',
    token1: '0x0000000000000000000000000000000000000007',
    createdBlock: 1n,
    blockHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    createdTransactionHash: '0x0000000000000000000000000000000000000000000000000000000000000001',
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

const baseEvent: SwapEvent = {
  id: 'event-1',
  pair: '0x0000000000000000000000000000000000000004',
  transactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  blockHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  kind: 'BUY',
  sender: '0x0000000000000000000000000000000000000008',
  recipient: '0x0000000000000000000000000000000000000009',
  amount0In: 1n,
  amount1In: 2n,
  amount0Out: 3n,
  amount1Out: 4n,
  amountWbnb: 5n,
  amountToken: 6n,
  cursor: {
    blockNumber: 1n,
    transactionIndex: 1,
    logIndex: 1,
  },
  observedAtMs: 0,
};

test('enregistre le premier achat et affecte firstBuy', () => {
  const session = structuredClone(tokenSession) as TokenSession;
  const event: SwapEvent = {
    ...baseEvent,
  };

  const result = recordEntryObservationBuy(session, event);

  assert.deepEqual(result, { added: true, count: 1 });
  assert.equal(session.firstBuy?.transactionHash, event.transactionHash);
  assert.equal(session.entryObservationBuys?.length, 1);
});

test('ignore une transaction duplicate quel que soit le casing', () => {
  const session = structuredClone(tokenSession) as TokenSession;
  const event: SwapEvent = {
    ...baseEvent,
  };
  const duplicate: SwapEvent = {
    ...baseEvent,
    transactionHash: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    id: 'event-2',
  };

  const first = recordEntryObservationBuy(session, event);
  const second = recordEntryObservationBuy(session, duplicate);

  assert.deepEqual(first, { added: true, count: 1 });
  assert.deepEqual(second, { added: false, count: 1 });
  assert.equal(session.entryObservationBuys?.length, 1);
});

test('ignore un événement non-BUY', () => {
  const session = structuredClone(tokenSession) as TokenSession;
  const event: SwapEvent = {
    ...baseEvent,
    kind: 'SELL',
    id: 'event-sell',
  };

  const result = recordEntryObservationBuy(session, event);

  assert.deepEqual(result, { added: false, count: 0 });
  assert.equal(session.entryObservationBuys, undefined);
  assert.equal(session.firstBuy, undefined);
});
