import assert from 'node:assert/strict';
import test from 'node:test';
import { applySlippage, calculateLossBps } from '../src/utils/math.js';

test('applique le slippage en points de base', () => {
  assert.equal(applySlippage(10_000n, 2500), 7_500n);
});

test('calcule la perte aller-retour en points de base', () => {
  assert.equal(calculateLossBps(10_000n, 7_500n), 2500);
  assert.equal(calculateLossBps(10_000n, 10_100n), 0);
});
