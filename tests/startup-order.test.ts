import assert from 'node:assert/strict';
import test from 'node:test';
import { continueStartupAfterRecovery } from '../src/runtime/startup-order.js';

test('démarre le dashboard après la reprise et avant la synchronisation canonique puis les listeners', async () => {
  const events: string[] = [];

  await continueStartupAfterRecovery({
    startDashboard: async () => { events.push('dashboard'); },
    synchronizeCanonical: async () => { events.push('canonical'); },
    activateListeners: async () => { events.push('listeners'); },
  });

  assert.deepEqual(events, ['dashboard', 'canonical', 'listeners']);
});

test('hydrate un rollback shallow persistant avant la synchronisation canonique', async () => {
  const events: string[] = [];

  await continueStartupAfterRecovery({
    startDashboard: async () => { events.push('dashboard'); },
    hydrateCanonicalRecovery: async () => { events.push('hydrate'); },
    synchronizeCanonical: async () => { events.push('canonical'); },
    activateListeners: async () => { events.push('listeners'); },
  });

  assert.deepEqual(events, ['dashboard', 'hydrate', 'canonical', 'listeners']);
});

test('un état MANUAL_REVIEW hydraté conserve le dashboard mais bloque sync et listeners', async () => {
  const events: string[] = [];

  await continueStartupAfterRecovery({
    startDashboard: async () => { events.push('dashboard'); },
    hydrateCanonicalRecovery: async () => {
      events.push('manual-review');
      return 'MANUAL_REVIEW' as never;
    },
    synchronizeCanonical: async () => { events.push('canonical'); },
    activateListeners: async () => { events.push('listeners'); },
  });

  assert.deepEqual(events, ['dashboard', 'manual-review']);
});

test('un snapshot de rollback incomplet arrête le startup avant sync et listeners', async () => {
  const events: string[] = [];

  await assert.rejects(
    continueStartupAfterRecovery({
      startDashboard: async () => { events.push('dashboard'); },
      hydrateCanonicalRecovery: async () => {
        events.push('hydrate');
        throw new Error('Rollback persistant invalide: snapshot incomplet');
      },
      synchronizeCanonical: async () => { events.push('canonical'); },
      activateListeners: async () => { events.push('listeners'); },
    }),
    /snapshot incomplet/u,
  );

  assert.deepEqual(events, ['dashboard', 'hydrate']);
});

test('un échec du nettoyage des checkpoints terminaux bloque toute hydratation et ingestion', async () => {
  const events: string[] = [];

  await assert.rejects(
    continueStartupAfterRecovery({
      startDashboard: async () => { events.push('dashboard'); },
      prepareListenerCheckpoints: async () => {
        events.push('checkpoint-cleanup');
        throw new Error('checkpoint cleanup failed');
      },
      hydrateCanonicalRecovery: async () => { events.push('hydrate'); },
      synchronizeCanonical: async () => { events.push('canonical'); },
      activateListeners: async () => { events.push('listeners'); },
    } as Parameters<typeof continueStartupAfterRecovery>[0] & {
      prepareListenerCheckpoints(): Promise<void>;
    }),
    /checkpoint cleanup failed/u,
  );

  assert.deepEqual(events, ['dashboard', 'checkpoint-cleanup']);
});

test('continue le démarrage protégé si le dashboard échoue', async () => {
  const events: string[] = [];
  const errors: string[] = [];

  await continueStartupAfterRecovery({
    startDashboard: async () => { throw new Error('port occupé'); },
    synchronizeCanonical: async () => { events.push('canonical'); },
    activateListeners: async () => { events.push('listeners'); },
    onDashboardError: (error) => { errors.push(error.message); },
  });

  assert.deepEqual(events, ['canonical', 'listeners']);
  assert.deepEqual(errors, ['port occupé']);
});

test('nettoie intégralement un dashboard déjà démarré après un échec de synchronisation et préserve l’erreur primaire', async () => {
  const events: string[] = [];
  const cleanupErrors: string[] = [];
  const primary = new Error('sync canonique échouée');

  await assert.rejects(
    continueStartupAfterRecovery({
      startDashboard: async () => { events.push('dashboard-start'); },
      synchronizeCanonical: async () => { throw primary; },
      activateListeners: async () => { events.push('listeners-start'); },
      cleanup: {
        disableSchedulingAndStopNewWork: () => { events.push('disable'); },
        stopRecovery: async () => { events.push('recovery-stop'); },
        waitForMonitorIdle: async () => { events.push('monitor-idle'); },
        waitForCanonicalIdle: async () => { events.push('canonical-idle'); },
        drainListeners: async () => { events.push('listeners-drain'); },
        stopDashboard: async () => { events.push('dashboard-stop'); throw new Error('stop dashboard échoué'); },
        closeDatabase: async () => { events.push('database-close'); },
        onCleanupError: (error) => { cleanupErrors.push(error.message); },
      },
    }),
    primary,
  );

  assert.deepEqual(events, [
    'dashboard-start',
    'disable',
    'recovery-stop',
    'monitor-idle',
    'canonical-idle',
    'monitor-idle',
    'listeners-drain',
    'dashboard-stop',
    'database-close',
  ]);
  assert.deepEqual(cleanupErrors, ['stop dashboard échoué']);
});

test('nettoie les ressources lorsque l’activation PairCreated échoue', async () => {
  const events: string[] = [];

  await assert.rejects(
    continueStartupAfterRecovery({
      startDashboard: async () => { events.push('dashboard-start'); },
      synchronizeCanonical: async () => { events.push('canonical-sync'); },
      activateListeners: async () => { throw new Error('PairCreated start échoué'); },
      cleanup: {
        disableSchedulingAndStopNewWork: () => { events.push('disable'); },
        stopRecovery: async () => { events.push('recovery-stop'); },
        waitForMonitorIdle: async () => { events.push('monitor-idle'); },
        waitForCanonicalIdle: async () => { events.push('canonical-idle'); },
        drainListeners: async () => { events.push('listeners-drain'); },
        stopDashboard: async () => { events.push('dashboard-stop'); },
        closeDatabase: async () => { events.push('database-close'); },
      },
    }),
    /PairCreated start échoué/u,
  );

  assert.deepEqual(events, [
    'dashboard-start',
    'canonical-sync',
    'disable',
    'recovery-stop',
    'monitor-idle',
    'canonical-idle',
    'monitor-idle',
    'listeners-drain',
    'dashboard-stop',
    'database-close',
  ]);
});
