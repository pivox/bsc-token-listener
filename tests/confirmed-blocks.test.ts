import assert from 'node:assert/strict';
import test from 'node:test';
import {
  confirmedHead,
  readBlockConfirmations,
} from '../src/chain/confirmed-blocks.js';

test('utilise cinq confirmations par défaut', () => {
  assert.equal(readBlockConfirmations({}), 5);
});

test('refuse zéro et les valeurs non entières', () => {
  assert.throws(
    () => readBlockConfirmations({ BLOCK_CONFIRMATIONS: '0' }),
    /entier entre 1 et 100/u,
  );
  assert.throws(
    () => readBlockConfirmations({ BLOCK_CONFIRMATIONS: '2.5' }),
    /entier entre 1 et 100/u,
  );
});

test('calcule uniquement une tête suffisamment confirmée', () => {
  assert.equal(confirmedHead(20n, 5), 15n);
  assert.equal(confirmedHead(4n, 5), null);
});
