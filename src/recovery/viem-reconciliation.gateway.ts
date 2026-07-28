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
  getBalance(input: { address: Address }): Promise<bigint>;
  readContract(input: {
    address: Address;
    abi: typeof erc20Abi;
    functionName: 'balanceOf';
    args: readonly [Address];
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

  getNativeBalance(wallet: Address): Promise<bigint> {
    return this.client.getBalance({ address: wallet });
  }

  async getTokenBalance(token: Address, wallet: Address): Promise<bigint> {
    const balance = await this.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [wallet],
    });
    if (typeof balance !== 'bigint') {
      throw new Error('Solde token RPC invalide.');
    }
    return balance;
  }
}
