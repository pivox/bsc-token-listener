import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploySafetyProbeScenario } from './fixtures/local-evm.js';

test('SafetyProbe mesure un aller-retour sans perte pour un token standard', async () => {
  const scenario = await deploySafetyProbeScenario('MockStandardToken');
  try {
    const result = await scenario.service.probe(scenario.pair);

    assert.deepEqual(result, {
      buyTaxBps: 0,
      sellTaxBps: 0,
      roundTripLossBps: 0,
      quotedTokens: 10_000n,
      receivedTokens: 10_000n,
      quotedNative: 10_000n,
      recoveredNative: 10_000n,
    });
  } finally {
    await scenario.close();
  }
});

test('SafetyProbe distingue les taxes achat et vente', async () => {
  const scenario = await deploySafetyProbeScenario('MockTaxToken', [
    1_000n,
    2_000n,
  ]);
  try {
    const result = await scenario.service.probe(scenario.pair);

    assert.deepEqual(result, {
      buyTaxBps: 1_000,
      sellTaxBps: 2_000,
      roundTripLossBps: 2_800,
      quotedTokens: 10_000n,
      receivedTokens: 9_000n,
      quotedNative: 9_000n,
      recoveredNative: 7_200n,
    });
  } finally {
    await scenario.close();
  }
});

test('SafetyProbe échoue quand le token bloque la vente', async () => {
  const scenario = await deploySafetyProbeScenario('MockHoneypotToken');
  try {
    await assert.rejects(() => scenario.service.probe(scenario.pair));
  } finally {
    await scenario.close();
  }
});

test('SafetyProbe échoue quand approve ne retourne aucune valeur', async () => {
  const scenario = await deploySafetyProbeScenario('MockNonStandardToken');
  try {
    await assert.rejects(() => scenario.service.probe(scenario.pair));
  } finally {
    await scenario.close();
  }
});
