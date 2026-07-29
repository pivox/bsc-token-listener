import assert from 'node:assert/strict';
import test from 'node:test';
import { createMonitorReconcileRequest } from '../src/monitoring/monitor-reconcile-request.js';
import { drainRuntimeForShutdown } from '../src/runtime/runtime-shutdown.js';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = (): void => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('désactive les nouvelles passes monitor et draine celles lancées autour du canonical', async () => {
  const firstMonitorGate = deferred();
  const firstMonitorStarted = deferred();
  const pairChunkGate = deferred();
  const canonicalStarted = deferred();
  const events: string[] = [];
  const errors: unknown[] = [];
  let monitorSchedulingEnabled = true;
  let monitorRuns = 0;
  let monitorIdleCalls = 0;

  const requestMonitorReconcile = createMonitorReconcileRequest({
    canSchedule: () => monitorSchedulingEnabled,
    reconcile: async () => {
      monitorRuns += 1;
    },
    onError: (error) => {
      errors.push(error);
    },
  });

  requestMonitorReconcile();
  const shutdown = drainRuntimeForShutdown({
    disableSchedulingAndStopNewWork: () => {
      monitorSchedulingEnabled = false;
      events.push('disabled');
    },
    stopRecovery: async () => {
      events.push('recovery');
    },
    waitForMonitorIdle: async () => {
      monitorIdleCalls += 1;
      events.push(`monitor-${monitorIdleCalls}`);
      if (monitorIdleCalls === 1) {
        firstMonitorStarted.resolve();
        await firstMonitorGate.promise;
      }
    },
    waitForCanonicalIdle: async () => {
      events.push('canonical-start');
      canonicalStarted.resolve();
      await pairChunkGate.promise;
      requestMonitorReconcile();
      events.push('pair-finished');
    },
  });

  await firstMonitorStarted.promise;
  assert.deepEqual(events, ['disabled', 'recovery', 'monitor-1']);
  firstMonitorGate.resolve();
  await canonicalStarted.promise;
  pairChunkGate.resolve();
  await shutdown;
  await Promise.resolve();

  assert.deepEqual(events, [
    'disabled',
    'recovery',
    'monitor-1',
    'canonical-start',
    'pair-finished',
    'monitor-2',
  ]);
  assert.equal(monitorRuns, 0);
  assert.deepEqual(errors, []);
});
