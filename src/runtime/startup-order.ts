export interface StartupAfterRecoveryDependencies {
  startDashboard(): Promise<void>;
  hydrateCanonicalRecovery?(): Promise<void>;
  synchronizeCanonical(): Promise<void>;
  activateListeners(): Promise<void>;
  onDashboardError?(error: Error): void;
  cleanup?: StartupFailureCleanup;
}

export interface StartupFailureCleanup {
  disableSchedulingAndStopNewWork(): void;
  stopRecovery(): Promise<void>;
  waitForMonitorIdle(): Promise<void>;
  waitForCanonicalIdle(): Promise<void>;
  drainListeners(): Promise<void>;
  stopDashboard(): Promise<void>;
  closeDatabase(): Promise<void>;
  onCleanupError?(error: Error): void;
}

export async function continueStartupAfterRecovery(
  dependencies: StartupAfterRecoveryDependencies,
): Promise<void> {
  try {
    await dependencies.startDashboard();
  } catch (error: unknown) {
    dependencies.onDashboardError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  try {
    await dependencies.hydrateCanonicalRecovery?.();
    await dependencies.synchronizeCanonical();
    await dependencies.activateListeners();
  } catch (error: unknown) {
    await cleanupStartupFailure(dependencies.cleanup);
    throw error;
  }
}

async function cleanupStartupFailure(
  cleanup: StartupFailureCleanup | undefined,
): Promise<void> {
  if (!cleanup) return;
  const safely = async (operation: () => void | Promise<void>): Promise<void> => {
    try {
      await operation();
    } catch (error: unknown) {
      try {
        cleanup.onCleanupError?.(
          error instanceof Error ? error : new Error(String(error)),
        );
      } catch {
        // La journalisation de cleanup ne doit jamais remplacer l'erreur primaire.
      }
    }
  };

  await safely(cleanup.disableSchedulingAndStopNewWork);
  await safely(cleanup.stopRecovery);
  await safely(cleanup.waitForMonitorIdle);
  await safely(cleanup.waitForCanonicalIdle);
  await safely(cleanup.waitForMonitorIdle);
  await safely(cleanup.drainListeners);
  await safely(cleanup.stopDashboard);
  await safely(cleanup.closeDatabase);
}
