import assert from 'node:assert/strict';
import test from 'node:test';
import { RpcUsageTracker } from '../src/monitoring/rpc-usage.js';

test('compte les tentatives, erreurs 429, retries, failovers et latences', () => {
  let now = 0;
  const tracker = new RpcUsageTracker({
    monthlyBudget: 1_000,
    now: () => now,
    minimumObservationMs: 1,
  });
  tracker.recordMethodCall('eth_getLogs', 'https://secret.example/key');
  tracker.recordMethodError('eth_getLogs', true, 12);
  tracker.recordMethodRetry('eth_getLogs');
  tracker.recordMethodFailover('eth_getLogs');
  now = 10;
  tracker.recordMethodCall('eth_getLogs', 'backup-private-key');
  tracker.recordMethodSuccess('eth_getLogs', 8);
  const snapshot = tracker.getSnapshot();

  assert.equal(snapshot.methods.eth_getlogs?.calls, 2);
  assert.equal(snapshot.methods.eth_getlogs?.errors, 1);
  assert.equal(snapshot.methods.eth_getlogs?.errors429, 1);
  assert.equal(snapshot.methods.eth_getlogs?.retries, 1);
  assert.equal(snapshot.methods.eth_getlogs?.failovers, 1);
  assert.equal(snapshot.methods.eth_getlogs?.averageLatencyMs, 10);
  assert.equal(snapshot.lastSuccessAtMs, 10);
  assert.equal(snapshot.lastErrorAtMs, 0);
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /secret\.example|private-key|https?:\/\//u);
});

test('indique une observation insuffisante au démarrage', () => {
  let now = 0;
  const tracker = new RpcUsageTracker({ now: () => now, minimumObservationMs: 60_000 });
  tracker.recordMethodCall('eth_chainId');
  now = 30_000;
  const snapshot = tracker.getSnapshot();
  assert.equal(snapshot.budget.projectionStatus, 'insufficient-data');
  assert.equal(snapshot.budget.projection30d, null);
});

for (const threshold of [70, 85, 95] as const) {
  test(`active le seuil budgétaire ${threshold} %`, () => {
    let now = 0;
    const tracker = new RpcUsageTracker({
      monthlyBudget: 100,
      now: () => now,
      minimumObservationMs: 1,
    });
    for (let index = 0; index < threshold; index += 1) {
      tracker.recordMethodCall('eth_blockNumber');
    }
    now = 30 * 24 * 60 * 60 * 1000;
    const warnings = tracker.getSnapshot().budget.warnings;
    assert.equal(warnings.warning70, threshold >= 70);
    assert.equal(warnings.warning85, threshold >= 85);
    assert.equal(warnings.warning95, threshold >= 95);
  });
}

test('expose les compteurs de batching de cinquante paires en trois lots', () => {
  const tracker = new RpcUsageTracker();
  tracker.markReconciliationRequest();
  tracker.markCoalescedRequest();
  tracker.markCentralPass();
  tracker.markChunk();
  tracker.markAddressBatch(20, 2);
  tracker.markAddressBatch(20, 3);
  tracker.markAddressBatch(10, 1);
  tracker.markReconciliationSuccess();
  const reconciliation = tracker.getSnapshot().reconciliation;
  assert.equal(reconciliation.centralPasses, 1);
  assert.equal(reconciliation.chunksRead, 1);
  assert.deepEqual(reconciliation.addressBatches, [20, 20, 10]);
  assert.equal(reconciliation.logsReceived, 6);
});
