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
  staleAfterMs?: number;
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
    logger.debug(
      { owner: this.owner },
      'Début de la passe initiale de récupération.',
    );
    if (this.initialBarrier) return this.initialBarrier;
    this.initialBarrier = this.waitForInitialPass();
    return this.initialBarrier;
  }

  start(): void {
    if (this.interval) return;
    logger.debug(
      { owner: this.owner, intervalMs: this.options.intervalMs },
      'Démarrage du scheduler de recovery.',
    );
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
    logger.debug(
      {
        owner: this.owner,
        leaseMs: this.options.leaseMs,
      },
      'Passage périodique de recovery déclenché.',
    );
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
    logger.debug({ owner: this.owner }, 'Arrêt du scheduler de recovery.');
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
    logger.debug(
      { owner: this.owner, running: true },
      'Démarrage du pass recovery.',
    );
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
        logger.error(
          {
            owner: this.owner,
            errorType: safeErrorType(error),
          },
          'Pass recovery échoué.',
        );
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
      logger.debug({ owner: this.owner }, 'Attente d’un lock recovery initial.');
      const result = await this.runPass();
      if (result.acquired) return result;
      logger.debug(
        {
          owner: this.owner,
          retryMs: this.options.initialRetryMs ?? 250,
          pending: this.status.pendingSessions,
        },
        'Lock recovery non acquis; nouvelle tentative.',
      );
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
    logger.debug({ owner: this.owner }, 'Pass recovery acquiert le lock.');
    const acquired = await this.store.tryAcquirePassLock();
    if (!acquired) {
      logger.debug(
        { owner: this.owner },
        'Lock recovery indisponible.',
      );
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
          this.options.staleAfterMs ?? this.options.leaseMs * 3,
        );
        if (!claimed) break;
        logger.debug(
          {
            owner: this.owner,
            pair: claimed.snapshot.session.pair.pair,
            claimOwner: claimed.owner,
          },
          'Session récupérée pour réconciliation.',
        );
        processedPairs.push(claimed.snapshot.session.pair.pair);
        await this.reconciler.reconcile(claimed);
      }
      logger.debug(
        {
          owner: this.owner,
          processedPairs: processedPairs.length,
        },
        'Pass recovery : traitements complétés.',
      );
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
