import type { Address, Hash } from 'viem';
import type { ExecutionMode } from '../config/env.js';

export type SessionStatus =
  | 'WAITING_FIRST_BUY'
  | 'CHECKING'
  | 'BUY_PENDING'
  | 'HOLDING'
  | 'SELL_PENDING'
  | 'CLOSED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'ERROR';

export type SwapKind = 'BUY' | 'SELL' | 'OTHER';
export type TradeSide = 'BUY' | 'SELL' | 'APPROVE';
export type TradeStatus = 'SIMULATED' | 'PENDING' | 'CONFIRMED' | 'FAILED' | 'UNKNOWN';

export interface ChainCursor {
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
}

export interface PairInfo {
  factory: Address;
  router: Address;
  pair: Address;
  token: Address;
  token0: Address;
  token1: Address;
  wbnb: Address;
  createdBlock: bigint;
  createdTransactionHash: Hash;
  createdLogIndex: number;
  discoveredAtMs: number;
}

export interface TokenMetadata {
  address: Address;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  codeSizeBytes: number;
}

export interface ClassifiedSwap {
  id: string;
  pair: Address;
  transactionHash: Hash;
  cursor: ChainCursor;
  sender: Address;
  recipient: Address;
  kind: SwapKind;
  amountWbnb: bigint;
  amountToken: bigint;
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
  observedAtMs: number;
}

export interface EntrySnapshot {
  mode: ExecutionMode;
  transactionHash: Hash | undefined;
  cursor: ChainCursor;
  amountInWei: bigint;
  amountOutToken: bigint;
  confirmedAtMs: number;
}

export interface ExitSnapshot {
  mode: ExecutionMode;
  transactionHash: Hash | undefined;
  cursor: ChainCursor;
  amountInToken: bigint;
  amountOutWei: bigint;
  confirmedAtMs: number;
}

export interface SessionSnapshot {
  pair: PairInfo;
  status: SessionStatus;
  targetBuysAfterEntry: number;
  metadata: TokenMetadata | undefined;
  firstBuy: ClassifiedSwap | undefined;
  entry: EntrySnapshot | undefined;
  exit: ExitSnapshot | undefined;
  subsequentBuyCount: number;
  countedBuyTransactionHashes: Hash[];
  lastProcessedCursor: ChainCursor | undefined;
  rejectionReason: string | undefined;
  lastError: string | undefined;
  sellAttempts: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface TradeRecord {
  id: string;
  pair: Address;
  token: Address;
  side: TradeSide;
  mode: ExecutionMode;
  status: TradeStatus;
  transactionHash: Hash | undefined;
  amountIn: bigint;
  amountOut: bigint;
  blockNumber: bigint | undefined;
  error: string | undefined;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface DiscoveredTokenRecord {
  address: Address;
  deploymentTransactionHash: Hash;
  deploymentBlock: bigint;
  deployer: Address;
  metadata: TokenMetadata | undefined;
  isProbableBep20: boolean;
  rejectionReason: string | undefined;
  discoveredAtMs: number;
}

export interface SafetyReport {
  accepted: boolean;
  metadata: TokenMetadata | undefined;
  wbnbLiquidityWei: bigint;
  probeStatus: 'PASSED' | 'SKIPPED' | 'FAILED';
  probeTokensBought: bigint;
  probeBnbRecovered: bigint;
  roundTripLossBps: number | undefined;
  reasons: string[];
}

export interface ExecutionResult {
  mode: ExecutionMode;
  transactionHash: Hash | undefined;
  cursor: ChainCursor;
  amountIn: bigint;
  amountOut: bigint;
  blockNumber: bigint;
}
