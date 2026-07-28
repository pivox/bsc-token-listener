import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Address,
  type Hash,
  type Hex,
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
  logs?: readonly {
    address: Address;
    topics: readonly Hash[];
    data: Hex;
  }[];
}

interface ReconciliationPublicClient {
  getTransactionReceipt(input: { hash: Hash }): Promise<ReceiptLike>;
  getTransaction(input: { hash: Hash }): Promise<unknown>;
  getBalance(input: { address: Address; blockNumber: bigint }): Promise<bigint>;
  getCode(input: {
    address: Address;
    blockNumber: bigint;
  }): Promise<Hex | undefined>;
  getBlock(input: {
    blockNumber: bigint;
    includeTransactions: true;
  }): Promise<{
    transactions: readonly (
      | Hash
      | {
        hash: Hash;
        from: Address;
        to: Address | null;
      }
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

const TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

function topicContainsAddress(topic: Hash | undefined, address: Address): boolean {
  return topic?.slice(-40).toLowerCase() === address.slice(2).toLowerCase();
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

  async hasLaterWalletActivityInBlock(
    wallet: Address,
    token: Address,
    blockNumber: bigint,
    transactionIndex: number,
  ): Promise<boolean> {
    const block = await this.client.getBlock({
      blockNumber,
      includeTransactions: true,
    });
    const walletKey = wallet.toLowerCase();
    const tokenKey = token.toLowerCase();
    for (const transaction of block.transactions.slice(transactionIndex + 1)) {
      if (typeof transaction === 'string') return true;
      if (
        transaction.from.toLowerCase() === walletKey
        || transaction.to?.toLowerCase() === walletKey
      ) {
        return true;
      }
      if (!transaction.to) return true;
      const destinationCode = await this.client.getCode({
        address: transaction.to,
        blockNumber,
      });
      if (destinationCode && destinationCode !== '0x') return true;
      const receipt = await this.client.getTransactionReceipt({
        hash: transaction.hash,
      });
      const affectsTokenBalance = (receipt.logs ?? []).some((log) =>
        log.address.toLowerCase() === tokenKey
        && log.topics[0]?.toLowerCase() === TRANSFER_TOPIC
        && (
          topicContainsAddress(log.topics[1], wallet)
          || topicContainsAddress(log.topics[2], wallet)
        ));
      if (affectsTokenBalance) return true;
    }
    return false;
  }
}
