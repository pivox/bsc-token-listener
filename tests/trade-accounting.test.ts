import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateBuyPrincipal,
  calculateGasCost,
  calculateRealizedPnl,
  calculateSellProceeds,
} from '../src/execution/trade-accounting.js';

test('calcule le coût du gas sans convertir les montants en number', () => {
  assert.equal(calculateGasCost(21_000n, 3_000_000_000n), 63_000_000_000_000n);
});

test('isole le principal d’achat de la variation native incluant le gas', () => {
  const gasCostWei = 5n;
  assert.equal(calculateBuyPrincipal(1_000n, 895n, gasCostWei), 100n);
});

test('isole le produit de vente de la variation native diminuée du gas', () => {
  const gasCostWei = 5n;
  assert.equal(calculateSellProceeds(1_000n, 1_095n, gasCostWei), 100n);
});

test('calcule le PnL brut, le gas total et le PnL net', () => {
  assert.deepEqual(
    calculateRealizedPnl({
      buyPrincipalWei: 100n,
      sellProceedsWei: 150n,
      buyGasWei: 5n,
      approvalGasWei: 2n,
      sellGasWei: 7n,
    }),
    {
      grossPnlWei: 50n,
      totalGasWei: 14n,
      netPnlWei: 36n,
    },
  );
});

test('refuse des deltas de solde incompatibles avec une exécution confirmée', () => {
  assert.throws(
    () => calculateBuyPrincipal(100n, 101n, 1n),
    /variation native d'achat invalide/u,
  );
  assert.throws(
    () => calculateSellProceeds(101n, 99n, 1n),
    /variation native de vente invalide/u,
  );
});
