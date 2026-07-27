import { formatEther } from 'viem';
import { config } from '../config/env.js';
import { TradeExecutor } from '../execution/trade-executor.js';
import { TokenRiskService } from '../security/token-risk.service.js';
import {
  RiskReportRepository,
  SessionRepository,
} from '../storage/repositories.js';
import type { SwapEvent, TokenSession } from '../types/domain.js';
import { cursorAfter } from '../utils/cursor.js';
import { errorMessage } from '../utils/error.js';
import { logger } from '../utils/logger.js';

const TERMINAL = new Set(['CLOSED', 'REJECTED', 'EXPIRED']);

export class SessionEngine {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly sessions: SessionRepository,
    private readonly reports: RiskReportRepository,
    private readonly risk: TokenRiskService,
    private readonly executor: TradeExecutor,
  ) {}

  async onSwap(session: TokenSession, event: SwapEvent): Promise<void> {
    const key = session.pair.pair.toLowerCase();
    const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => undefined)
      .then(() => this.handle(session, event));
    this.locks.set(key, current);
    try {
      await current;
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
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

  private async handle(session: TokenSession, event: SwapEvent): Promise<void> {
    if (this.isTerminal(session)) return;
    session.lastProcessedCursor = event.cursor;
    session.updatedAtMs = Date.now();

    if (session.status === 'WAITING_FIRST_BUY' && event.kind === 'BUY') {
      session.firstBuy = event;
      session.status = 'RISK_CHECKING';
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

      try {
        const report = await this.risk.analyze({
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
      try {
        session.entry = await this.executor.buy(session);
        session.status = 'HOLDING';
        session.updatedAtMs = Date.now();
        await this.sessions.save(session);
        logger.info(
          {
            mode: session.entry.mode,
            pair: session.pair.pair,
            token: session.pair.token,
            amountInWei: session.entry.amountInWei.toString(),
            amountOutToken: session.entry.amountOutToken.toString(),
          },
          'Entrée effectuée.',
        );
      } catch (error) {
        await this.reject(session, `Achat impossible: ${errorMessage(error)}`);
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

    session.status = 'SELL_PENDING';
    session.sellAttempts += 1;
    session.updatedAtMs = Date.now();
    await this.sessions.save(session);
    try {
      session.exit = await this.executor.sell(session);
      session.status = 'CLOSED';
      session.updatedAtMs = Date.now();
      await this.sessions.save(session);
      logger.info(
        {
          pair: session.pair.pair,
          token: session.pair.token,
          mode: session.exit.mode,
          amountOutWei: session.exit.amountOutWei.toString(),
        },
        'Sortie effectuée après le nombre cible d’achats.',
      );
    } catch (error) {
      session.status = 'MANUAL_REVIEW';
      session.rejectionReason = `Vente échouée: ${errorMessage(error)}`;
      session.updatedAtMs = Date.now();
      await this.sessions.save(session);
      logger.error(
        { pair: session.pair.pair, error: errorMessage(error) },
        'Vente échouée; intervention manuelle requise.',
      );
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
