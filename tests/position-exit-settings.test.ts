import assert from 'node:assert/strict';
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
