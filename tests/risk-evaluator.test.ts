import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateRisk } from '../src/security/risk-evaluator.js';
import type { RiskCheck } from '../src/security/token-risk.types.js';

const pass: RiskCheck = {
  code: 'PASS',
  label: 'Pass',
  status: 'PASS',
  critical: false,
  penalty: 0,
  message: 'ok',
};

const unknown: RiskCheck = {
  ...pass,
  code: 'UNKNOWN',
  status: 'UNKNOWN',
  penalty: 5,
};

test('ALLOW lorsque tous les contrôles passent', () => {
  assert.deepEqual(evaluateRisk([pass], 80), { score: 100, verdict: 'ALLOW' });
});

test('REVIEW lorsqu’un avertissement est présent', () => {
  const warning: RiskCheck = { ...pass, code: 'WARN', status: 'WARN', penalty: 10 };
  assert.deepEqual(evaluateRisk([pass, warning], 80), { score: 90, verdict: 'REVIEW' });
});

test('REVIEW par défaut lorsqu’une information est inconnue', () => {
  assert.deepEqual(evaluateRisk([pass, unknown], 80), { score: 95, verdict: 'REVIEW' });
});

test('ALLOW un UNKNOWN lorsque l’option est active et le seuil atteint', () => {
  assert.deepEqual(
    evaluateRisk([pass, unknown], 80, {
      allowUnknownReviews: true,
      allowUnknownMinScore: 95,
    }),
    { score: 95, verdict: 'ALLOW' },
  );
});

test('REVIEW un UNKNOWN lorsque le seuil dynamique n’est pas atteint', () => {
  assert.deepEqual(
    evaluateRisk([pass, unknown, { ...unknown, code: 'UNKNOWN_2' }], 80, {
      allowUnknownReviews: true,
      allowUnknownMinScore: 95,
    }),
    { score: 90, verdict: 'REVIEW' },
  );
});

test('un WARN reste REVIEW même quand les UNKNOWN sont autorisés', () => {
  const warning: RiskCheck = { ...pass, code: 'WARN', status: 'WARN', penalty: 5 };
  assert.deepEqual(
    evaluateRisk([pass, warning], 80, {
      allowUnknownReviews: true,
      allowUnknownMinScore: 95,
    }),
    { score: 95, verdict: 'REVIEW' },
  );
});

test('BLOCK sur échec critique', () => {
  const failure: RiskCheck = {
    ...pass,
    code: 'FAIL',
    status: 'FAIL',
    critical: true,
    penalty: 100,
  };
  assert.deepEqual(evaluateRisk([failure], 80), { score: 0, verdict: 'BLOCK' });
});
