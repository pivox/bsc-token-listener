import {
  calculateBuyPrincipal,
  calculateGasCost,
  calculateSellProceeds,
} from '../execution/trade-accounting.js';
import type { ExecutionReceipt } from '../execution/execution.types.js';
import type {
  TokenSession,
  TradeRecord,
  TradeTransactionRecord,
} from '../types/domain.js';
import { decideTransactionRecovery } from './reconciliation-policy.js';
import type {
  ClaimedRecovery,
  RecoveryDecision,
  RecoveryIntentExecutor,
  ReconciliationGateway,
  ReconciliationStore,
} from './recovery.types.js';

function requireBalance(value: bigint | undefined, label: string): bigint {
  if (value === undefined) throw new Error(`Solde ${label} absent.`);
  return value;
}

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return error.name !== 'Error' ? error.name : error.constructor.name;
}

export class SessionReconciler {
  constructor(
    private readonly store: ReconciliationStore,
    private readonly gateway: ReconciliationGateway,
    private readonly intents: RecoveryIntentExecutor | null,
    private readonly now: () => number = Date.now,
  ) {}

  async reconcile(claimed: ClaimedRecovery): Promise<void> {
    const session = structuredClone(claimed.snapshot.session);
    const trade = this.selectTrade(claimed);
    const transaction = trade
      ? this.selectTransaction(claimed, trade)
      : undefined;

    if (!transaction) {
      await this.reconcileWithoutTransaction(claimed, session, trade);
      return;
    }
    if (!trade) {
      throw new Error('Transaction de reprise sans trade parent.');
    }

    const observation = await this.gateway.observeTransaction(
      transaction.transactionHash,
    );
    const recovery = decideTransactionRecovery({
      hasTransaction: true,
      observation,
    });

    if (recovery.kind === 'WAIT') {
      this.recordRecovery(session, 'WAIT', recovery.reason);
      await this.apply(claimed, {
        session,
        action: 'WAIT',
        reason: recovery.reason,
        trade,
        transaction,
      });
      return;
    }
    if (recovery.kind === 'MANUAL_REVIEW') {
      session.status = 'MANUAL_REVIEW';
      session.rejectionReason = recovery.reason;
      session.unreconciledExecution = {
        tradeId: trade.id,
        step: transaction.step,
        outcome: 'UNKNOWN',
        transactionHash: transaction.transactionHash,
        recordedAtMs: this.now(),
      };
      this.recordRecovery(session, 'MANUAL_REVIEW', recovery.reason);
      await this.apply(claimed, {
        session,
        action: 'MANUAL_REVIEW',
        reason: recovery.reason,
        trade,
        transaction,
      });
      return;
    }
    if (recovery.kind === 'REVERT') {
      this.applyReceipt(trade, transaction, recovery.receipt);
      trade.status = 'REVERTED';
      trade.error = `${transaction.step} revert: ${transaction.transactionHash}`;
      transaction.status = 'REVERTED';
      transaction.error = trade.error;
      session.status = trade.side === 'BUY' ? 'REJECTED' : 'HOLDING';
      session.rejectionReason = trade.error;
      delete session.unreconciledExecution;
      this.recordRecovery(session, 'REVERTED', trade.error);
      await this.apply(claimed, {
        session,
        action: 'REVERTED',
        reason: trade.error,
        trade,
        transaction,
      });
      return;
    }
    if (recovery.kind === 'RESUME_INTENT') {
      throw new Error('Décision de reprise incohérente avec une transaction.');
    }
    if (transaction.step === 'APPROVE') {
      await this.reconcileConfirmedApproval(
        claimed,
        session,
        trade,
        transaction,
        recovery.receipt,
      );
      return;
    }

    try {
      if (trade.side === 'BUY' && transaction.step === 'BUY') {
        await this.measureBuy(claimed, session, trade, transaction, recovery.receipt);
        return;
      }
      if (trade.side === 'SELL' && transaction.step === 'SELL') {
        await this.measureSell(claimed, session, trade, transaction, recovery.receipt);
        return;
      }
      throw new Error(`Étape de mesure non supportée: ${transaction.step}.`);
    } catch (error) {
      this.applyReceipt(trade, transaction, recovery.receipt);
      trade.status = 'CONFIRMED';
      transaction.status = 'CONFIRMED';
      const reason = `Mesure post-confirmation impossible (${safeErrorType(error)}).`;
      transaction.measurementError = reason;
      session.status = 'MANUAL_REVIEW';
      session.rejectionReason = reason;
      session.unreconciledExecution = {
        tradeId: trade.id,
        step: transaction.step,
        outcome: 'CONFIRMED',
        transactionHash: transaction.transactionHash,
        recordedAtMs: this.now(),
      };
      this.recordRecovery(session, 'MANUAL_REVIEW', reason);
      await this.apply(claimed, {
        session,
        action: 'MANUAL_REVIEW',
        reason,
        trade,
        transaction,
      });
    }
  }

  private selectTrade(claimed: ClaimedRecovery): TradeRecord | undefined {
    const reference = claimed.snapshot.session.unreconciledExecution;
    if (reference) {
      return claimed.snapshot.trades.find((trade) => trade.id === reference.tradeId);
    }
    const side = claimed.snapshot.session.status === 'SELL_PENDING'
      ? 'SELL'
      : 'BUY';
    return claimed.snapshot.trades
      .filter((trade) => trade.side === side)
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .at(-1);
  }

  private selectTransaction(
    claimed: ClaimedRecovery,
    trade: TradeRecord,
  ): TradeTransactionRecord | undefined {
    const reference = claimed.snapshot.session.unreconciledExecution;
    const candidates = claimed.snapshot.transactions
      .filter((transaction) => transaction.tradeId === trade.id);
    if (reference) {
      return candidates.find((transaction) =>
        transaction.transactionHash.toLowerCase()
        === reference.transactionHash.toLowerCase());
    }
    return candidates
      .sort((left, right) => left.createdAtMs - right.createdAtMs)
      .at(-1);
  }

  private async reconcileWithoutTransaction(
    claimed: ClaimedRecovery,
    session: TokenSession,
    trade: TradeRecord | undefined,
  ): Promise<void> {
    if (trade?.status === 'SIMULATED') {
      await this.restoreSimulatedTrade(claimed, session, trade);
      return;
    }
    if (!this.intents || session.status === 'MANUAL_REVIEW') {
      const reason = session.status === 'MANUAL_REVIEW'
        ? 'Aucune transaction réconciliable; intervention manuelle requise.'
        : 'Aucun exécuteur de reprise configuré.';
      session.status = 'MANUAL_REVIEW';
      session.rejectionReason = reason;
      this.recordRecovery(session, 'MANUAL_REVIEW', reason);
      await this.apply(claimed, {
        session,
        action: 'MANUAL_REVIEW',
        reason,
        ...(trade ? { trade } : {}),
      });
      return;
    }
    const resumed = session.status === 'RISK_CHECKING'
      ? await this.intents.resumeRiskAndBuy(session)
      : session.status === 'BUY_PENDING'
        ? await this.intents.resumeBuy(session)
        : await this.intents.resumeSell(session);
    this.recordRecovery(resumed, 'RESUME_INTENT', 'Intention sans transaction reprise.');
    await this.apply(claimed, {
      session: resumed,
      action: 'RESUME_INTENT',
      reason: 'Intention sans transaction reprise.',
      ...(trade ? { trade } : {}),
    });
  }

  private async restoreSimulatedTrade(
    claimed: ClaimedRecovery,
    session: TokenSession,
    trade: TradeRecord,
  ): Promise<void> {
    if (trade.side === 'BUY') {
      const reference =
        session.entryObservationBuys?.[session.entryObservationBuys.length - 1]
        ?? session.firstBuy;
      if (!reference) {
        throw new Error('Curseur dry-run d’achat absent.');
      }
      session.entry = {
        mode: 'dry-run',
        tradeId: trade.id,
        amountInWei: trade.amountIn,
        ...(trade.quotedAmountOut === undefined
          ? {}
          : { quotedAmountOutToken: trade.quotedAmountOut }),
        amountOutToken: trade.amountOut,
        confirmedAtMs: trade.updatedAtMs,
        cursor: {
          blockNumber: reference.cursor.blockNumber,
          transactionIndex: Number.MAX_SAFE_INTEGER,
          logIndex: Number.MAX_SAFE_INTEGER,
        },
      };
      session.status = 'HOLDING';
    } else {
      if (!session.entry) throw new Error('Entrée dry-run absente.');
      session.exit = {
        mode: 'dry-run',
        tradeId: trade.id,
        ...(trade.relatedTradeId ? { entryTradeId: trade.relatedTradeId } : {}),
        amountInToken: trade.amountIn,
        ...(trade.quotedAmountOut === undefined
          ? {}
          : { quotedAmountOutWei: trade.quotedAmountOut }),
        amountOutWei: trade.amountOut,
        confirmedAtMs: trade.updatedAtMs,
      };
      session.status = 'CLOSED';
    }
    delete session.rejectionReason;
    delete session.unreconciledExecution;
    this.recordRecovery(session, 'SIMULATION_RESTORED', 'Simulation persistée restaurée.');
    await this.apply(claimed, {
      session,
      action: 'SIMULATION_RESTORED',
      reason: 'Simulation persistée restaurée.',
      trade,
    });
  }

  private async measureBuy(
    claimed: ClaimedRecovery,
    session: TokenSession,
    trade: TradeRecord,
    transaction: TradeTransactionRecord,
    receipt: ExecutionReceipt,
  ): Promise<void> {
    const [nativeAfter, tokenAfter] = await this.readPostTransactionBalances(
      session,
      transaction,
      receipt,
    );
    const gasCostWei = calculateGasCost(receipt.gasUsed, receipt.effectiveGasPrice);
    const amountOutToken =
      tokenAfter - requireBalance(transaction.tokenBalanceBefore, 'token avant achat');
    if (amountOutToken < 0n) throw new Error('Variation token achat invalide.');
    const amountInWei = calculateBuyPrincipal(
      requireBalance(transaction.nativeBalanceBefore, 'natif avant achat'),
      nativeAfter,
      gasCostWei,
    );
    this.applyReceipt(trade, transaction, receipt);
    transaction.nativeBalanceAfter = nativeAfter;
    transaction.tokenBalanceAfter = tokenAfter;
    trade.status = 'CONFIRMED';
    trade.actualAmountIn = amountInWei;
    trade.actualAmountOut = amountOutToken;
    trade.amountIn = amountInWei;
    trade.amountOut = amountOutToken;
    trade.gasCostWei = gasCostWei;
    session.entry = {
      mode: trade.mode,
      tradeId: trade.id,
      amountInWei,
      ...(trade.quotedAmountOut === undefined
        ? {}
        : { quotedAmountOutToken: trade.quotedAmountOut }),
      amountOutToken,
      gasCostWei,
      confirmedAtMs: transaction.confirmedAtMs ?? this.now(),
      cursor: {
        blockNumber: receipt.blockNumber,
        transactionIndex: receipt.transactionIndex,
        logIndex: Number.MAX_SAFE_INTEGER,
      },
      transactionHash: transaction.transactionHash,
    };
    session.status = 'HOLDING';
    delete session.rejectionReason;
    delete session.unreconciledExecution;
    this.recordRecovery(session, 'BUY_CONFIRMED', 'Achat confirmé réconcilié.');
    await this.apply(claimed, {
      session,
      action: 'BUY_CONFIRMED',
      reason: 'Achat confirmé réconcilié.',
      trade,
      transaction,
    });
  }

  private async measureSell(
    claimed: ClaimedRecovery,
    session: TokenSession,
    trade: TradeRecord,
    transaction: TradeTransactionRecord,
    receipt: ExecutionReceipt,
  ): Promise<void> {
    const [nativeAfter, tokenAfter] = await this.readPostTransactionBalances(
      session,
      transaction,
      receipt,
    );
    const sellGasWei = calculateGasCost(receipt.gasUsed, receipt.effectiveGasPrice);
    const amountInToken =
      requireBalance(transaction.tokenBalanceBefore, 'token avant vente') - tokenAfter;
    if (amountInToken < 0n) throw new Error('Variation token vente invalide.');
    const amountOutWei = calculateSellProceeds(
      requireBalance(transaction.nativeBalanceBefore, 'natif avant vente'),
      nativeAfter,
      sellGasWei,
    );
    const approvalGasWei = claimed.snapshot.transactions
      .filter((candidate) =>
        candidate.tradeId === trade.id
        && candidate.step === 'APPROVE'
        && candidate.status === 'CONFIRMED')
      .reduce((total, candidate) => total + (candidate.gasCostWei ?? 0n), 0n);
    this.applyReceipt(trade, transaction, receipt);
    transaction.nativeBalanceAfter = nativeAfter;
    transaction.tokenBalanceAfter = tokenAfter;
    trade.status = 'CONFIRMED';
    trade.actualAmountIn = amountInToken;
    trade.actualAmountOut = amountOutWei;
    trade.amountIn = amountInToken;
    trade.amountOut = amountOutWei;
    trade.gasCostWei = approvalGasWei + sellGasWei;
    session.exit = {
      mode: trade.mode,
      tradeId: trade.id,
      ...(trade.relatedTradeId ? { entryTradeId: trade.relatedTradeId } : {}),
      amountInToken,
      ...(trade.quotedAmountOut === undefined
        ? {}
        : { quotedAmountOutWei: trade.quotedAmountOut }),
      amountOutWei,
      gasCostWei: approvalGasWei + sellGasWei,
      confirmedAtMs: transaction.confirmedAtMs ?? this.now(),
      transactionHash: transaction.transactionHash,
    };
    session.status = 'CLOSED';
    delete session.rejectionReason;
    delete session.unreconciledExecution;
    this.recordRecovery(session, 'SELL_CONFIRMED', 'Vente confirmée réconciliée.');
    await this.apply(claimed, {
      session,
      action: 'SELL_CONFIRMED',
      reason: 'Vente confirmée réconciliée.',
      trade,
      transaction,
    });
  }

  private async reconcileConfirmedApproval(
    claimed: ClaimedRecovery,
    session: TokenSession,
    trade: TradeRecord,
    transaction: TradeTransactionRecord,
    receipt: ExecutionReceipt,
  ): Promise<void> {
    this.applyReceipt(trade, transaction, receipt);
    transaction.status = 'CONFIRMED';
    trade.status = 'CREATED';
    const reason = 'Approval confirmé; vente à reprendre sans rediffuser l’approval.';
    this.recordRecovery(session, 'APPROVAL_CONFIRMED', reason);
    await this.apply(claimed, {
      session,
      action: 'APPROVAL_CONFIRMED',
      reason,
      retainLease: this.intents !== null,
      trade,
      transaction,
    });
    if (this.intents) {
      const resumed = await this.intents.resumeSell(session);
      const resumeReason = 'Vente reprise après confirmation de l’approval.';
      this.recordRecovery(resumed, 'RESUME_INTENT', resumeReason);
      await this.apply(claimed, {
        session: resumed,
        action: 'RESUME_INTENT',
        reason: resumeReason,
      });
    }
  }

  private async readPostTransactionBalances(
    session: TokenSession,
    transaction: TradeTransactionRecord,
    receipt: ExecutionReceipt,
  ): Promise<readonly [bigint, bigint]> {
    if (
      transaction.nativeBalanceAfter !== undefined
      && transaction.tokenBalanceAfter !== undefined
    ) {
      return [
        transaction.nativeBalanceAfter,
        transaction.tokenBalanceAfter,
      ];
    }
    const contaminated =
      await this.gateway.hasLaterWalletTransactionInBlock(
        transaction.walletAddress,
        receipt.blockNumber,
        receipt.transactionIndex,
      );
    if (contaminated) {
      throw new Error('Mesure contaminée par une transaction wallet ultérieure.');
    }
    const [nativeAfter, tokenAfter] = await Promise.all([
      transaction.nativeBalanceAfter
        ?? this.gateway.getNativeBalance(
          transaction.walletAddress,
          receipt.blockNumber,
        ),
      transaction.tokenBalanceAfter
        ?? this.gateway.getTokenBalance(
          session.pair.token,
          transaction.walletAddress,
          receipt.blockNumber,
        ),
    ]);
    return [nativeAfter, tokenAfter];
  }

  private applyReceipt(
    trade: TradeRecord,
    transaction: TradeTransactionRecord,
    receipt: ExecutionReceipt,
  ): void {
    const now = this.now();
    const gasCostWei = calculateGasCost(receipt.gasUsed, receipt.effectiveGasPrice);
    transaction.status = receipt.status === 'success' ? 'CONFIRMED' : 'REVERTED';
    transaction.blockNumber = receipt.blockNumber;
    transaction.gasUsed = receipt.gasUsed;
    transaction.effectiveGasPrice = receipt.effectiveGasPrice;
    transaction.gasCostWei = gasCostWei;
    transaction.receiptStatus = receipt.status;
    transaction.confirmedAtMs = now;
    transaction.updatedAtMs = now;
    trade.blockNumber = receipt.blockNumber;
    trade.transactionHash = transaction.transactionHash;
    trade.updatedAtMs = now;
  }

  private recordRecovery(
    session: TokenSession,
    action: string,
    reason: string,
  ): void {
    const now = this.now();
    session.recovery = {
      attempts: (session.recovery?.attempts ?? 0) + 1,
      lastAction: action,
      lastReason: reason,
      lastAttemptAtMs: now,
    };
    session.updatedAtMs = now;
  }

  private apply(
    claimed: ClaimedRecovery,
    input: Omit<RecoveryDecision, 'idempotencyKey'>,
  ): Promise<void> {
    const reference = input.transaction?.transactionHash
      ?? input.trade?.id
      ?? input.session.pair.pair;
    return this.store.applyDecision(claimed, {
      ...input,
      idempotencyKey:
        `${input.session.pair.pair.toLowerCase()}:${reference.toLowerCase()}:`
        + `${input.action}:${input.session.status}`,
    });
  }
}
