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
  tradeId?: string;
  amountInWei: bigint;
  quotedAmountOutToken?: bigint;
  amountOutToken: bigint;
  gasCostWei?: bigint;
  confirmedAtMs: number;
  cursor: ChainCursor;
  transactionHash?: Hash;
}

export interface ExitExecution {
  mode: ExecutionMode;
  tradeId?: string;
  entryTradeId?: string;
  amountInToken: bigint;
  quotedAmountOutWei?: bigint;
  amountOutWei: bigint;
  gasCostWei?: bigint;
  confirmedAtMs: number;
  transactionHash?: Hash;
}

export interface ExecutionReconciliationReference {
  tradeId: string;
  step: TradeTransactionStep;
  outcome: 'CONFIRMED' | 'UNKNOWN';
  transactionHash: Hash;
  recordedAtMs: number;
}

export interface TokenSession {
  pair: PairInfo;
  metadata: TokenMetadata;
  status: SessionStatus;
  firstBuy?: SwapEvent;
  entryObservationBuys?: SwapEvent[];
  entry?: EntryExecution;
  exit?: ExitExecution;
  unreconciledExecution?: ExecutionReconciliationReference;
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

export type TradeSide = 'BUY' | 'SELL';
export type TradeStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'REVERTED'
  | 'UNKNOWN'
  | 'FAILED'
  | 'SIMULATED';
export type TradeTransactionStep = 'BUY' | 'APPROVE' | 'SELL';
export type TradeTransactionStatus =
  | 'CREATED'
  | 'SUBMITTED'
  | 'CONFIRMED'
  | 'REVERTED'
  | 'UNKNOWN';

export interface TradeRecord {
  id: string;
  pair: Address;
  token: Address;
  side: TradeSide;
  mode: ExecutionMode;
  status: TradeStatus;
  amountIn: bigint;
  amountOut: bigint;
  quotedAmountOut?: bigint;
  actualAmountIn?: bigint;
  actualAmountOut?: bigint;
  gasCostWei?: bigint;
  walletAddress?: Address;
  relatedTradeId?: string;
  transactionHash?: Hash;
  blockNumber?: bigint;
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface TradeTransactionRecord {
  id: string;
  tradeId: string;
  step: TradeTransactionStep;
  status: TradeTransactionStatus;
  walletAddress: Address;
  transactionHash: Hash;
  nonce: bigint;
  toAddress: Address;
  valueWei: bigint;
  blockNumber?: bigint;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  gasCostWei?: bigint;
  receiptStatus?: 'success' | 'reverted';
  nativeBalanceBefore?: bigint;
  nativeBalanceAfter?: bigint;
  tokenBalanceBefore?: bigint;
  tokenBalanceAfter?: bigint;
  error?: string;
  measurementError?: string;
  submittedAtMs?: number;
  confirmedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}
