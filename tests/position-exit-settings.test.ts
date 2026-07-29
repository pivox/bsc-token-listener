import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  defaultPositionExitSettings,
  parsePositionExitSettings,
} from '../src/strategy/position-exit-settings.js';

test('expose le profil très prudent validé et immuable', () => {
  const value = defaultPositionExitSettings();

  assert.deepEqual(value, {
    monitorIntervalSeconds: 15,
    maxHoldingMinutes: 30,
    stopLossBps: 1_000,
    takeProfitBps: 2_000,
    liquidityDropBps: 2_000,
    probeIntervalSeconds: 60,
    quoteBufferBps: 1_500,
    maxGasValueBps: 1_000,
    emergencyMaxGasWei: 10_000_000_000_000_000n,
    approvalGasUnits: 80_000n,
    sellGasUnits: 350_000n,
    trailingEnabled: false,
    trailingActivationBps: 2_000,
    trailingDrawdownBps: 500,
    targetBuysAfterEntry: 3,
  });
  assert.equal(Object.isFrozen(value), true);
});

test('retourne une copie défensive gelée', () => {
  const input = { ...defaultPositionExitSettings() };
  const parsed = parsePositionExitSettings(input);
  input.stopLossBps = 2_000;

  assert.equal(parsed.stopLossBps, 1_000);
  assert.equal(Object.isFrozen(parsed), true);
});

test('rejette les champs inconnus', () => {
  assert.throws(
    () =>
      parsePositionExitSettings({
        ...defaultPositionExitSettings(),
        unknown: true,
      }),
    /inconnu/u,
  );
});

test('rejette les valeurs hors plage et les basis points décimaux', () => {
  for (const patch of [
    { monitorIntervalSeconds: 4 },
    { maxHoldingMinutes: 0 },
    { stopLossBps: 1.5 },
    { takeProfitBps: 100_001 },
    { liquidityDropBps: 10_001 },
    { quoteBufferBps: -1 },
    { maxGasValueBps: 10_001 },
    { approvalGasUnits: 20_999n },
    { sellGasUnits: 2_000_001n },
    { targetBuysAfterEntry: 0 },
  ]) {
    assert.throws(
      () =>
        parsePositionExitSettings({
          ...defaultPositionExitSettings(),
          ...patch,
        }),
      /doit|entre/u,
    );
  }
});

test('rejette un intervalle de probe inférieur au monitor', () => {
  assert.throws(
    () =>
      parsePositionExitSettings({
        ...defaultPositionExitSettings(),
        monitorIntervalSeconds: 60,
        probeIntervalSeconds: 15,
      }),
    /probe/u,
  );
});

test('rejette un drawdown trailing supérieur ou égal à son activation', () => {
  assert.throws(
    () =>
      parsePositionExitSettings({
        ...defaultPositionExitSettings(),
        trailingActivationBps: 500,
        trailingDrawdownBps: 500,
      }),
    /trailing/u,
  );
});

test('documente toutes les variables et les garde-fous de sortie', async () => {
  const [example, readme, strategy] = await Promise.all([
    readFile('.env.example', 'utf8'),
    readFile('README.md', 'utf8'),
    readFile('docs/strategy.md', 'utf8'),
  ]);
  for (const key of [
    'EXIT_MONITOR_INTERVAL_SECONDS',
    'EXIT_MAX_HOLDING_MINUTES',
    'EXIT_STOP_LOSS_BPS',
    'EXIT_TAKE_PROFIT_BPS',
    'EXIT_LIQUIDITY_DROP_BPS',
    'EXIT_SAFETY_PROBE_INTERVAL_SECONDS',
    'EXIT_QUOTE_BUFFER_BPS',
    'EXIT_MAX_GAS_VALUE_BPS',
    'EXIT_EMERGENCY_MAX_GAS_BNB',
    'EXIT_APPROVAL_GAS_UNITS',
    'EXIT_SELL_GAS_UNITS',
    'EXIT_TRAILING_STOP_ENABLED',
    'EXIT_TRAILING_ACTIVATION_BPS',
    'EXIT_TRAILING_DRAWDOWN_BPS',
    'TARGET_BUYS_AFTER_ENTRY',
  ]) {
    assert.match(example, new RegExp(`^${key}=`, 'mu'), key);
  }
  assert.match(example, /^EXECUTION_MODE=dry-run$/mu);
  assert.match(readme, /DASHBOARD_ACTIONS_ENABLED/u);
  assert.match(readme, /prévisualisation/u);
  assert.match(strategy, /MANUAL_REVIEW/u);
  assert.match(strategy, /netExitWei/u);
  assert.match(strategy, /trailing/u);
  assert.match(strategy, /0[,.]01 BNB/u);
  assert.match(strategy, /hash.*nonce|nonce.*hash/isu);
});
