import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateEntryAmount, medianBigInt } from '../src/strategy/entry-sizing.js';

test('medianBigInt retourne la valeur centrale pour un tableau impair', () => {
  assert.equal(medianBigInt([5n, 1n, 9n]), 5n);
});

test('medianBigInt retourne la moyenne entière arrondie vers le bas pour un tableau pair', () => {
  assert.equal(medianBigInt([1n, 2n, 3n, 4n]), 2n);
});

test('medianBigInt ne convertit jamais en number', () => {
  assert.equal(
    medianBigInt([9007199254740990n, 9007199254740997n]),
    9007199254740993n,
  );
});

test('medianBigInt trie une copie sans muter l\'original', () => {
  const values = [10n, 5n, 1n];
  const original = [...values];
  assert.equal(medianBigInt(values), 5n);
  assert.deepEqual(values, original);
});

test('medianBigInt échoue explicitement avec un tableau vide', () => {
  assert.throws(() => medianBigInt([]), {
    message: 'medianBigInt: values must not be empty',
  });
});

test('calcule un montant minimum autorisé', () => {
  const amount = calculateEntryAmount(
    1_000n,
    [10n],
    10_000n,
    8n,
    10_000n,
    10_000,
    10_000,
    10_000,
    0n,
    1n,
  );
  assert.equal(amount, 10n);
});

test('limite le montant par la liquidité', () => {
  const amount = calculateEntryAmount(
    1_000n,
    [2_000n],
    10_000n,
    8n,
    10_000n,
    3_000,
    10_000,
    10_000,
    0n,
    100n,
  );
  assert.equal(amount, 300n);
});

test('limite le montant par le wallet', () => {
  const amount = calculateEntryAmount(
    10_000n,
    [10_000n],
    1_000n,
    8n,
    10_000n,
    10_000,
    10_000,
    5_000,
    100n,
    10n,
  );
  assert.equal(amount, 450n);
});

test('retourne null si le montant est sous le minimum', () => {
  const amount = calculateEntryAmount(
    10_000n,
    [10_000n],
    10_000n,
    30n,
    25n,
    10_000,
    10_000,
    10_000,
    0n,
    10n,
  );
  assert.equal(amount, null);
});
