import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyBasisPointReduction,
  calculatePnl,
  formatPercentage,
} from '../src/dashboard/dashboard-metrics.js';

test('calcule un PnL positif sans convertir les montants en number', () => {
  const pnl = calculatePnl(1_000n, 1_250n);
  assert.equal(pnl.deltaWei, 250n);
  assert.equal(pnl.percentage, '25.00');
});

test('calcule un PnL négatif', () => {
  const pnl = calculatePnl(1_000n, 800n);
  assert.equal(pnl.deltaWei, -200n);
  assert.equal(pnl.percentage, '-20.00');
});

test('retourne un pourcentage nul quand le coût est nul', () => {
  assert.equal(formatPercentage(10n, 0n), null);
});

test('applique une estimation de taxe en points de base', () => {
  assert.equal(applyBasisPointReduction(1_000n, 1_500), 850n);
});

test('refuse une taxe hors limites', () => {
  assert.throws(() => applyBasisPointReduction(1_000n, 10_001));
});
