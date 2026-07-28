import type {
  ChainObservation,
  TransactionRecoveryDecision,
} from './recovery.types.js';

export function decideTransactionRecovery(input: {
  hasTransaction: boolean;
  observation: ChainObservation | null;
}): TransactionRecoveryDecision {
  if (!input.hasTransaction) return { kind: 'RESUME_INTENT' };
  if (!input.observation) {
    return {
      kind: 'MANUAL_REVIEW',
      reason: 'Observation on-chain manquante.',
    };
  }
  if (input.observation.kind === 'PENDING') {
    return { kind: 'WAIT', reason: 'Transaction encore pending.' };
  }
  if (input.observation.kind === 'ABSENT') {
    return { kind: 'MANUAL_REVIEW', reason: 'Hash absent du RPC.' };
  }
  if (input.observation.kind === 'RPC_ERROR') {
    return {
      kind: 'MANUAL_REVIEW',
      reason: `Lecture RPC impossible (${input.observation.errorType}).`,
    };
  }
  return input.observation.receipt.status === 'success'
    ? { kind: 'MEASURE', receipt: input.observation.receipt }
    : { kind: 'REVERT', receipt: input.observation.receipt };
}
