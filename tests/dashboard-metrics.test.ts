import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyBasisPointReduction,
  calculatePnl,
  formatPercentage,
} from '../src/dashboard/dashboard-metrics.js';
import { buildPositionExitView } from '../src/dashboard/dashboard.js';
import { defaultPositionExitSettings } from '../src/strategy/position-exit-settings.js';
import type { TokenSession } from '../src/types/domain.js';

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

test('expose l’état persistant de la politique de sortie sans RPC', () => {
  const value = buildPositionExitView(
    {
      entry: {
        mode: 'dry-run',
        amountInWei: 1_000n,
        amountOutToken: 1n,
        gasCostWei: 100n,
        confirmedAtMs: 1_000,
        cursor: { blockNumber: 1n, transactionIndex: 0, logIndex: 0 },
      },
      exitPolicy: {
        nextEvaluationAtMs: 3_000,
        latestNetValueWei: 1_210n,
        referenceLiquidityWbnbWei: 10_000n,
        currentLiquidityWbnbWei: 9_000n,
        peakNetValueWei: 1_300n,
        trailingArmedAtMs: 2_000,
        lastProbeStatus: 'SAFE',
        lastProbeAtMs: 2_500,
        lastReason: 'HOLD',
        settingsRevision: 4,
      },
    } as TokenSession,
    defaultPositionExitSettings(),
    2_000,
  );

  assert.equal(value?.netValueBnb, '0.00000000000000121');
  assert.equal(value?.economicPnlPercent, '10.00');
  assert.equal(value?.remainingHoldingSeconds, 1_799);
  assert.equal(value?.stopLossPercent, '-10.00');
  assert.equal(value?.takeProfitPercent, '20.00');
  assert.equal(value?.trailingArmed, true);
  assert.equal(value?.settingsRevision, 4);
});
