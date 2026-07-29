export interface ReplayAwareSwapMonitor {
  start(): Promise<void>;
  startForReplay(): Promise<void>;
}

export class ReorgReplayAdmissionGate {
  private active = false;

  get isActive(): boolean {
    return this.active;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active) return operation();
    this.active = true;
    try {
      return await operation();
    } finally {
      this.active = false;
    }
  }
}

export function startSwapMonitorForAdmission(
  listener: ReplayAwareSwapMonitor,
  gate: ReorgReplayAdmissionGate,
): Promise<void> {
  return gate.isActive ? listener.startForReplay() : listener.start();
}
