import type { Address, Hash } from 'viem';
import type { ExecutionReceipt } from '../execution/execution.types.js';
import type {
  TokenSession,
  TradeRecord,
  TradeTransactionRecord,
} from '../types/domain.js';

export type ChainObservation =
  | { kind: 'PENDING' }
  | { kind: 'ABSENT' }
  | { kind: 'RPC_ERROR'; errorType: string }
  | { kind: 'RECEIPT'; receipt: ExecutionReceipt };

export type TransactionRecoveryDecision =
  | { kind: 'RESUME_INTENT' }
  | { kind: 'WAIT'; reason: string }
  | { kind: 'MEASURE'; receipt: ExecutionReceipt }
  | { kind: 'REVERT'; receipt: ExecutionReceipt }
  | { kind: 'MANUAL_REVIEW'; reason: string };

export interface ReconciliationGateway {
  observeTransaction(hash: Hash): Promise<ChainObservation>;
  getNativeBalance(wallet: Address): Promise<bigint>;
  getTokenBalance(token: Address, wallet: Address): Promise<bigint>;
}

export interface RecoverySnapshot {
  session: TokenSession;
  trades: TradeRecord[];
  transactions: TradeTransactionRecord[];
}

export interface ClaimedRecovery {
  owner: string;
  statusBefore: TokenSession['status'];
  snapshot: RecoverySnapshot;
}

export interface RecoveryDecision {
  idempotencyKey: string;
  session: TokenSession;
  action: string;
  reason: string;
  trade?: TradeRecord;
  transaction?: TradeTransactionRecord;
}

export interface ReconciliationStore {
  claimNext(owner: string, leaseMs: number): Promise<ClaimedRecovery | null>;
  applyDecision(claimed: ClaimedRecovery, decision: RecoveryDecision): Promise<void>;
  tryAcquirePassLock(): Promise<boolean>;
  releasePassLock(): Promise<void>;
}
