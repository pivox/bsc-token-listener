import type { Address } from 'viem';

export interface SwapReconcileTarget {
  pair: Address;
}

interface SwapReconcileOrchestratorOptions {
  intervalMs: number;
  canRun: () => boolean;
  onError: (error: unknown) => void;
  runPass: (targets: readonly SwapReconcileTarget[]) => Promise<void>;
  setInterval: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval>) => void;
}

interface SwapReconcileWaiter {
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface SwapReconcileResult {
  error?: unknown;
}

function defaultSetInterval(
  callback: () => void,
  intervalMs: number,
): ReturnType<typeof setInterval> {
  return setInterval(callback, intervalMs);
}

function defaultClearInterval(handle: ReturnType<typeof setInterval>): void {
  clearInterval(handle);
}

function getPairKey(pair: Address): string {
  return pair.toLowerCase();
}

function createWaiter(): SwapReconcileWaiter & { promise: Promise<void> } {
  let resolve = () => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const stoppedError = new Error('Orchestrateur de réconciliation arrêté.');
const notRegisteredError = new Error('Paire de réconciliation non enregistrée.');

export class SwapReconcileOrchestrator {
  private readonly listeners = new Map<string, SwapReconcileTarget>();
  private readonly options: SwapReconcileOrchestratorOptions;
  private readonly pairWaiters = new Map<string, Set<SwapReconcileWaiter>>();
  private running: Promise<void> | null = null;
  private runningPairs = new Set<string>();
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
    const pairKey = getPairKey(pair);
    this.listeners.delete(pairKey);
    if (this.runningPairs.has(pairKey)) return;
    this.failPairWaiters(pairKey, notRegisteredError);
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
    if (this.interval === null) {
      this.failPendingRequestWaiters(stoppedError);
      return;
    }
    this.options.clearInterval(this.interval);
    this.interval = null;
    this.failPendingRequestWaiters(stoppedError);
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    await this.waitForIdle();
  }

  waitForIdle(): Promise<void> {
    return (async () => {
      while (
        this.running !== null
        || this.startScheduled
        || this.requestedPairs.size > 0
        || this.requestAll
      ) {
        if (this.running) {
          await this.running;
        } else {
          await Promise.resolve();
        }
      }
    })();
  }

  signal(pair?: Address): void {
    if (this.stopped) return;
    if (pair) {
      const pairKey = getPairKey(pair);
      if (!this.listeners.has(pairKey)) {
        this.failPairWaiters(pairKey, notRegisteredError);
        return;
      }
      this.requestedPairs.add(pairKey);
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
      this.running.finally(() => {
        this.running = null;
      });
    });
  }

  requestAndWait(pair: Address): Promise<void> {
    if (this.stopped) return Promise.reject(stoppedError);
    const pairKey = getPairKey(pair);
    if (!this.listeners.has(pairKey)) {
      return Promise.reject(notRegisteredError);
    }

    const waiter = createWaiter();
    const waiters = this.pairWaiters.get(pairKey)
      ?? new Set<SwapReconcileWaiter>();
    waiters.add(waiter);
    this.pairWaiters.set(pairKey, waiters);

    this.signal(pair);

    return waiter.promise.finally(() => {
      const currentWaiters = this.pairWaiters.get(pairKey);
      if (!currentWaiters) return;
      currentWaiters.delete(waiter);
      if (currentWaiters.size === 0) {
        this.pairWaiters.delete(pairKey);
      }
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
      return;
    }
  }

  private async reconcileQueuedListeners(): Promise<void> {
    const runAll = this.requestAll;
    const requestedPairs = new Set(this.requestedPairs);
    this.requestAll = false;
    this.requestedPairs.clear();

    const targets = runAll
      ? [...this.listeners.values()]
      : [...requestedPairs]
        .map((pairKey) => this.listeners.get(pairKey))
        .filter((target): target is SwapReconcileTarget => target !== undefined);

    const runningPairs = new Set(
      targets.map((target) => getPairKey(target.pair)),
    );
    this.runningPairs = runningPairs;

    const results = new Map<string, SwapReconcileResult>();
    try {
      await this.options.runPass(targets);
      for (const target of targets) {
        results.set(getPairKey(target.pair), {});
      }
    } catch (error) {
      for (const target of targets) {
        results.set(getPairKey(target.pair), { error });
      }
      this.options.onError(error);
    }
    this.runningPairs = new Set();

    for (const pairKey of requestedPairs) {
      const waiters = this.pairWaiters.get(pairKey);
      if (!waiters || waiters.size === 0) continue;

      const result = results.get(pairKey);
      if (!results.has(pairKey) && !this.listeners.has(pairKey)) {
        this.failPairWaiters(pairKey, notRegisteredError);
      } else if (result?.error !== undefined) {
        this.failPairWaiters(pairKey, result.error);
      } else {
        this.resolvePairWaiters(pairKey);
      }
    }
  }

  private failPendingRequestWaiters(error: unknown): void {
    const pendingPairs = new Set(this.requestedPairs);
    if (this.requestAll) {
      for (const [pairKey, waiters] of this.pairWaiters) {
        this.failPairWaiters(pairKey, error);
      }
      this.requestedPairs.clear();
      this.requestAll = false;
      return;
    }

    for (const pairKey of pendingPairs) {
      this.failPairWaiters(pairKey, error);
    }
    this.requestedPairs.clear();
  }

  private resolvePairWaiters(pairKey: string): void {
    const waiters = this.pairWaiters.get(pairKey);
    if (!waiters || waiters.size === 0) return;
    this.pairWaiters.delete(pairKey);
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  private failPairWaiters(pairKey: string, error: unknown): void {
    const waiters = this.pairWaiters.get(pairKey);
    if (!waiters || waiters.size === 0) return;
    this.pairWaiters.delete(pairKey);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }
}
