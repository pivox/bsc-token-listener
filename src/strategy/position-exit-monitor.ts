import type { RuntimeRecoveryBarrier } from '../recovery/runtime-recovery-barrier.js';
import type { SessionRepository } from '../storage/repositories.js';
import type { TokenSession } from '../types/domain.js';
import { errorMessage } from '../utils/error.js';
import { logger } from '../utils/logger.js';
import { evaluatePositionExit } from './position-exit-evaluator.js';
import type { PositionExitRepository } from './position-exit.repository.js';
import type { PositionExitSettingsProvider } from './position-exit-settings.provider.js';
import {
  StalePositionMetricsError,
  type PositionMetricsService,
} from './position-metrics.service.js';
import type { SessionEngine } from './session-engine.js';

export interface PositionExitMonitorDependencies {
  sessions: Pick<SessionRepository, 'loadHolding' | 'findByPair' | 'save'>;
  settings: Pick<PositionExitSettingsProvider, 'get'>;
  metrics: Pick<PositionMetricsService, 'collect'>;
  decisions: Pick<
    PositionExitRepository,
    'createDecision' | 'listRecoverableDecisions' | 'transitionDecision'
  >;
  engine: Pick<SessionEngine, 'requestPolicyExit'>;
  barrier: Pick<RuntimeRecoveryBarrier, 'runListener'>;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
  clearTimer?: (timer: NodeJS.Timeout) => void;
}

export class PositionExitMonitor {
  private active: Promise<void> | null = null;
  private rerunRequested = false;
  private timer: NodeJS.Timeout | null = null;
  private enabled = false;
  private lastCompletedAtMs: number | null = null;
  private lastErrorType: string | null = null;

  constructor(private readonly dependencies: PositionExitMonitorDependencies) {}

  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    void this.scheduleNext();
  }

  stop(): void {
    this.enabled = false;
    if (this.timer) {
      (this.dependencies.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
  }

  async reconcileNow(): Promise<void> {
    if (this.active) {
      this.rerunRequested = true;
      return this.active;
    }
    this.active = (async () => {
      do {
        this.rerunRequested = false;
        await this.dependencies.barrier.runListener(async () => this.runPass());
      } while (this.rerunRequested);
    })().finally(() => {
      this.active = null;
    });
    return this.active;
  }

  async reconcilePendingDecisions(): Promise<void> {
    const decisions = await this.dependencies.decisions.listRecoverableDecisions();
    for (const decision of decisions) {
      const session = await this.dependencies.sessions.findByPair(decision.pair);
      if (decision.status === 'PENDING') {
        if (session?.status === 'HOLDING') {
          await this.dependencies.engine.requestPolicyExit(session, decision);
        } else {
          await this.dependencies.decisions.transitionDecision(
            decision.id,
            'PENDING',
            'SUPERSEDED',
          );
        }
        continue;
      }
      if (session?.status === 'CLOSED' && session.exit) {
        await this.dependencies.decisions.transitionDecision(
          decision.id,
          'EXECUTING',
          'EXECUTED',
          session.exit.tradeId
            ? { relatedTradeId: session.exit.tradeId }
            : {},
        );
      }
    }
  }

  async waitForIdle(): Promise<void> {
    await this.active;
  }

  get currentStatus(): {
    running: boolean;
    lastCompletedAtMs: number | null;
    lastErrorType: string | null;
  } {
    return {
      running: this.active !== null,
      lastCompletedAtMs: this.lastCompletedAtMs,
      lastErrorType: this.lastErrorType,
    };
  }

  private async runPass(): Promise<void> {
    await this.reconcilePendingDecisions();
    const sessions = await this.dependencies.sessions.loadHolding();
    let passError: string | null = null;
    for (const session of sessions) {
      try {
        await this.evaluateSession(session);
      } catch (error) {
        passError = error instanceof Error ? error.name : 'UnknownError';
        logger.error(
          {
            pair: session.pair.pair,
            error: errorMessage(error),
          },
          'Évaluation de sortie de position échouée.',
        );
      }
    }
    this.lastErrorType = passError;
    this.lastCompletedAtMs = this.now();
  }

  private async evaluateSession(session: TokenSession): Promise<void> {
    if (!session.entry || session.status !== 'HOLDING') return;
    const effective = await this.dependencies.settings.get();
    const nowMs = this.now();
    let metrics;
    try {
      metrics = await this.dependencies.metrics.collect(
        session,
        effective.settings,
        session.exitPolicy ?? {},
        nowMs,
      );
    } catch (error) {
      if (!(error instanceof StalePositionMetricsError)) throw error;
      session.exitPolicy = {
        ...session.exitPolicy,
        lastEvaluatedAtMs: nowMs,
        nextEvaluationAtMs:
          nowMs + effective.settings.monitorIntervalSeconds * 1_000,
        staleReason: error.causeType,
        settingsRevision: effective.revision,
      };
      session.updatedAtMs = nowMs;
      await this.dependencies.sessions.save(session);
      return;
    }
    const evaluation = evaluatePositionExit({
      settings: effective.settings,
      state: session.exitPolicy ?? {},
      metrics,
      nowMs,
      openedAtMs: session.entry.confirmedAtMs,
      observedBuysAfterEntry: session.subsequentBuyCount,
    });
    session.exitPolicy = {
      ...evaluation.state,
      settingsRevision: effective.revision,
    };
    session.targetBuysAfterEntry = effective.settings.targetBuysAfterEntry;
    session.updatedAtMs = nowMs;
    await this.dependencies.sessions.save(session);
    if (
      evaluation.action === 'HOLD' ||
      evaluation.primaryRule === undefined
    ) {
      return;
    }
    const entryReference =
      session.entry.tradeId ??
      session.entry.transactionHash ??
      String(session.entry.confirmedAtMs);
    const decision = await this.dependencies.decisions.createDecision({
      idempotencyKey: [
        session.pair.pair.toLowerCase(),
        entryReference,
        effective.revision,
        evaluation.primaryRule,
      ].join(':'),
      pair: session.pair.pair,
      token: session.pair.token,
      settingsRevision: effective.revision,
      primaryRule: evaluation.primaryRule,
      triggeredRules: evaluation.triggeredRules,
      action: evaluation.action,
      metrics,
      reason: evaluation.reason,
    });
    await this.dependencies.engine.requestPolicyExit(session, decision);
  }

  private async scheduleNext(): Promise<void> {
    if (!this.enabled) return;
    const effective = await this.dependencies.settings.get();
    if (!this.enabled) return;
    const schedule = this.dependencies.setTimer ?? setTimeout;
    this.timer = schedule(() => {
      this.timer = null;
      void this.reconcileNow()
        .catch((error: unknown) => {
          this.lastErrorType =
            error instanceof Error ? error.name : 'UnknownError';
          logger.error(
            { error: errorMessage(error) },
            'Passe périodique de sortie échouée.',
          );
        })
        .finally(() => this.scheduleNext());
    }, effective.settings.monitorIntervalSeconds * 1_000);
  }

  private now(): number {
    return this.dependencies.now?.() ?? Date.now();
  }
}
