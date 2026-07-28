import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
  type Hex,
} from 'viem';
import { ViemReconciliationGateway } from '../src/recovery/viem-reconciliation.gateway.js';

const HASH = `0x${'1'.repeat(64)}` as Hash;
const OTHER_HASH = `0x${'4'.repeat(64)}` as Hash;
const WALLET = `0x${'2'.repeat(40)}` as Address;
const TOKEN = `0x${'3'.repeat(40)}` as Address;

interface TestReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  transactionIndex: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs?: Array<{
    address: Address;
    topics: Hash[];
    data: Hex;
  }>;
}

type TestBlockTransaction = Hash | {
  hash: Hash;
  from: Address;
  to: Address | null;
};

function client(input: {
  receipt?: TestReceipt | Error;
  transaction?: object | Error;
  blockTransactions?: TestBlockTransaction[];
  laterReceipt?: TestReceipt;
}) {
  return {
    async getTransactionReceipt(request: { hash: Hash }): Promise<TestReceipt> {
      if (request.hash === OTHER_HASH && input.laterReceipt) {
        return input.laterReceipt;
      }
      if (input.receipt instanceof Error) throw input.receipt;
      if (!input.receipt) throw new Error('reçu de test absent');
      return input.receipt;
    },
    async getTransaction(): Promise<object> {
      if (input.transaction instanceof Error) throw input.transaction;
      return input.transaction ?? {};
    },
    async getBalance(): Promise<bigint> {
      return 1n;
    },
    async getBlock(): Promise<{
      transactions: TestBlockTransaction[];
    }> {
      return { transactions: input.blockTransactions ?? [] };
    },
    async readContract(): Promise<bigint> {
      return 2n;
    },
  };
}

test('retourne un reçu normalisé', async () => {
  const gateway = new ViemReconciliationGateway(client({
    receipt: {
      status: 'success',
      blockNumber: 10n,
      transactionIndex: 1,
      gasUsed: 2n,
      effectiveGasPrice: 3n,
    },
  }));

  assert.deepEqual(await gateway.observeTransaction(HASH), {
    kind: 'RECEIPT',
    receipt: {
      status: 'success',
      blockNumber: 10n,
      transactionIndex: 1,
      gasUsed: 2n,
      effectiveGasPrice: 3n,
    },
  });
});

test('distingue pending et hash absent', async () => {
  const pending = new ViemReconciliationGateway(client({
    receipt: new TransactionReceiptNotFoundError({ hash: HASH }),
    transaction: { hash: HASH },
  }));
  const absent = new ViemReconciliationGateway(client({
    receipt: new TransactionReceiptNotFoundError({ hash: HASH }),
    transaction: new TransactionNotFoundError({ hash: HASH }),
  }));

  assert.deepEqual(await pending.observeTransaction(HASH), { kind: 'PENDING' });
  assert.deepEqual(await absent.observeTransaction(HASH), { kind: 'ABSENT' });
});

test('ne conserve que le type d’une erreur RPC', async () => {
  class HttpRequestError extends Error {}
  const gateway = new ViemReconciliationGateway(client({
    receipt: new HttpRequestError('body: 0xsigned-secret'),
  }));

  assert.deepEqual(await gateway.observeTransaction(HASH), {
    kind: 'RPC_ERROR',
    errorType: 'HttpRequestError',
  });
});

test('ignore une transaction ultérieure sans effet sur le wallet', async () => {
  const otherWallet = `0x${'3'.repeat(40)}` as Address;
  const calls: Array<{ kind: string; blockNumber: bigint }> = [];
  const gateway = new ViemReconciliationGateway({
    ...client({
      blockTransactions: [
        { hash: HASH, from: WALLET, to: TOKEN },
        { hash: OTHER_HASH, from: otherWallet, to: TOKEN },
      ],
      laterReceipt: {
        status: 'success',
        blockNumber: 10n,
        transactionIndex: 1,
        gasUsed: 1n,
        effectiveGasPrice: 1n,
        logs: [],
      },
    }),
    async getBalance(input: {
      address: Address;
      blockNumber: bigint;
    }): Promise<bigint> {
      calls.push({ kind: 'native', blockNumber: input.blockNumber });
      return 1n;
    },
    async readContract(input: {
      blockNumber: bigint;
    }): Promise<bigint> {
      calls.push({ kind: 'token', blockNumber: input.blockNumber });
      return 2n;
    },
  });

  await gateway.getNativeBalance(WALLET, 10n);
  await gateway.getTokenBalance(WALLET, WALLET, 10n);

  assert.deepEqual(calls, [
    { kind: 'native', blockNumber: 10n },
    { kind: 'token', blockNumber: 10n },
  ]);
  assert.equal(
    await gateway.hasLaterWalletActivityInBlock(WALLET, TOKEN, 10n, 0),
    false,
  );
  assert.equal(
    await gateway.hasLaterWalletActivityInBlock(WALLET, TOKEN, 10n, 1),
    false,
  );
});

test('détecte un transfert direct ou BEP-20 ultérieur vers le wallet', async () => {
  const otherWallet = `0x${'5'.repeat(40)}` as Address;
  const direct = new ViemReconciliationGateway(client({
    blockTransactions: [
      { hash: HASH, from: WALLET, to: TOKEN },
      { hash: OTHER_HASH, from: otherWallet, to: WALLET },
    ],
  }));
  assert.equal(
    await direct.hasLaterWalletActivityInBlock(WALLET, TOKEN, 10n, 0),
    true,
  );

  const paddedWallet = `0x${WALLET.slice(2).padStart(64, '0')}` as Hash;
  const transferTopic = (
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  ) as Hash;
  const tokenTransfer = new ViemReconciliationGateway(client({
    blockTransactions: [
      { hash: HASH, from: WALLET, to: TOKEN },
      { hash: OTHER_HASH, from: otherWallet, to: TOKEN },
    ],
    laterReceipt: {
      status: 'success',
      blockNumber: 10n,
      transactionIndex: 1,
      gasUsed: 1n,
      effectiveGasPrice: 1n,
      logs: [{
        address: TOKEN,
        topics: [transferTopic, transferTopic, paddedWallet],
        data: '0x01',
      }],
    },
  }));
  assert.equal(
    await tokenTransfer.hasLaterWalletActivityInBlock(
      WALLET,
      TOKEN,
      10n,
      0,
    ),
    true,
  );
});
