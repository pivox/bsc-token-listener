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

const TERMINAL = new Set(['CLOSED', 'REJECTED', 'EXPIRED']);

export class SessionEngine {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly sessions: SessionRepository,
    private readonly reports: RiskReportRepository,
    private readonly risk: TokenRiskService,
    private readonly executor: TradeExecutor,
    private readonly amountService: EntryAmountService,
    private readonly runtimeBarrier = new RuntimeRecoveryBarrier(),
  ) {}

  async onSwap(session: TokenSession, event: SwapEvent): Promise<void> {
    await this.withLock(session, () => this.handle(session, event));
  }

  async sellManually(session: TokenSession): Promise<TokenSession> {
    return this.withLock(session, async () => {
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

  async ignoreManually(session: TokenSession): Promise<TokenSession> {
    return this.withLock(session, async () => {
      if (session.entry && !session.exit) {
        throw new Error('Une position ouverte ne peut pas être ignorée; vendez-la d’abord.');
      }
      if (!['WAITING_FIRST_BUY', 'REJECTED', 'EXPIRED'].includes(session.status)) {
        throw new Error(`Actif impossible à ignorer depuis le statut ${session.status}.`);
      }
      session.status = 'REJECTED';
      session.rejectionReason = 'Actif ignoré manuellement depuis le dashboard local.';
      session.updatedAtMs = Date.now();
      await this.sessions.save(session);
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
    if (session.status !== 'WAITING_FIRST_BUY') return false;
    const ttlMs = config.pairMonitorTtlMinutes * 60_000;
    if (Date.now() - session.createdAtMs < ttlMs) return false;
    session.status = 'EXPIRED';
    session.updatedAtMs = Date.now();
    session.rejectionReason = 'Aucun premier achat avant expiration du moniteur.';
    await this.sessions.save(session);
    return true;
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
        await this.reports.save(report);
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
        session.entry = await this.executor.buy(session, amountInWei);
        delete session.unreconciledExecution;
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
    if (session.entry.transactionHash === event.transactionHash) return;
    if (session.countedBuyTransactionHashes.includes(event.transactionHash)) return;

    session.countedBuyTransactionHashes.push(event.transactionHash);
    session.subsequentBuyCount += 1;
    session.updatedAtMs = Date.now();
    await this.sessions.save(session);
    logger.info(
      {
        pair: session.pair.pair,
        transactionHash: event.transactionHash,
        count: session.subsequentBuyCount,
        target: session.targetBuysAfterEntry,
      },
      'Achat externe comptabilisé après notre entrée.',
    );

    if (session.subsequentBuyCount < session.targetBuysAfterEntry) return;
    await this.performSell(
      session,
      'Sortie effectuée après le nombre cible d’achats.',
      false,
    );
  }

  private async performSell(
    session: TokenSession,
    successMessage: string,
    rethrowFailure: boolean,
  ): Promise<void> {
    session.status = 'SELL_PENDING';
    session.sellAttempts += 1;
    session.updatedAtMs = Date.now();
    await this.sessions.save(session);
    try {
      session.exit = await this.executor.sell(session);
      delete session.unreconciledExecution;
      session.status = 'CLOSED';
      delete session.rejectionReason;
      session.updatedAtMs = Date.now();
      await this.sessions.save(session);
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
      session.status = 'MANUAL_REVIEW';
      session.rejectionReason = `Vente échouée: ${errorMessage(error)}`;
      session.updatedAtMs = Date.now();
      await this.sessions.save(session);
      logger.error(
        { pair: session.pair.pair, error: errorMessage(error) },
        'Vente échouée; intervention manuelle requise.',
      );
      if (rethrowFailure) throw error;
    }
  }

  private async reject(session: TokenSession, reason: string): Promise<void> {
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
