import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import type {
  ClaimedRecovery,
  ReconciliationStore,
} from './recovery.types.js';
import { RuntimeRecoveryBarrier } from './runtime-recovery-barrier.js';

interface RecoveryReconciler {
  reconcile(claimed: ClaimedRecovery): Promise<void>;
}

interface RecoveryCoordinatorOptions {
  intervalMs: number;
  leaseMs: number;
  owner?: string;
  initialRetryMs?: number;
  onPeriodicPassCompleted?: () => Promise<void>;
  onPeriodicBarrierReleased?: () => Promise<void>;
}

export interface RecoveryPassResult {
  acquired: boolean;
  processedSessions: number;
  pendingSessions: number;
  manualReviewSessions: number;
  completedAtMs: number;
}

export interface RecoveryCoordinatorStatus {
  running: boolean;
  lastCompletedAtMs: number | null;
  lastErrorType: string | null;
  lastProcessedSessions: number;
  pendingSessions: number;
  manualReviewSessions: number;
}

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return error.name !== 'Error' ? error.name : error.constructor.name;
}

export class RecoveryCoordinator {
  private readonly owner: string;
  private currentPass: Promise<RecoveryPassResult> | null = null;
  private initialBarrier: Promise<RecoveryPassResult> | null = null;
  private periodicPass: Promise<void> | null = null;
  private interval: NodeJS.Timeout | null = null;
  private status: RecoveryCoordinatorStatus = {
    running: false,
    lastCompletedAtMs: null,
    lastErrorType: null,
    lastProcessedSessions: 0,
    pendingSessions: 0,
    manualReviewSessions: 0,
  };

  constructor(
    private readonly store: ReconciliationStore,
    private readonly reconciler: RecoveryReconciler,
    private readonly options: RecoveryCoordinatorOptions,
    private readonly runtimeBarrier?: RuntimeRecoveryBarrier,
  ) {
    this.owner = options.owner ?? `recovery-${randomUUID()}`;
  }

  get currentStatus(): RecoveryCoordinatorStatus {
    return { ...this.status };
  }

  async reconcileInitial(): Promise<RecoveryPassResult> {
    if (this.initialBarrier) return this.initialBarrier;
    this.initialBarrier = this.waitForInitialPass();
    return this.initialBarrier;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => {
      void this.reconcilePeriodic().catch((error: unknown) => {
        logger.error(
          { errorType: safeErrorType(error) },
          'Passe périodique de réconciliation échouée.',
        );
      });
    }, this.options.intervalMs);
    this.interval.unref();
  }

  reconcilePeriodic(): Promise<void> {
    if (this.periodicPass) return this.periodicPass;
    const pass = (async () => {
      try {
        await this.runPass(this.options.onPeriodicPassCompleted);
      } finally {
        await this.options.onPeriodicBarrierReleased?.();
      }
    })().finally(() => {
      this.periodicPass = null;
    });
    this.periodicPass = pass;
    return pass;
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    await (this.periodicPass ?? this.currentPass)?.catch(() => undefined);
  }

  private runPass(
    beforeBarrierRelease?: () => Promise<void>,
  ): Promise<RecoveryPassResult> {
    if (this.currentPass) return this.currentPass;
    this.status = { ...this.status, running: true, lastErrorType: null };
    const pass = this.executePass(beforeBarrierRelease)
      .then((result) => {
        this.status = {
          running: false,
          lastCompletedAtMs: result.completedAtMs,
          lastErrorType: null,
          lastProcessedSessions: result.processedSessions,
          pendingSessions: result.pendingSessions,
          manualReviewSessions: result.manualReviewSessions,
        };
        return result;
      })
      .catch((error: unknown) => {
        this.status = {
          ...this.status,
          running: false,
          lastErrorType: safeErrorType(error),
        };
        throw error;
      })
      .finally(() => {
        this.currentPass = null;
      });
    this.currentPass = pass;
    return pass;
  }

  private async waitForInitialPass(): Promise<RecoveryPassResult> {
    while (true) {
      const result = await this.runPass();
      if (result.acquired) return result;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, this.options.initialRetryMs ?? 250));
    }
  }

  private async executePass(
    beforeBarrierRelease?: () => Promise<void>,
  ): Promise<RecoveryPassResult> {
    if (this.runtimeBarrier) {
      return this.runtimeBarrier.runRecovery(async () => {
        try {
          return await this.executeLockedPass();
        } finally {
          await beforeBarrierRelease?.();
        }
      });
    }
    try {
      return await this.executeLockedPass();
    } finally {
      await beforeBarrierRelease?.();
    }
  }

  private async executeLockedPass(): Promise<RecoveryPassResult> {
    const acquired = await this.store.tryAcquirePassLock();
    if (!acquired) {
      return {
        acquired: false,
        processedSessions: 0,
        pendingSessions: this.status.pendingSessions,
        manualReviewSessions: this.status.manualReviewSessions,
        completedAtMs: Date.now(),
      };
    }

    const processedPairs: string[] = [];
    try {
      while (true) {
        const claimed = await this.store.claimNext(
          this.owner,
          this.options.leaseMs,
          processedPairs,
        );
        if (!claimed) break;
        processedPairs.push(claimed.snapshot.session.pair.pair);
        await this.reconciler.reconcile(claimed);
      }
      const backlog = await this.store.getBacklogCounts();
      return {
        acquired: true,
        processedSessions: processedPairs.length,
        ...backlog,
        completedAtMs: Date.now(),
      };
    } finally {
      await this.store.releasePassLock();
    }
  }
}
