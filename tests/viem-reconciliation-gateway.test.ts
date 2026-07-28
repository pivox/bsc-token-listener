import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
} from 'viem';
import { ViemReconciliationGateway } from '../src/recovery/viem-reconciliation.gateway.js';

const HASH = `0x${'1'.repeat(64)}` as Hash;
const WALLET = `0x${'2'.repeat(40)}` as Address;

interface TestReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  transactionIndex: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

function client(input: {
  receipt?: TestReceipt | Error;
  transaction?: object | Error;
  blockTransactions?: Array<Hash | { from: Address }>;
}) {
  return {
    async getTransactionReceipt(): Promise<TestReceipt> {
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
      transactions: Array<Hash | { from: Address }>;
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

test('lit les soldes au bloc du reçu et détecte un nonce wallet ultérieur', async () => {
  const calls: Array<{ kind: string; blockNumber: bigint }> = [];
  const gateway = new ViemReconciliationGateway({
    ...client({
      blockTransactions: [
        { from: WALLET },
        { from: WALLET },
      ],
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
    await gateway.hasLaterWalletTransactionInBlock(WALLET, 10n, 0),
    true,
  );
});
