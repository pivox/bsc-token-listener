import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluatePositionExit,
  prudentNetExitValue,
} from '../src/strategy/position-exit-evaluator.js';
import { defaultPositionExitSettings } from '../src/strategy/position-exit-settings.js';
import type {
  ExitEvaluationInput,
  PositionExitState,
  PositionMetricsSnapshot,
} from '../src/strategy/position-exit.types.js';

const NOW = 2_000_000;

function input(
  metricsPatch: Partial<PositionMetricsSnapshot> = {},
  statePatch: Partial<PositionExitState> = {},
  settingsPatch: Partial<ReturnType<typeof defaultPositionExitSettings>> = {},
): ExitEvaluationInput {
  return {
    nowMs: NOW,
    openedAtMs: NOW - 60_000,
    observedBuysAfterEntry: 0,
    settings: Object.freeze({
      ...defaultPositionExitSettings(),
      ...settingsPatch,
    }),
    state: Object.freeze({ ...statePatch }),
    metrics: Object.freeze({
      quoteWei: 1_000n,
      entryCostWei: 1_000n,
      netExitValueWei: 1_000n,
      currentLiquidityWbnbWei: 1_000n,
      estimatedExitGasWei: 10n,
      sellTaxBps: 0,
      probeStatus: 'SAFE',
      probeMeasuredAtMs: NOW,
      ...metricsPatch,
    }),
  };
}

test('calcule la valeur de sortie prudente sans montant négatif', () => {
  assert.equal(
    prudentNetExitValue({
      quoteWei: 1_000n,
      sellTaxBps: 1_000,
      quoteBufferBps: 1_000,
      estimatedExitGasWei: 10n,
    }),
    800n,
  );
  assert.equal(
    prudentNetExitValue({
      quoteWei: 1n,
      sellTaxBps: 0,
      quoteBufferBps: 0,
      estimatedExitGasWei: 2n,
    }),
    0n,
  );
});

test('conserve la position lorsqu’aucune règle ne correspond', () => {
  const result = evaluatePositionExit(input());
  assert.equal(result.action, 'HOLD');
  assert.deepEqual(result.triggeredRules, []);
  assert.equal(result.state.latestNetValueWei, 1_000n);
  assert.equal(result.state.lastSellTaxBps, 0);
});

test('un probe inconnu prime sur toutes les ventes', () => {
  const result = evaluatePositionExit(
    input(
      {
        probeStatus: 'UNKNOWN',
        netExitValueWei: 1n,
        currentLiquidityWbnbWei: 1n,
      },
      { referenceLiquidityWbnbWei: 1_000n },
    ),
  );
  assert.equal(result.action, 'MANUAL_REVIEW');
  assert.equal(result.primaryRule, 'SELLABILITY_UNCERTAIN');
  assert.deepEqual(result.triggeredRules, [
    'SELLABILITY_UNCERTAIN',
    'LIQUIDITY_DROP',
    'STOP_LOSS',
  ]);
});

test('un probe bloqué demande aussi une revue manuelle', () => {
  const result = evaluatePositionExit(input({ probeStatus: 'BLOCKED' }));
  assert.equal(result.action, 'MANUAL_REVIEW');
  assert.equal(result.primaryRule, 'SELLABILITY_BLOCKED');
});

test('une baisse de liquidité sûre déclenche la sortie d’urgence', () => {
  const result = evaluatePositionExit(
    input(
      { currentLiquidityWbnbWei: 799n },
      { referenceLiquidityWbnbWei: 1_000n },
    ),
  );
  assert.equal(result.action, 'EMERGENCY_SELL');
  assert.equal(result.primaryRule, 'LIQUIDITY_DROP');
});

test('applique stop-loss, durée, take-profit et nombre d’achats', () => {
  assert.equal(
    evaluatePositionExit(input({ netExitValueWei: 899n })).primaryRule,
    'STOP_LOSS',
  );
  assert.equal(
    evaluatePositionExit({ ...input(), openedAtMs: NOW - 30 * 60_000 }).primaryRule,
    'MAX_HOLDING_TIME',
  );
  assert.equal(
    evaluatePositionExit(input({ netExitValueWei: 1_200n })).primaryRule,
    'TAKE_PROFIT',
  );
  assert.equal(
    evaluatePositionExit({ ...input(), observedBuysAfterEntry: 3 }).primaryRule,
    'TARGET_BUYS',
  );
});

test('bloque une sortie normale quand le gas dépasse dix pour cent', () => {
  const result = evaluatePositionExit(
    input({ netExitValueWei: 800n, estimatedExitGasWei: 81n }),
  );
  assert.equal(result.action, 'MANUAL_REVIEW');
  assert.equal(result.primaryRule, 'GAS_RATIO_EXCEEDED');
  assert.deepEqual(result.triggeredRules, ['STOP_LOSS', 'GAS_RATIO_EXCEEDED']);
});

test('applique le plafond absolu de gas aux urgences', () => {
  const result = evaluatePositionExit(
    input(
      {
        currentLiquidityWbnbWei: 1n,
        estimatedExitGasWei: 10_000_000_000_000_001n,
      },
      { referenceLiquidityWbnbWei: 1_000n },
    ),
  );
  assert.equal(result.action, 'MANUAL_REVIEW');
  assert.equal(result.primaryRule, 'EMERGENCY_GAS_EXCEEDED');
});

test('le trailing attend un recul de cinq pour cent après armement', () => {
  const armed = evaluatePositionExit(
    input(
      { netExitValueWei: 1_200n },
      {},
      { trailingEnabled: true },
    ),
  );
  assert.equal(armed.action, 'HOLD');
  assert.equal(armed.state.peakNetValueWei, 1_200n);
  assert.equal(armed.state.trailingArmedAtMs, NOW);

  const drawdown = evaluatePositionExit(
    input(
      { netExitValueWei: 1_140n },
      armed.state,
      { trailingEnabled: true },
    ),
  );
  assert.equal(drawdown.primaryRule, 'TRAILING_STOP');
  assert.equal(drawdown.action, 'SELL');
});

test('ne mute jamais les entrées', () => {
  const value = input();
  const before = structuredClone(value);
  evaluatePositionExit(value);
  assert.deepEqual(value, before);
});
