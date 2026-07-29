export function scheduleMonitorReconcile(
  reconcile: () => Promise<unknown>,
  onError: (error: unknown) => void,
): void {
  void Promise.resolve().then(reconcile).catch(onError);
}

interface MonitorReconcileRequestOptions {
  canSchedule: () => boolean;
  reconcile: () => Promise<unknown>;
  onError: (error: unknown) => void;
}

export function createMonitorReconcileRequest(
  options: MonitorReconcileRequestOptions,
): () => void {
  return () => {
    if (!options.canSchedule()) return;
    scheduleMonitorReconcile(
      async () => {
        if (!options.canSchedule()) return;
        await options.reconcile();
      },
      options.onError,
    );
  };
}
