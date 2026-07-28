import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ExecutionMeasurementError,
  ExecutionOutcomeUnknownError,
  ExecutionRevertedError,
} from '../src/execution/trade-executor.js';
import { requiresExecutionManualReview } from '../src/strategy/execution-failure-policy.js';

test('demande une revue manuelle pour une diffusion au résultat inconnu', () => {
  assert.equal(
    requiresExecutionManualReview(new ExecutionOutcomeUnknownError('RPC inconnu')),
    true,
  );
});

test('demande une revue manuelle pour une confirmation non mesurable', () => {
  assert.equal(
    requiresExecutionManualReview(new ExecutionMeasurementError('mesure impossible')),
    true,
  );
});

test('ne classe pas un revert prouvé comme ambigu', () => {
  assert.equal(
    requiresExecutionManualReview(new ExecutionRevertedError('revert')),
    false,
  );
  assert.equal(requiresExecutionManualReview(new Error('préparation impossible')), false);
});
