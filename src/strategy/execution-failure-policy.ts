import {
  ExecutionMeasurementError,
  ExecutionOutcomeUnknownError,
} from '../execution/trade-executor.js';
import type { ConfirmedExecutionReference, TokenSession } from '../types/domain.js';

export function requiresExecutionManualReview(error: unknown): boolean {
  return error instanceof ExecutionOutcomeUnknownError
    || error instanceof ExecutionMeasurementError;
}

export function confirmedExecutionToReconcile(
  error: unknown,
): ConfirmedExecutionReference | undefined {
  return error instanceof ExecutionMeasurementError
    ? error.confirmedExecution
    : undefined;
}

export function hasUnreconciledConfirmedSell(session: TokenSession): boolean {
  return session.unreconciledExecution?.step === 'SELL';
}
