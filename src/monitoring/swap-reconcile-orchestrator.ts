import type { Address } from 'viem';

interface SwapReconcileTarget {
  pair: Address;
  reconcileNow(): Promise<void>;
}

interface SwapReconcileOrchestratorOptions {
  intervalMs: number;
  canRun: () => boolean;
  onError: (error: unknown) => void;
  setInterval: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
}

function defaultSetInterval(callback: () => void, intervalMs: number): ReturnType<typeof setInterval> {
  return setInterval(callback, intervalMs);
}

function defaultClearInterval(handle: ReturnType<typeof setInterval>): void {
  clearInterval(handle);
}

function getPairKey(pair: Address): string {
  return pair.toLowerCase();
}

export class SwapReconcileOrchestrator {
  private readonly listeners = new Map<string, SwapReconcileTarget>();
  private readonly options: SwapReconcileOrchestratorOptions;
  private running: Promise<void> | null = null;
  private startScheduled = false;
  private requestedPairs = new Set<string>();
  private requestAll = false;
  private rerunRequested = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(options: Omit<SwapReconcileOrchestratorOptions, 'setInterval' | 'clearInterval'> & Partial<Pick<SwapReconcileOrchestratorOptions, 'setInterval' | 'clearInterval'>>) {
    this.options = {
      ...options,
      setInterval: options.setInterval ?? defaultSetInterval,
      clearInterval: options.clearInterval ?? defaultClearInterval,
    };
  }

  register(listener: SwapReconcileTarget): void {
    this.listeners.set(getPairKey(listener.pair), listener);
  }

  unregister(pair: Address): void {
    this.listeners.delete(getPairKey(pair));
  }

  start(): void {
    if (this.stopped || this.interval !== null) return;
    this.interval = this.options.setInterval(() => {
      this.signal();
    }, this.options.intervalMs);
    this.interval?.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.interval === null) return;
    this.options.clearInterval(this.interval);
    this.interval = null;
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    await this.waitForIdle();
  }

  waitForIdle(): Promise<void> {
    return this.running?.then(() => undefined) ?? Promise.resolve();
  }

  signal(pair?: Address): void {
    if (this.stopped) return;

    if (pair) {
      this.requestedPairs.add(getPairKey(pair));
    } else {
      this.requestAll = true;
    }

    if (this.running) {
      this.rerunRequested = true;
      return;
    }

    if (!this.options.canRun() || this.startScheduled) {
      return;
    }

    this.startScheduled = true;
    queueMicrotask(() => {
      this.startScheduled = false;
      if (this.stopped || this.running || !this.options.canRun()) return;
      this.running = this.runQueuedPasses();
    });
  }

  private async runQueuedPasses(): Promise<void> {
    try {
      do {
        this.rerunRequested = false;
        await this.reconcileQueuedListeners();
      } while (
        this.rerunRequested
        && !this.stopped
        && this.options.canRun()
      );
    } finally {
      this.running = null;
    }
  }

  private async reconcileQueuedListeners(): Promise<void> {
    const runAll = this.requestAll;
    const requested = this.requestedPairs;
    this.requestAll = false;
    this.requestedPairs = new Set<string>();

    const targets = runAll
      ? [...this.listeners.values()]
      : [...requested]
        .map((pairKey) => this.listeners.get(pairKey))
        .filter((target): target is SwapReconcileTarget => target !== undefined);

    await Promise.all(
      targets.map(async (target) => {
        try {
          await target.reconcileNow();
        } catch (error) {
          this.options.onError(error);
        }
      }),
    );
  }
}
