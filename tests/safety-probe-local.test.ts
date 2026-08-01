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
