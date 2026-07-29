import { AsyncLocalStorage } from 'node:async_hooks';

export interface ReplayAwareSwapMonitor {
  start(options?: { signal?: AbortSignal }): Promise<void>;
  startForReplay(): Promise<void>;
}

export class ReorgReplayAdmissionGate {
  private finalizing = false;
  private readonly replayScope = new AsyncLocalStorage<boolean>();
  private readonly externalAdmissions = new Set<AbortController>();

  get isActive(): boolean {
    return this.replayScope.getStore() === true;
  }

  get isFinalizing(): boolean {
    return this.finalizing;
  }

  canStartMonitor(normalSchedulingEnabled: boolean): boolean {
    return this.isActive
      || (normalSchedulingEnabled && !this.finalizing);
  }

  beginExternalAdmission(): {
    signal: AbortSignal;
    release(): void;
  } | null {
    if (this.finalizing || this.isActive) return null;
    const controller = new AbortController();
    this.externalAdmissions.add(controller);
    return {
      signal: controller.signal,
      release: () => {
        this.externalAdmissions.delete(controller);
      },
    };
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.isActive) return operation();
    if (this.finalizing) {
      throw new Error('Une finalisation reorg est déjà active.');
    }
    this.finalizing = true;
    for (const admission of this.externalAdmissions) admission.abort();
    this.externalAdmissions.clear();
    try {
      return await this.replayScope.run(true, operation);
    } finally {
      this.finalizing = false;
    }
  }
}

export async function startSwapMonitorForAdmission(
  listener: ReplayAwareSwapMonitor,
  gate: ReorgReplayAdmissionGate,
): Promise<boolean> {
  if (gate.isActive) {
    await listener.startForReplay();
    return true;
  }
  const admission = gate.beginExternalAdmission();
  if (!admission) return false;
  try {
    await listener.start({ signal: admission.signal });
    return !admission.signal.aborted;
  } finally {
    admission.release();
  }
}
