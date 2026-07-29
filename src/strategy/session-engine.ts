import { formatEther } from 'viem';
import { config } from '../config/env.js';
import { EntryAmountService } from '../execution/entry-amount.service.js';
import { TradeExecutor } from '../execution/trade-executor.js';
import { TokenRiskService } from '../security/token-risk.service.js';
import { recordEntryObservationBuy } from './entry-observation.js';
import {
  executionToReconcile,
  hasUnreconciledConfirmedSell,
  requiresExecutionManualReview,
} from './execution-failure-policy.js';
import {
  RiskReportRepository,
  SessionRepository,
} from '../storage/repositories.js';
import type { SwapEvent, TokenSession } from '../types/domain.js';
import { cursorAfter } from '../utils/cursor.js';
import { errorMessage } from '../utils/error.js';
import { logger } from '../utils/logger.js';
import type { TokenRiskReport } from '../security/token-risk.types.js';
import { RuntimeRecoveryBarrier } from '../recovery/runtime-recovery-barrier.js';
import { isSessionMonitorable } from './session-monitor-policy.js';
import { evaluatePositionExit } from './position-exit-evaluator.js';
import type { PositionMetricsService } from './position-metrics.service.js';
import type { PositionExitRepository } from './position-exit.repository.js';
import type { PositionExitSettingsProvider } from './position-exit-settings.provider.js';
import type { PositionExitDecision } from './position-exit.types.js';

const TERMINAL = new Set(['CLOSED', 'REJECTED', 'EXPIRED']);

export interface SwapEventLifecycle {
  claim(event: SwapEvent, before: TokenSession): Promise<boolean>;
  markProcessed(eventId: string, after: TokenSession): Promise<void>;
  markFailed(eventId: string, reason: string): Promise<void>;
}

const NOOP_SWAP_EVENT_LIFECYCLE: SwapEventLifecycle = {
  claim: async () => true,
  markProcessed: async () => {},
  markFailed: async () => {},
};

export interface PositionExitEngineDependencies {
  settings: Pick<PositionExitSettingsProvider, 'get'>;
  metrics: Pick<PositionMetricsService, 'collect'>;
  decisions: Pick<
    PositionExitRepository,
    'createDecision' | 'findDecision' | 'transitionDecision'
  >;
}

export class SessionEngine {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly sessions: SessionRepository,
    private readonly reports: RiskReportRepository,
    private readonly risk: TokenRiskService,
    private readonly executor: TradeExecutor,
    private readonly amountService: EntryAmountService,
    private readonly runtimeBarrier = new RuntimeRecoveryBarrier(),
    private readonly eventLifecycle: SwapEventLifecycle = NOOP_SWAP_EVENT_LIFECYCLE,
    private readonly positionExits?: PositionExitEngineDependencies,
  ) {}

  async onSwap(session: TokenSession, event: SwapEvent): Promise<boolean> {
    return this.withLock(session, async () => {
      const current = await this.sessions.findByPair(session.pair.pair);
      if (!current) return false;
      this.replaceSession(session, current);
      if (!isSessionMonitorable(session)) return false;
      const claimed = await this.eventLifecycle.claim(
        event,
        structuredClone(session),
      );
      if (!claimed) return true;
      try {
        await this.handle(session, event);
        await this.eventLifecycle.markProcessed(
          event.id,
          structuredClone(session),
        );
        return true;
      } catch (error) {
        try {
          await this.eventLifecycle.markFailed(event.id, errorMessage(error));
        } catch (lifecycleError) {
          logger.error(
            {
              pair: session.pair.pair,
              eventId: event.id,
              processingError: errorMessage(error),
              lifecycleError: errorMessage(lifecycleError),
            },
            'Échec du marquage FAILED; erreur de traitement préservée.',
          );
        }
        throw error;
      }
    });
  }

  async sellManually(session: TokenSession): Promise<TokenSession> {
    return this.withLock(session, async () => {
      const current = await this.sessions.findByPair(session.pair.pair);
      if (!current) throw new Error('Session introuvable.');
      this.replaceSession(session, current);
      if (!session.entry || session.exit) {
        throw new Error('Aucune position ouverte à vendre.');
      }
      if (hasUnreconciledConfirmedSell(session)) {
        throw new Error(
          'Une vente confirmée doit être réconciliée avant toute nouvelle tentative.',
        );
      }
      if (session.status !== 'HOLDING' && session.status !== 'MANUAL_REVIEW') {
        throw new Error(`Vente manuelle impossible depuis le statut ${session.status}.`);
      }
      await this.performSell(
        session,
        'Sortie manuelle effectuée depuis le dashboard local.',
        true,
      );
      return session;
    });
  }

  async requestPolicyExit(
    session: TokenSession,
    decision: PositionExitDecision,
  ): Promise<TokenSession> {
    if (!this.positionExits) {
      throw new Error('Politique de sortie non configurée.');
    }
    return this.withLock(session, async () => {
      const current = await this.sessions.findByPair(session.pair.pair);
      if (!current) throw new Error('Session introuvable.');
      this.replaceSession(session, current);
      return this.requestPolicyExitLocked(session, decision);
    });
  }

  async ignoreManually(session: TokenSession): Promise<TokenSession> {
    return this.withLock(session, async () => {
      const current = await this.sessions.findByPair(session.pair.pair);
      if (!current) throw new Error('Session introuvable.');
      if (current.entry && !current.exit) {
        throw new Error('Une position ouverte ne peut pas être ignorée; vendez-la d’abord.');
      }
      if (!['WAITING_FIRST_BUY', 'REJECTED', 'EXPIRED'].includes(current.status)) {
        throw new Error(`Actif impossible à ignorer depuis le statut ${current.status}.`);
      }
      current.status = 'REJECTED';
      current.rejectionReason = 'Actif ignoré manuellement depuis le dashboard local.';
      current.updatedAtMs = Date.now();
      await this.sessions.save(current);
      this.replaceSession(session, current);
      logger.warn(
        { pair: session.pair.pair, token: session.pair.token },
        'Actif placé dans la liste d’ignorance depuis le dashboard local.',
      );
      return session;
    });
  }

  isTerminal(session: TokenSession): boolean {
    return TERMINAL.has(session.status);
  }

  async expireIfNeeded(session: TokenSession): Promise<boolean> {
    return this.withLock(session, async () => {
      const current = await this.sessions.findByPair(session.pair.pair);
      if (!current || current.status !== 'WAITING_FIRST_BUY') return false;
      const ttlMs = config.pairMonitorTtlMinutes * 60_000;
      if (Date.now() - current.createdAtMs < ttlMs) return false;
      current.status = 'EXPIRED';
      current.updatedAtMs = Date.now();
      current.rejectionReason = 'Aucun premier achat avant expiration du moniteur.';
      await this.sessions.save(current);
      this.replaceSession(session, current);
      return true;
    });
  }

  private replaceSession(target: TokenSession, source: TokenSession): void {
    for (const key of Object.keys(target)) Reflect.deleteProperty(target, key);
    Object.assign(target, structuredClone(source));
  }

  private async withLock<T>(session: TokenSession, operation: () => Promise<T>): Promise<T> {
    const key = session.pair.pair.toLowerCase();
    const previous = this.locks.get(key) ?? Promise.resolve();
    let resolveCurrent: (() => void) | undefined;
    const marker = new Promise<void>((resolve) => {
      resolveCurrent = resolve;
    });
    const current = previous.catch(() => undefined).then(async () => {
      try {
        return await this.runtimeBarrier.runListener(operation);
      } finally {
        resolveCurrent?.();
      }
    });
    this.locks.set(key, marker);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === marker) this.locks.delete(key);
    }
  }

  private async handle(session: TokenSession, event: SwapEvent): Promise<void> {
    if (this.isTerminal(session)) return;
    session.lastProcessedCursor = event.cursor;
    session.updatedAtMs = Date.now();

    if (session.status === 'HOLDING' && this.positionExits) {
      const effective = await this.positionExits.settings.get();
      if (
        session.targetBuysAfterEntry !==
          effective.settings.targetBuysAfterEntry ||
        session.exitPolicy?.settingsRevision !== effective.revision
      ) {
        session.targetBuysAfterEntry =
          effective.settings.targetBuysAfterEntry;
        session.exitPolicy = {
          ...session.exitPolicy,
          settingsRevision: effective.revision,
        };
        await this.sessions.save(session);
      }
    }

    if (session.status === 'WAITING_FIRST_BUY' && event.kind === 'BUY') {
      const { added, count } = recordEntryObservationBuy(session, event);
      await this.sessions.save(session);

      if (!added) {
        return;
      }

      if (count < config.entryObservationBuys) {
        logger.info(
          {
            pair: session.pair.pair,
            token: session.pair.token,
            observedBuyCount: count,
            requiredBuyCount: config.entryObservationBuys,
            triggerTransaction: event.transactionHash,
          },
          'Achat observé en phase d\u00e9laboration, attente de la tranche d\u2019entr\u00e9e.',
        );
        return;
      }

      session.firstBuy = event;
      session.pendingExecutionSourceEventId = event.id;
      session.status = 'RISK_CHECKING';
      session.updatedAtMs = Date.now();
      await this.sessions.save(session);
      logger.info(
        {
          pair: session.pair.pair,
          token: session.pair.token,
          triggerTransaction: event.transactionHash,
          amountWbnb: formatEther(event.amountWbnb),
        },
        'Premier achat confirmé détecté; analyse de risque en cours.',
      );

      const openPositions = await this.sessions.countOpenPositions();
      if (openPositions >= config.maxConcurrentPositions) {
        await this.reject(session, 'Nombre maximal de positions simultanées atteint.');
        return;
      }

      let report: TokenRiskReport;
      try {
        report = await this.risk.analyze({
          pair: session.pair,
          metadata: session.metadata,
          blockNumber: event.cursor.blockNumber,
        });
        await this.reports.save(
          report,
          session.pendingExecutionSourceEventId,
        );
        session.riskReportId = report.id;
        session.updatedAtMs = Date.now();
        await this.sessions.save(session);

        logger.info(
          {
            pair: session.pair.pair,
            token: session.pair.token,
            reportId: report.id,
            score: report.score,
            verdict: report.verdict,
            failedChecks: report.checks
              .filter((check) => check.status === 'FAIL')
              .map((check) => check.code),
            warningChecks: report.checks
              .filter((check) => check.status === 'WARN' || check.status === 'UNKNOWN')
              .map((check) => check.code),
          },
          'TokenRiskReport enregistré.',
        );

        const blocked = config.riskPolicy === 'allow-only'
          ? report.verdict !== 'ALLOW'
          : report.verdict === 'BLOCK';
        if (blocked) {
          await this.reject(
            session,
            `TokenRiskReport ${report.verdict}, score ${report.score}/100.`,
          );
          return;
        }
      } catch (error) {
        await this.reject(session, `Analyse de risque impossible: ${errorMessage(error)}`);
        return;
      }

      session.status = 'BUY_PENDING';
      session.updatedAtMs = Date.now();
      await this.sessions.save(session);

      const amountInWei = await this.amountService.resolve(
        session,
        report.summary.liquidityWbnb ?? 0n,
      );
      if (amountInWei === null) {
        await this.reject(
          session,
          'Aucun montant d\'entrée admissible (minimum non atteint).',
        );
        return;
      }

      try {
        session.entry = await this.executor.buy(
          session,
          amountInWei,
          session.pendingExecutionSourceEventId,
        );
        delete session.unreconciledExecution;
        delete session.pendingExecutionSourceEventId;
        session.status = 'HOLDING';
        session.updatedAtMs = Date.now();
        await this.sessions.save(session);
        logger.info(
          {
            mode: session.entry.mode,
            pair: session.pair.pair,
            token: session.pair.token,
            amountInWei: amountInWei.toString(),
            amountOutToken: session.entry.amountOutToken.toString(),
          },
          'Entrée effectuée.',
        );
      } catch (error) {
        const unresolvedExecution = executionToReconcile(error);
        if (unresolvedExecution) session.unreconciledExecution = unresolvedExecution;
        if (requiresExecutionManualReview(error)) {
          session.status = 'MANUAL_REVIEW';
          session.rejectionReason = `Achat à réconcilier: ${errorMessage(error)}`;
          session.updatedAtMs = Date.now();
          await this.sessions.save(session);
          logger.error(
            {
              pair: session.pair.pair,
              token: session.pair.token,
              reason: errorMessage(error),
            },
            'Résultat de l’achat incertain; intervention manuelle requise.',
          );
        } else {
          await this.reject(session, `Achat impossible: ${errorMessage(error)}`);
        }
      }
      return;
    }

    if (session.status !== 'HOLDING' || event.kind !== 'BUY' || !session.entry) {
      await this.sessions.save(session);
      return;
    }

    if (!cursorAfter(event.cursor, session.entry.cursor)) return;
    const transactionHash = (
      event.transactionHash.toLowerCase()
    ) as SwapEvent['transactionHash'];
    if (session.entry.transactionHash?.toLowerCase() === transactionHash) return;
    if (session.countedBuyTransactionHashes.some(
      (hash) => hash.toLowerCase() === transactionHash
    )) return;

    session.countedBuyTransactionHashes.push(transactionHash);
    session.subsequentBuyCount += 1;
    session.updatedAtMs = Date.now();
    await this.sessions.save(session);
    logger.info(
      {
        pair: session.pair.pair,
        transactionHash,
        count: session.subsequentBuyCount,
        target: session.targetBuysAfterEntry,
      },
      'Achat externe comptabilisé après notre entrée.',
    );

    if (session.subsequentBuyCount < session.targetBuysAfterEntry) return;
    if (this.positionExits) {
      const effective = await this.positionExits.settings.get();
      const nowMs = Date.now();
      const observedMetrics = await this.positionExits.metrics.collect(
        session,
        effective.settings,
        session.exitPolicy ?? {},
        nowMs,
        { forceProbe: true },
      );
      const evaluation = evaluatePositionExit({
        settings: effective.settings,
        state: session.exitPolicy ?? {},
        metrics: observedMetrics,
        nowMs,
        openedAtMs: session.entry.confirmedAtMs,
        observedBuysAfterEntry: session.subsequentBuyCount,
      });
      session.exitPolicy = {
        ...evaluation.state,
        settingsRevision: effective.revision,
      };
      session.updatedAtMs = nowMs;
      await this.sessions.save(session);
      if (evaluation.primaryRule === undefined || evaluation.action === 'HOLD') {
        return;
      }
      const entryReference =
        session.entry.tradeId ??
        session.entry.transactionHash ??
        String(session.entry.confirmedAtMs);
      const decision = await this.positionExits.decisions.createDecision({
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
        metrics: observedMetrics,
        reason: evaluation.reason,
      });
      await this.requestPolicyExitLocked(session, decision, event.id);
      return;
    }
    await this.performSell(
      session,
      'Sortie effectuée après le nombre cible d’achats.',
      false,
      event.id,
    );
  }

  private async requestPolicyExitLocked(
    session: TokenSession,
    decision: PositionExitDecision,
    sourceEventId?: string,
  ): Promise<TokenSession> {
    if (!this.positionExits) {
      throw new Error('Politique de sortie non configurée.');
    }
    if (session.status !== 'HOLDING' || !session.entry || session.exit) {
      await this.positionExits.decisions.transitionDecision(
        decision.id,
        'PENDING',
        'SUPERSEDED',
      );
      return session;
    }
    const persistedDecision =
      await this.positionExits.decisions.findDecision(decision.id);
    if (!persistedDecision || persistedDecision.status !== 'PENDING') {
      return session;
    }
    const effective = await this.positionExits.settings.get();
    if (effective.revision !== persistedDecision.settingsRevision) {
      await this.positionExits.decisions.transitionDecision(
        decision.id,
        'PENDING',
        'SUPERSEDED',
      );
      return session;
    }
    const nowMs = Date.now();
    const latestMetrics = await this.positionExits.metrics.collect(
      session,
      effective.settings,
      session.exitPolicy ?? {},
      nowMs,
      { forceProbe: true },
    );
    const latest = evaluatePositionExit({
      settings: effective.settings,
      state: session.exitPolicy ?? {},
      metrics: latestMetrics,
      nowMs,
      openedAtMs: session.entry.confirmedAtMs,
      observedBuysAfterEntry: session.subsequentBuyCount,
    });
    session.exitPolicy = { ...latest.state, settingsRevision: effective.revision };

    if (latest.action === 'MANUAL_REVIEW') {
      await this.positionExits.decisions.transitionDecision(
        decision.id,
        'PENDING',
        'MANUAL_REVIEW',
      );
      session.status = 'MANUAL_REVIEW';
      session.rejectionReason = latest.reason;
      session.updatedAtMs = nowMs;
      await this.sessions.save(session);
      return session;
    }
    if (
      latest.action === 'HOLD' ||
      latest.action !== persistedDecision.action
    ) {
      await this.positionExits.decisions.transitionDecision(
        decision.id,
        'PENDING',
        'SUPERSEDED',
      );
      await this.sessions.save(session);
      return session;
    }
    const claimed = await this.positionExits.decisions.transitionDecision(
      decision.id,
      'PENDING',
      'EXECUTING',
    );
    if (!claimed) return session;
    session.pendingExitDecisionId = decision.id;
    await this.performSell(
      session,
      latest.action === 'EMERGENCY_SELL'
        ? 'Sortie d’urgence après baisse de liquidité.'
        : `Sortie automatique: ${latest.primaryRule ?? 'politique'}.`,
      false,
      sourceEventId,
      persistedDecision,
    );
    return session;
  }

  private async performSell(
    session: TokenSession,
    successMessage: string,
    rethrowFailure: boolean,
    sourceEventId?: string,
    decision?: PositionExitDecision,
  ): Promise<void> {
    if (sourceEventId === undefined) {
      delete session.pendingExecutionSourceEventId;
    } else {
      session.pendingExecutionSourceEventId = sourceEventId;
    }
    session.status = 'SELL_PENDING';
    session.sellAttempts += 1;
    session.updatedAtMs = Date.now();
    await this.sessions.save(session);
    try {
      session.exit = await this.executor.sell(
        session,
        undefined,
        session.pendingExecutionSourceEventId,
      );
      delete session.unreconciledExecution;
      delete session.pendingExecutionSourceEventId;
      session.status = 'CLOSED';
      delete session.pendingExitDecisionId;
      delete session.rejectionReason;
      session.updatedAtMs = Date.now();
      await this.sessions.save(session);
      if (decision && this.positionExits) {
        await this.positionExits.decisions.transitionDecision(
          decision.id,
          'EXECUTING',
          'EXECUTED',
          session.exit.tradeId
            ? { relatedTradeId: session.exit.tradeId }
            : {},
        );
      }
      logger.info(
        {
          pair: session.pair.pair,
          token: session.pair.token,
          mode: session.exit.mode,
          amountOutWei: session.exit.amountOutWei.toString(),
        },
        successMessage,
      );
    } catch (error) {
      const unresolvedExecution = executionToReconcile(error);
      if (unresolvedExecution) session.unreconciledExecution = unresolvedExecution;
      if (!unresolvedExecution) {
        delete session.pendingExitDecisionId;
      }
      session.status = 'MANUAL_REVIEW';
      session.rejectionReason = `Vente échouée: ${errorMessage(error)}`;
      session.updatedAtMs = Date.now();
      await this.sessions.save(session);
      if (decision && this.positionExits && !unresolvedExecution) {
        await this.positionExits.decisions.transitionDecision(
          decision.id,
          'EXECUTING',
          'FAILED',
          { errorType: error instanceof Error ? error.name : 'UnknownError' },
        );
      }
      logger.error(
        { pair: session.pair.pair, error: errorMessage(error) },
        'Vente échouée; intervention manuelle requise.',
      );
      if (rethrowFailure) throw error;
    }
  }

  private async reject(session: TokenSession, reason: string): Promise<void> {
    delete session.pendingExecutionSourceEventId;
    session.status = 'REJECTED';
    session.rejectionReason = reason;
    session.updatedAtMs = Date.now();
    await this.sessions.save(session);
    logger.warn(
      { pair: session.pair.pair, token: session.pair.token, reason },
      'Session rejetée.',
    );
  }
}
