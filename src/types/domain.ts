import type { Address, Hash } from 'viem';

export type ExecutionMode = 'dry-run' | 'live';
export type SessionStatus =
  | 'WAITING_FIRST_BUY'
  | 'RISK_CHECKING'
  | 'BUY_PENDING'
  | 'HOLDING'
  | 'SELL_PENDING'
  | 'CLOSED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'MANUAL_REVIEW';

export interface ChainCursor {
  blockNumber: bigint;
  transactionIndex: number;
  logIndex: number;
}

export interface PairInfo {
  factory: Address;
  router: Address;
  wbnb: Address;
  pair: Address;
  token: Address;
  token0: Address;
  token1: Address;
  createdBlock: bigint;
  createdTransactionHash: Hash;
  createdLogIndex: number;
  discoveredAtMs: number;
}

export interface TokenMetadata {
  address: Address;
  name: string | null;
  symbol: string | null;
  decimals: number;
  totalSupply: bigint;
  codeSizeBytes: number;
}

export type SwapKind = 'BUY' | 'SELL' | 'OTHER';

export interface SwapEvent {
  id: string;
  pair: Address;
  transactionHash: Hash;
  kind: SwapKind;
  sender: Address;
  recipient: Address;
  amount0In: bigint;
  amount1In: bigint;
  amount0Out: bigint;
  amount1Out: bigint;
  amountWbnb: bigint;
  amountToken: bigint;
  cursor: ChainCursor;
  observedAtMs: number;
}

export interface EntryExecution {
  mode: ExecutionMode;
  amountInWei: bigint;
  amountOutToken: bigint;
  confirmedAtMs: number;
  cursor: ChainCursor;
  transactionHash?: Hash;
}

export interface ExitExecution {
  mode: ExecutionMode;
  amountInToken: bigint;
  amountOutWei: bigint;
  confirmedAtMs: number;
  transactionHash?: Hash;
}

export interface TokenSession {
  pair: PairInfo;
  metadata: TokenMetadata;
  status: SessionStatus;
  firstBuy?: SwapEvent;
  entryObservationBuys?: SwapEvent[];
  entry?: EntryExecution;
  exit?: ExitExecution;
  subsequentBuyCount: number;
  targetBuysAfterEntry: number;
  countedBuyTransactionHashes: Hash[];
  lastProcessedCursor?: ChainCursor;
  rejectionReason?: string;
  riskReportId?: string;
  sellAttempts: number;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface TradeRecord {
  id: string;
  pair: Address;
  token: Address;
  side: 'BUY' | 'SELL';
  mode: ExecutionMode;
  status: 'PENDING' | 'SIMULATED' | 'CONFIRMED' | 'FAILED';
  amountIn: bigint;
  amountOut: bigint;
  transactionHash?: Hash;
  blockNumber?: bigint;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
}
