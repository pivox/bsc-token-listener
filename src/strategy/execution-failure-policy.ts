import {
  ExecutionMeasurementError,
  ExecutionOutcomeUnknownError,
  ExecutionRecoverySafetyError,
} from '../execution/trade-executor.js';
import type { ExecutionReconciliationReference, TokenSession } from '../types/domain.js';

export function requiresExecutionManualReview(error: unknown): boolean {
  return error instanceof ExecutionOutcomeUnknownError
    || error instanceof ExecutionMeasurementError
    || error instanceof ExecutionRecoverySafetyError;
}

export function executionToReconcile(
  error: unknown,
): ExecutionReconciliationReference | undefined {
  return error instanceof ExecutionMeasurementError
    || error instanceof ExecutionOutcomeUnknownError
    ? error.executionToReconcile
    : undefined;
}

export function hasUnreconciledConfirmedSell(session: TokenSession): boolean {
  return session.unreconciledExecution?.step === 'SELL';
}
