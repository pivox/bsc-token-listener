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

test('ALLOW lorsque tous les contrôles passent', () => {
  assert.deepEqual(evaluateRisk([pass], 80), { score: 100, verdict: 'ALLOW' });
});

test('REVIEW lorsqu’un avertissement est présent', () => {
  const warning: RiskCheck = { ...pass, code: 'WARN', status: 'WARN', penalty: 10 };
  assert.deepEqual(evaluateRisk([pass, warning], 80), { score: 90, verdict: 'REVIEW' });
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
