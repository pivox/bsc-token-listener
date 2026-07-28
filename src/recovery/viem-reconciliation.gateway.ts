import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
} from 'viem';
import { erc20Abi } from '../abi/erc20.abi.js';
import { publicClient } from '../rpc/clients.js';
import type {
  ChainObservation,
  ReconciliationGateway,
} from './recovery.types.js';

interface ReceiptLike {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  transactionIndex: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

interface ReconciliationPublicClient {
  getTransactionReceipt(input: { hash: Hash }): Promise<ReceiptLike>;
  getTransaction(input: { hash: Hash }): Promise<unknown>;
  getBalance(input: { address: Address; blockNumber: bigint }): Promise<bigint>;
  getBlock(input: {
    blockNumber: bigint;
    includeTransactions: true;
  }): Promise<{
    transactions: readonly (
      | Hash
      | { from: Address }
    )[];
  }>;
  readContract(input: {
    address: Address;
    abi: typeof erc20Abi;
    functionName: 'balanceOf';
    args: readonly [Address];
    blockNumber: bigint;
  }): Promise<unknown>;
}

function errorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  if (error.name.length > 0 && error.name !== 'Error') return error.name;
  return error.constructor.name || 'Error';
}

export class ViemReconciliationGateway implements ReconciliationGateway {
  constructor(
    private readonly client: ReconciliationPublicClient =
      publicClient as unknown as ReconciliationPublicClient,
  ) {}

  async observeTransaction(hash: Hash): Promise<ChainObservation> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash });
      return {
        kind: 'RECEIPT',
        receipt: {
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          transactionIndex: receipt.transactionIndex,
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
        },
      };
    } catch (error) {
      if (!(error instanceof TransactionReceiptNotFoundError)) {
        return { kind: 'RPC_ERROR', errorType: errorType(error) };
      }
    }

    try {
      await this.client.getTransaction({ hash });
      return { kind: 'PENDING' };
    } catch (error) {
      return error instanceof TransactionNotFoundError
        ? { kind: 'ABSENT' }
        : { kind: 'RPC_ERROR', errorType: errorType(error) };
    }
  }

  getNativeBalance(wallet: Address, blockNumber: bigint): Promise<bigint> {
    return this.client.getBalance({ address: wallet, blockNumber });
  }

  async getTokenBalance(
    token: Address,
    wallet: Address,
    blockNumber: bigint,
  ): Promise<bigint> {
    const balance = await this.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [wallet],
      blockNumber,
    });
    if (typeof balance !== 'bigint') {
      throw new Error('Solde token RPC invalide.');
    }
    return balance;
  }

  async hasLaterWalletTransactionInBlock(
    wallet: Address,
    blockNumber: bigint,
    transactionIndex: number,
  ): Promise<boolean> {
    const block = await this.client.getBlock({
      blockNumber,
      includeTransactions: true,
    });
    return block.transactions
      .slice(transactionIndex + 1)
      .some((transaction) =>
        typeof transaction !== 'string'
        && transaction.from.toLowerCase() === wallet.toLowerCase());
  }
}
