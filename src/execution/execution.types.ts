import type { Address, Hash, Hex } from 'viem';
import type {
  ExecutionMode,
  TradeRecord,
  TradeTransactionRecord,
  TradeTransactionStep,
} from '../types/domain.js';

export interface PreparedExecutionTransaction {
  step: TradeTransactionStep;
  hash: Hash;
  nonce: bigint;
  walletAddress: Address;
  toAddress: Address;
  valueWei: bigint;
  serializedTransaction: Hex;
}

export interface ExecutionReceipt {
  status: 'success' | 'reverted';
  blockNumber: bigint;
  transactionIndex: number;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

export interface ExecutionGateway {
  readonly walletAddress: Address | null;
  quote(input: {
    router: Address;
    path: readonly [Address, Address];
    amountIn: bigint;
  }): Promise<bigint>;
  getTokenBalance(token: Address, wallet: Address): Promise<bigint>;
  getNativeBalance(wallet: Address): Promise<bigint>;
  getAllowance(input: {
    token: Address;
    owner: Address;
    spender: Address;
  }): Promise<bigint>;
  prepareBuy(input: {
    router: Address;
    path: readonly [Address, Address];
    amountInWei: bigint;
    minimumOut: bigint;
    deadline: bigint;
  }): Promise<PreparedExecutionTransaction>;
  prepareApproval(input: {
    token: Address;
    spender: Address;
    amount: bigint;
  }): Promise<PreparedExecutionTransaction>;
  prepareSell(input: {
    router: Address;
    path: readonly [Address, Address];
    amountInToken: bigint;
    minimumOut: bigint;
    deadline: bigint;
  }): Promise<PreparedExecutionTransaction>;
  sendRawTransaction(serializedTransaction: Hex): Promise<Hash>;
  waitForReceipt(hash: Hash): Promise<ExecutionReceipt>;
}

export interface TradeStore {
  save(trade: TradeRecord): Promise<void>;
  saveLifecycle(
    trade: TradeRecord,
    transaction: TradeTransactionRecord,
  ): Promise<void>;
}

export interface TradeExecutorOptions {
  mode: ExecutionMode;
  now: () => number;
}
