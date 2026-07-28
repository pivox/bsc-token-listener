import assert from 'node:assert/strict';
import test from 'node:test';
import { decideTransactionRecovery } from '../src/recovery/reconciliation-policy.js';

test('reprend une intention sans transaction enfant', () => {
  assert.deepEqual(
    decideTransactionRecovery({ hasTransaction: false, observation: null }),
    { kind: 'RESUME_INTENT' },
  );
});

test('attend une transaction encore pending sans la rediffuser', () => {
  assert.deepEqual(
    decideTransactionRecovery({
      hasTransaction: true,
      observation: { kind: 'PENDING' },
    }),
    { kind: 'WAIT', reason: 'Transaction encore pending.' },
  );
});

test('envoie en revue manuelle un hash absent', () => {
  assert.deepEqual(
    decideTransactionRecovery({
      hasTransaction: true,
      observation: { kind: 'ABSENT' },
    }),
    { kind: 'MANUAL_REVIEW', reason: 'Hash absent du RPC.' },
  );
});

test('filtre le diagnostic d’une erreur RPC', () => {
  assert.deepEqual(
    decideTransactionRecovery({
      hasTransaction: true,
      observation: { kind: 'RPC_ERROR', errorType: 'HttpRequestError' },
    }),
    {
      kind: 'MANUAL_REVIEW',
      reason: 'Lecture RPC impossible (HttpRequestError).',
    },
  );
});

test('distingue reçu confirmé et revert', () => {
  const receipt = {
    blockNumber: 10n,
    transactionIndex: 1,
    gasUsed: 2n,
    effectiveGasPrice: 3n,
  };
  assert.equal(
    decideTransactionRecovery({
      hasTransaction: true,
      observation: { kind: 'RECEIPT', receipt: { ...receipt, status: 'success' } },
    }).kind,
    'MEASURE',
  );
  assert.equal(
    decideTransactionRecovery({
      hasTransaction: true,
      observation: { kind: 'RECEIPT', receipt: { ...receipt, status: 'reverted' } },
    }).kind,
    'REVERT',
  );
});
