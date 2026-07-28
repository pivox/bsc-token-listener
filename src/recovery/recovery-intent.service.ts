import type {
  EntryExecution,
  ExitExecution,
  TokenSession,
  TradeRecord,
} from '../types/domain.js';
import type { TokenRiskReport } from '../security/token-risk.types.js';
import {
  executionToReconcile,
  requiresExecutionManualReview,
} from '../strategy/execution-failure-policy.js';
import type { RecoveryIntentExecutor } from './recovery.types.js';

interface RiskReportStore {
  save(report: TokenRiskReport, sourceEventId?: string): Promise<void>;
  findById(id: string): Promise<TokenRiskReport | null>;
}

interface RiskAnalyzer {
  analyze(input: {
    pair: TokenSession['pair'];
    metadata: TokenSession['metadata'];
    blockNumber: bigint;
  }): Promise<TokenRiskReport>;
}

interface AmountResolver {
  resolve(session: TokenSession, liquidityWbnbWei: bigint): Promise<bigint | null>;
}

interface PositionCounter {
  countOpenPositions(): Promise<number>;
}

interface RecoveryTradeExecutor {
  buy(
    session: TokenSession,
    amountInWei: bigint,
    sourceEventId?: string,
  ): Promise<EntryExecution>;
  sell(
    session: TokenSession,
    recovered?: { trade: TradeRecord; approvalGasWei: bigint },
    sourceEventId?: string,
  ): Promise<ExitExecution>;
}

interface RecoveryIntentDependencies {
  reports: RiskReportStore;
  risk: RiskAnalyzer;
  amounts: AmountResolver;
  positions: PositionCounter;
  maxConcurrentPositions: number;
  executor: RecoveryTradeExecutor;
  riskPolicy: 'allow-only' | 'block-only';
  now?: () => number;
}

export class RecoveryIntentService implements RecoveryIntentExecutor {
  private readonly now: () => number;

  constructor(private readonly dependencies: RecoveryIntentDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async resumeRiskAndBuy(session: TokenSession): Promise<TokenSession> {
    if (session.status !== 'RISK_CHECKING' || !session.firstBuy) {
      throw new Error('Reprise du risque impossible depuis cet état.');
    }
    try {
      const report = await this.dependencies.risk.analyze({
        pair: session.pair,
        metadata: session.metadata,
        blockNumber: session.firstBuy.cursor.blockNumber,
      });
      await this.dependencies.reports.save(
        report,
        session.pendingExecutionSourceEventId,
      );
      session.riskReportId = report.id;
      session.updatedAtMs = this.now();

      const blocked = this.dependencies.riskPolicy === 'allow-only'
        ? report.verdict !== 'ALLOW'
        : report.verdict === 'BLOCK';
      if (blocked) {
        delete session.pendingExecutionSourceEventId;
        session.status = 'REJECTED';
        session.rejectionReason =
          `Reprise bloquée par TokenRiskReport ${report.verdict}.`;
        return session;
      }
      if (!(await this.hasPositionCapacity(false))) {
        delete session.pendingExecutionSourceEventId;
        session.status = 'REJECTED';
        session.rejectionReason =
          'Nombre maximal de positions simultanées atteint pendant la reprise.';
        return session;
      }
      session.status = 'BUY_PENDING';
      return this.resumeBuy(session, true);
    } catch (error) {
      session.recovery = {
        attempts: (session.recovery?.attempts ?? 0) + 1,
        lastAction: 'RISK_RETRY',
        lastReason: `Analyse RPC impossible (${this.safeErrorType(error)}).`,
        lastAttemptAtMs: this.now(),
      };
      session.updatedAtMs = this.now();
      return session;
    }
  }

  async resumeBuy(
    session: TokenSession,
    capacityAlreadyChecked = false,
  ): Promise<TokenSession> {
    if (session.status !== 'BUY_PENDING') {
      throw new Error('Reprise d’achat impossible depuis cet état.');
    }
    const report = session.riskReportId
      ? await this.dependencies.reports.findById(session.riskReportId)
      : null;
    const blocked = report && this.dependencies.riskPolicy === 'allow-only'
      ? report.verdict !== 'ALLOW'
      : report?.verdict === 'BLOCK';
    if (!report || blocked) {
      delete session.pendingExecutionSourceEventId;
      session.status = 'REJECTED';
      session.rejectionReason =
        'Reprise d’achat interdite sans TokenRiskReport ALLOW persisté.';
      session.updatedAtMs = this.now();
      return session;
    }
    if (
      !capacityAlreadyChecked
      && !(await this.hasPositionCapacity(true))
    ) {
      delete session.pendingExecutionSourceEventId;
      session.status = 'REJECTED';
      session.rejectionReason =
        'Nombre maximal de positions simultanées atteint pendant la reprise.';
      session.updatedAtMs = this.now();
      return session;
    }
    const amountInWei = await this.dependencies.amounts.resolve(
      session,
      report.summary.liquidityWbnb ?? 0n,
    );
    if (amountInWei === null) {
      delete session.pendingExecutionSourceEventId;
      session.status = 'REJECTED';
      session.rejectionReason = 'Montant de reprise d’achat non admissible.';
      session.updatedAtMs = this.now();
      return session;
    }
    try {
      session.entry = await this.dependencies.executor.buy(
        session,
        amountInWei,
        session.pendingExecutionSourceEventId,
      );
      delete session.pendingExecutionSourceEventId;
      session.status = 'HOLDING';
      delete session.rejectionReason;
      delete session.unreconciledExecution;
    } catch (error) {
      const unresolvedExecution = executionToReconcile(error);
      if (unresolvedExecution) session.unreconciledExecution = unresolvedExecution;
      session.status = requiresExecutionManualReview(error)
        ? 'MANUAL_REVIEW'
        : 'REJECTED';
      if (session.status === 'REJECTED') {
        delete session.pendingExecutionSourceEventId;
      }
      session.rejectionReason =
        `Reprise d’achat impossible (${this.safeErrorType(error)}).`;
    }
    session.updatedAtMs = this.now();
    return session;
  }

  async resumeSell(
    session: TokenSession,
    recovered?: { trade: TradeRecord; approvalGasWei: bigint },
  ): Promise<TokenSession> {
    if (session.status !== 'SELL_PENDING' || !session.entry || session.exit) {
      throw new Error('Reprise de vente impossible depuis cet état.');
    }
    try {
      session.exit = await this.dependencies.executor.sell(
        session,
        recovered,
        session.pendingExecutionSourceEventId,
      );
      delete session.pendingExecutionSourceEventId;
      session.status = 'CLOSED';
      delete session.rejectionReason;
      delete session.unreconciledExecution;
    } catch (error) {
      const unresolvedExecution = executionToReconcile(error);
      if (unresolvedExecution) session.unreconciledExecution = unresolvedExecution;
      session.status = requiresExecutionManualReview(error)
        ? 'MANUAL_REVIEW'
        : 'HOLDING';
      if (session.status === 'HOLDING') {
        delete session.pendingExecutionSourceEventId;
      }
      session.rejectionReason =
        `Reprise de vente impossible (${this.safeErrorType(error)}).`;
    }
    session.updatedAtMs = this.now();
    return session;
  }

  private safeErrorType(error: unknown): string {
    if (!(error instanceof Error)) return typeof error;
    return error.name !== 'Error' ? error.name : error.constructor.name;
  }

  private async hasPositionCapacity(currentSessionIsCounted: boolean): Promise<boolean> {
    const openPositions = await this.dependencies.positions.countOpenPositions();
    const otherOpenPositions = Math.max(
      0,
      openPositions - (currentSessionIsCounted ? 1 : 0),
    );
    return otherOpenPositions < this.dependencies.maxConcurrentPositions;
  }
}
