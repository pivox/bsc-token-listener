import type { Address, Hash } from 'viem';
import type { ExecutionReceipt } from '../execution/execution.types.js';

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
