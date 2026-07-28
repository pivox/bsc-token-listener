import {
  ExecutionMeasurementError,
  ExecutionOutcomeUnknownError,
} from '../execution/trade-executor.js';

export function requiresExecutionManualReview(error: unknown): boolean {
  return error instanceof ExecutionOutcomeUnknownError
    || error instanceof ExecutionMeasurementError;
}
