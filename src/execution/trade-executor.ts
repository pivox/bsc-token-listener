import { randomUUID } from 'node:crypto';
import type { Hash } from 'viem';
import { config } from '../config/env.js';
import type {
  EntryExecution,
  ExecutionMode,
  ExitExecution,
  TokenSession,
  TradeRecord,
  TradeTransactionRecord,
} from '../types/domain.js';
import { errorMessage } from '../utils/error.js';
import {
  calculateBuyPrincipal,
  calculateGasCost,
  calculateSellProceeds,
} from './trade-accounting.js';
import type {
  ExecutionGateway,
  ExecutionReceipt,
  PreparedExecutionTransaction,
  TradeStore,
} from './execution.types.js';
import { TransactionQueue } from './transaction-queue.js';
import { ViemExecutionGateway } from './viem-execution.gateway.js';

function minimumOut(quoted: bigint): bigint {
  return (quoted * BigInt(10_000 - config.slippageBps)) / 10_000n;
}

function deadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + config.txDeadlineSeconds);
}

export class ExecutionOutcomeUnknownError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExecutionOutcomeUnknownError';
  }
}

export class ExecutionRevertedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutionRevertedError';
  }
}

export class ExecutionMeasurementError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ExecutionMeasurementError';
  }
}

export class TradeExecutor {
  private readonly queue = new TransactionQueue();

  constructor(
    private readonly trades: TradeStore,
    private readonly gateway: ExecutionGateway = new ViemExecutionGateway(),
    private readonly mode: ExecutionMode = config.executionMode,
  ) {}

  async buy(session: TokenSession, requestedAmountInWei: bigint): Promise<EntryExecution> {
    return this.queue.run(async () => {
      const trade = this.newTrade(session, 'BUY', requestedAmountInWei);
      await this.trades.save(trade);
      const path = [session.pair.wbnb, session.pair.token] as const;

      let quotedAmountOutToken: bigint;
      try {
        quotedAmountOutToken = await this.gateway.quote({
          router: session.pair.router,
          path,
          amountIn: requestedAmountInWei,
        });
        trade.amountOut = quotedAmountOutToken;
        trade.quotedAmountOut = quotedAmountOutToken;
        trade.updatedAtMs = Date.now();
        await this.trades.save(trade);
      } catch (error) {
        await this.failTrade(trade, error);
        throw error;
      }

      if (this.mode === 'dry-run') {
        const entryReference =
          session.entryObservationBuys?.[session.entryObservationBuys.length - 1]
          ?? session.firstBuy;
        if (!entryReference) {
          const error = new Error('Impossible de déterminer le curseur d\'entrée pour le dry-run.');
          await this.failTrade(trade, error);
          throw error;
        }
        trade.status = 'SIMULATED';
        trade.updatedAtMs = Date.now();
        await this.trades.save(trade);
        return {
          mode: 'dry-run',
          tradeId: trade.id,
          amountInWei: requestedAmountInWei,
          quotedAmountOutToken,
          amountOutToken: quotedAmountOutToken,
          confirmedAtMs: Date.now(),
          cursor: {
            blockNumber: entryReference.cursor.blockNumber,
            transactionIndex: Number.MAX_SAFE_INTEGER,
            logIndex: Number.MAX_SAFE_INTEGER,
          },
        };
      }

      const wallet = this.requireWallet();
      let nativeBalanceBefore: bigint;
      let tokenBalanceBefore: bigint;
      let prepared: PreparedExecutionTransaction;
      try {
        [nativeBalanceBefore, tokenBalanceBefore] = await Promise.all([
          this.gateway.getNativeBalance(wallet),
          this.gateway.getTokenBalance(session.pair.token, wallet),
        ]);
        prepared = await this.gateway.prepareBuy({
          router: session.pair.router,
          path,
          amountInWei: requestedAmountInWei,
          minimumOut: minimumOut(quotedAmountOutToken),
          deadline: deadline(),
        });
      } catch (error) {
        await this.failTrade(trade, error);
        throw error;
      }

      trade.walletAddress = wallet;
      trade.transactionHash = prepared.hash;
      const transaction = this.newTransaction(prepared, trade.id, {
        nativeBalanceBefore,
        tokenBalanceBefore,
      });
      const receipt = await this.submit(trade, transaction, prepared, true);

      try {
        const [nativeBalanceAfter, tokenBalanceAfter] = await Promise.all([
          this.gateway.getNativeBalance(wallet),
          this.gateway.getTokenBalance(session.pair.token, wallet),
        ]);
        const gasCostWei = calculateGasCost(receipt.gasUsed, receipt.effectiveGasPrice);
        const receivedToken = tokenBalanceAfter - tokenBalanceBefore;
        if (receivedToken < 0n) {
          throw new Error('variation du solde token d\'achat invalide.');
        }
        const actualAmountIn = calculateBuyPrincipal(
          nativeBalanceBefore,
          nativeBalanceAfter,
          gasCostWei,
        );

        transaction.nativeBalanceAfter = nativeBalanceAfter;
        transaction.tokenBalanceAfter = tokenBalanceAfter;
        trade.status = 'CONFIRMED';
        trade.actualAmountIn = actualAmountIn;
        trade.actualAmountOut = receivedToken;
        trade.gasCostWei = gasCostWei;
        trade.amountIn = actualAmountIn;
        trade.amountOut = receivedToken;
        trade.updatedAtMs = Date.now();
        await this.trades.saveLifecycle(trade, transaction);

        return {
          mode: 'live',
          tradeId: trade.id,
          amountInWei: actualAmountIn,
          quotedAmountOutToken,
          amountOutToken: receivedToken,
          gasCostWei,
          transactionHash: prepared.hash,
          confirmedAtMs: transaction.confirmedAtMs ?? Date.now(),
          cursor: {
            blockNumber: receipt.blockNumber,
            transactionIndex: receipt.transactionIndex,
            logIndex: Number.MAX_SAFE_INTEGER,
          },
        };
      } catch (error) {
        await this.recordMeasurementFailure(trade, transaction, error);
        throw new ExecutionMeasurementError(
          `Achat confirmé mais mesure des soldes impossible: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    });
  }

  async sell(session: TokenSession): Promise<ExitExecution> {
    return this.queue.run(async () => {
      const positionAmount = session.entry?.amountOutToken ?? 0n;
      if (positionAmount <= 0n) throw new Error('Aucun token à vendre.');

      const trade = this.newTrade(session, 'SELL', positionAmount);
      if (session.entry?.tradeId) trade.relatedTradeId = session.entry.tradeId;
      await this.trades.save(trade);
      const path = [session.pair.token, session.pair.wbnb] as const;

      let quotedAmountOutWei: bigint;
      try {
        quotedAmountOutWei = await this.gateway.quote({
          router: session.pair.router,
          path,
          amountIn: positionAmount,
        });
        trade.amountOut = quotedAmountOutWei;
        trade.quotedAmountOut = quotedAmountOutWei;
        trade.updatedAtMs = Date.now();
        await this.trades.save(trade);
      } catch (error) {
        await this.failTrade(trade, error);
        throw error;
      }

      if (this.mode === 'dry-run') {
        trade.status = 'SIMULATED';
        trade.updatedAtMs = Date.now();
        await this.trades.save(trade);
        return {
          mode: 'dry-run',
          tradeId: trade.id,
          ...(session.entry?.tradeId ? { entryTradeId: session.entry.tradeId } : {}),
          amountInToken: positionAmount,
          quotedAmountOutWei,
          amountOutWei: quotedAmountOutWei,
          confirmedAtMs: Date.now(),
        };
      }

      const wallet = this.requireWallet();
      trade.walletAddress = wallet;
      try {
        const walletBalance = await this.gateway.getTokenBalance(session.pair.token, wallet);
        if (walletBalance < positionAmount) {
          throw new Error(
            `Solde token insuffisant: position ${positionAmount}, wallet ${walletBalance}.`,
          );
        }
      } catch (error) {
        await this.failTrade(trade, error);
        throw error;
      }

      let approvalGasWei = 0n;
      try {
        const allowance = await this.gateway.getAllowance({
          token: session.pair.token,
          owner: wallet,
          spender: session.pair.router,
        });
        if (allowance < positionAmount) {
          approvalGasWei = await this.approve(
            trade,
            session,
            wallet,
            positionAmount,
          );
        }
      } catch (error) {
        if (
          error instanceof ExecutionOutcomeUnknownError
          || error instanceof ExecutionRevertedError
          || error instanceof ExecutionMeasurementError
        ) {
          throw error;
        }
        await this.failTrade(trade, error);
        throw error;
      }

      let nativeBalanceBefore: bigint;
      let tokenBalanceBefore: bigint;
      let prepared: PreparedExecutionTransaction;
      try {
        [nativeBalanceBefore, tokenBalanceBefore] = await Promise.all([
          this.gateway.getNativeBalance(wallet),
          this.gateway.getTokenBalance(session.pair.token, wallet),
        ]);
        if (tokenBalanceBefore < positionAmount) {
          throw new Error(
            `Solde token insuffisant après approval: position ${positionAmount}, wallet ${tokenBalanceBefore}.`,
          );
        }
        prepared = await this.gateway.prepareSell({
          router: session.pair.router,
          path,
          amountInToken: positionAmount,
          minimumOut: minimumOut(quotedAmountOutWei),
          deadline: deadline(),
        });
      } catch (error) {
        await this.failTrade(trade, error);
        throw error;
      }

      trade.transactionHash = prepared.hash;
      const transaction = this.newTransaction(prepared, trade.id, {
        nativeBalanceBefore,
        tokenBalanceBefore,
      });
      const receipt = await this.submit(trade, transaction, prepared, true);

      try {
        const [nativeBalanceAfter, tokenBalanceAfter] = await Promise.all([
          this.gateway.getNativeBalance(wallet),
          this.gateway.getTokenBalance(session.pair.token, wallet),
        ]);
        const sellGasWei = calculateGasCost(receipt.gasUsed, receipt.effectiveGasPrice);
        const actualAmountIn = tokenBalanceBefore - tokenBalanceAfter;
        if (actualAmountIn < 0n) {
          throw new Error('variation du solde token de vente invalide.');
        }
        const actualAmountOut = calculateSellProceeds(
          nativeBalanceBefore,
          nativeBalanceAfter,
          sellGasWei,
        );

        transaction.nativeBalanceAfter = nativeBalanceAfter;
        transaction.tokenBalanceAfter = tokenBalanceAfter;
        trade.status = 'CONFIRMED';
        trade.actualAmountIn = actualAmountIn;
        trade.actualAmountOut = actualAmountOut;
        trade.gasCostWei = approvalGasWei + sellGasWei;
        trade.amountIn = actualAmountIn;
        trade.amountOut = actualAmountOut;
        trade.updatedAtMs = Date.now();
        await this.trades.saveLifecycle(trade, transaction);

        return {
          mode: 'live',
          tradeId: trade.id,
          ...(session.entry?.tradeId ? { entryTradeId: session.entry.tradeId } : {}),
          amountInToken: actualAmountIn,
          quotedAmountOutWei,
          amountOutWei: actualAmountOut,
          gasCostWei: approvalGasWei + sellGasWei,
          transactionHash: prepared.hash,
          confirmedAtMs: transaction.confirmedAtMs ?? Date.now(),
        };
      } catch (error) {
        await this.recordMeasurementFailure(trade, transaction, error);
        throw new ExecutionMeasurementError(
          `Vente confirmée mais mesure des soldes impossible: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    });
  }

  private async approve(
    trade: TradeRecord,
    session: TokenSession,
    wallet: `0x${string}`,
    amount: bigint,
  ): Promise<bigint> {
    const nativeBalanceBefore = await this.gateway.getNativeBalance(wallet);
    const prepared = await this.gateway.prepareApproval({
      token: session.pair.token,
      spender: session.pair.router,
      amount,
    });
    const transaction = this.newTransaction(prepared, trade.id, {
      nativeBalanceBefore,
    });
    const receipt = await this.submit(trade, transaction, prepared, false);
    const gasCostWei = calculateGasCost(receipt.gasUsed, receipt.effectiveGasPrice);
    try {
      transaction.nativeBalanceAfter = await this.gateway.getNativeBalance(wallet);
      trade.status = 'CREATED';
      trade.gasCostWei = gasCostWei;
      trade.updatedAtMs = Date.now();
      await this.trades.saveLifecycle(trade, transaction);
    } catch (error) {
      await this.recordMeasurementFailure(trade, transaction, error, 'UNKNOWN');
      throw new ExecutionMeasurementError(
        `Approval confirmé mais mesure du solde impossible: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    return gasCostWei;
  }

  private async submit(
    trade: TradeRecord,
    transaction: TradeTransactionRecord,
    prepared: PreparedExecutionTransaction,
    finalStep: boolean,
  ): Promise<ExecutionReceipt> {
    trade.status = 'CREATED';
    trade.updatedAtMs = Date.now();
    await this.trades.saveLifecycle(trade, transaction);

    try {
      const returnedHash = await this.gateway.sendRawTransaction(
        prepared.serializedTransaction,
      );
      if (returnedHash.toLowerCase() !== prepared.hash.toLowerCase()) {
        throw new Error(`Hash RPC inattendu: ${returnedHash}.`);
      }
    } catch (error) {
      await this.markUnknown(trade, transaction, error);
      throw new ExecutionOutcomeUnknownError(
        `Statut de diffusion ${transaction.step} inconnu: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    const submittedAtMs = Date.now();
    transaction.status = 'SUBMITTED';
    transaction.submittedAtMs = submittedAtMs;
    transaction.updatedAtMs = submittedAtMs;
    trade.status = 'SUBMITTED';
    trade.updatedAtMs = submittedAtMs;
    await this.trades.saveLifecycle(trade, transaction);

    let receipt: ExecutionReceipt;
    try {
      receipt = await this.gateway.waitForReceipt(prepared.hash);
    } catch (error) {
      await this.markUnknown(trade, transaction, error);
      throw new ExecutionOutcomeUnknownError(
        `Reçu ${transaction.step} indisponible: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    const confirmedAtMs = Date.now();
    const gasCostWei = calculateGasCost(receipt.gasUsed, receipt.effectiveGasPrice);
    transaction.status = receipt.status === 'success' ? 'CONFIRMED' : 'REVERTED';
    transaction.blockNumber = receipt.blockNumber;
    transaction.gasUsed = receipt.gasUsed;
    transaction.effectiveGasPrice = receipt.effectiveGasPrice;
    transaction.gasCostWei = gasCostWei;
    transaction.receiptStatus = receipt.status;
    transaction.confirmedAtMs = confirmedAtMs;
    transaction.updatedAtMs = confirmedAtMs;
    trade.blockNumber = receipt.blockNumber;
    trade.gasCostWei = (trade.gasCostWei ?? 0n) + gasCostWei;
    trade.status = receipt.status === 'success'
      ? (finalStep ? 'SUBMITTED' : 'CREATED')
      : 'REVERTED';
    trade.updatedAtMs = confirmedAtMs;
    if (receipt.status === 'reverted') {
      trade.error = `${transaction.step} revert: ${prepared.hash}`;
      transaction.error = trade.error;
    }
    await this.trades.saveLifecycle(trade, transaction);

    if (receipt.status === 'reverted') {
      throw new ExecutionRevertedError(`${transaction.step} échoué: ${prepared.hash}`);
    }
    return receipt;
  }

  private async markUnknown(
    trade: TradeRecord,
    transaction: TradeTransactionRecord,
    error: unknown,
  ): Promise<void> {
    const now = Date.now();
    const reason = errorMessage(error);
    trade.status = 'UNKNOWN';
    trade.error = reason;
    trade.updatedAtMs = now;
    transaction.status = 'UNKNOWN';
    transaction.error = reason;
    transaction.updatedAtMs = now;
    await this.trades.saveLifecycle(trade, transaction);
  }

  private async recordMeasurementFailure(
    trade: TradeRecord,
    transaction: TradeTransactionRecord,
    error: unknown,
    tradeStatus: 'CONFIRMED' | 'UNKNOWN' = 'CONFIRMED',
  ): Promise<void> {
    const now = Date.now();
    const reason = errorMessage(error);
    trade.status = tradeStatus;
    trade.error = `Mesure incomplète: ${reason}`;
    trade.updatedAtMs = now;
    transaction.measurementError = reason;
    transaction.updatedAtMs = now;
    await this.trades.saveLifecycle(trade, transaction);
  }

  private async failTrade(trade: TradeRecord, error: unknown): Promise<void> {
    trade.status = 'FAILED';
    trade.error = errorMessage(error);
    trade.updatedAtMs = Date.now();
    await this.trades.save(trade);
  }

  private requireWallet(): `0x${string}` {
    if (!this.gateway.walletAddress) {
      throw new Error('Wallet live non initialisé.');
    }
    return this.gateway.walletAddress;
  }

  private newTrade(
    session: TokenSession,
    side: 'BUY' | 'SELL',
    amountIn: bigint,
  ): TradeRecord {
    const now = Date.now();
    return {
      id: randomUUID(),
      pair: session.pair.pair,
      token: session.pair.token,
      side,
      mode: this.mode,
      status: 'CREATED',
      amountIn,
      amountOut: 0n,
      createdAtMs: now,
      updatedAtMs: now,
    };
  }

  private newTransaction(
    prepared: PreparedExecutionTransaction,
    tradeId: string,
    balances: {
      nativeBalanceBefore: bigint;
      tokenBalanceBefore?: bigint;
    },
  ): TradeTransactionRecord {
    const now = Date.now();
    return {
      id: randomUUID(),
      tradeId,
      step: prepared.step,
      status: 'CREATED',
      walletAddress: prepared.walletAddress,
      transactionHash: prepared.hash,
      nonce: prepared.nonce,
      toAddress: prepared.toAddress,
      valueWei: prepared.valueWei,
      nativeBalanceBefore: balances.nativeBalanceBefore,
      ...(balances.tokenBalanceBefore === undefined
        ? {}
        : { tokenBalanceBefore: balances.tokenBalanceBefore }),
      createdAtMs: now,
      updatedAtMs: now,
    };
  }
}
