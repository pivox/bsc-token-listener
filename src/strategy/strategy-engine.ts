import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config/env.js';
import { BuyExecutor } from '../execution/buy.executor.js';
import { BroadcastedTransactionError } from '../execution/errors.js';
import { SellExecutor } from '../execution/sell.executor.js';
import { SecurityService } from '../security/security-service.js';
import type { BotStore } from '../storage/store.js';
import type { ClassifiedSwap, TradeRecord } from '../types/domain.js';
import { Logger } from '../utils/logger.js';
import { SerialTaskQueue } from '../utils/serial-task-queue.js';
import { TokenSession } from './token-session.js';

export class StrategyEngine {
  private readonly entryQueue = new SerialTaskQueue();

  public constructor(
    private readonly config: AppConfig,
    private readonly securityService: SecurityService,
    private readonly buyExecutor: BuyExecutor,
    private readonly sellExecutor: SellExecutor,
    private readonly store: BotStore,
    private readonly logger: Logger,
    private readonly countOpenPositions: () => number,
  ) {}

  public async handleSwap(session: TokenSession, event: ClassifiedSwap): Promise<void> {
    if (session.isTerminal) {
      return;
    }

    if (session.status === 'WAITING_FIRST_BUY') {
      if (event.kind !== 'BUY') {
        session.recordProcessedCursor(event.cursor);
        await this.store.saveSession(session.snapshot);
        return;
      }

      session.recordFirstBuy(event);
      await this.store.saveSession(session.snapshot);
      this.logger.info('Premier achat confirmé détecté.', {
        pair: session.pair.pair,
        token: session.pair.token,
        triggerTransaction: event.transactionHash,
        amountWbnb: event.amountWbnb,
      });
      await this.enter(session);
      return;
    }

    if (session.status === 'HOLDING') {
      const counted = session.recordSubsequentBuy(event);
      if (counted) {
        this.logger.info('Achat externe comptabilisé après notre entrée.', {
          pair: session.pair.pair,
          transactionHash: event.transactionHash,
          count: session.snapshot.subsequentBuyCount,
          target: session.snapshot.targetBuysAfterEntry,
        });
      }
      await this.store.saveSession(session.snapshot);

      if (session.shouldSell()) {
        await this.exit(session);
      }
      return;
    }

    session.recordProcessedCursor(event.cursor);
    await this.store.saveSession(session.snapshot);
  }

  public async expireIfNeeded(session: TokenSession, nowMs: number): Promise<boolean> {
    if (!session.isWaitingExpired(nowMs, this.config.pairWaitFirstBuySeconds)) {
      return false;
    }
    session.expire("Aucun premier achat dans la fenêtre d'attente configurée.");
    await this.store.saveSession(session.snapshot);
    return true;
  }

  private enter(session: TokenSession): Promise<void> {
    // La file globale réserve les places d'entrée et évite que deux paires
    // dépassent simultanément MAX_CONCURRENT_POSITIONS.
    return this.entryQueue.run(() => this.enterSerialized(session));
  }

  private async enterSerialized(session: TokenSession): Promise<void> {
    if (session.status !== 'CHECKING') {
      return;
    }
    if (this.countOpenPositions() >= this.config.maxConcurrentPositions) {
      session.reject('Nombre maximal de positions simultanées atteint.');
      await this.store.saveSession(session.snapshot);
      return;
    }

    let safety;
    try {
      safety = await this.securityService.inspect(session.pair);
    } catch (error) {
      session.markError(error);
      await this.store.saveSession(session.snapshot);
      this.logger.error('Contrôle de sécurité interrompu.', {
        pair: session.pair.pair,
        token: session.pair.token,
        error,
      });
      return;
    }

    if (safety.metadata !== undefined) {
      session.setMetadata(safety.metadata);
    }
    if (!safety.accepted) {
      session.reject(safety.reasons.join(' | '));
      await this.store.saveSession(session.snapshot);
      this.logger.warn('Token refusé par les contrôles de sécurité.', {
        pair: session.pair.pair,
        token: session.pair.token,
        reasons: safety.reasons,
        wbnbLiquidityWei: safety.wbnbLiquidityWei,
      });
      return;
    }

    session.markBuyPending();
    await this.store.saveSession(session.snapshot);
    const trade = this.newTrade(session, 'BUY', this.config.buyAmountWei);
    await this.store.saveTrade(trade);

    try {
      const result = await this.buyExecutor.execute(session, async (hash) => {
        trade.transactionHash = hash;
        trade.updatedAtMs = Date.now();
        await this.store.saveTrade(trade);
      });
      session.markHolding({
        mode: result.mode,
        transactionHash: result.transactionHash,
        cursor: result.cursor,
        amountInWei: result.amountIn,
        amountOutToken: result.amountOut,
        confirmedAtMs: Date.now(),
      });
      trade.status = result.mode === 'dry-run' ? 'SIMULATED' : 'CONFIRMED';
      trade.transactionHash = result.transactionHash;
      trade.amountOut = result.amountOut;
      trade.blockNumber = result.blockNumber;
      trade.updatedAtMs = Date.now();
      await this.persistSessionAndTrade(session, trade);
      this.logger.info('Entrée effectuée.', {
        mode: result.mode,
        pair: session.pair.pair,
        token: session.pair.token,
        transactionHash: result.transactionHash,
        amountInWei: result.amountIn,
        amountOutToken: result.amountOut,
      });
    } catch (error) {
      if (session.snapshot.status === 'HOLDING') {
        const message =
          `Entrée confirmée mais persistance incomplète: ${error instanceof Error ? error.message : String(error)}`;
        session.markError(message);
        trade.error = message;
        trade.updatedAtMs = Date.now();
        try {
          await this.persistSessionAndTrade(session, trade);
        } catch (persistenceError) {
          this.logger.error('Impossible de persister la réconciliation de l’entrée.', {
            pair: session.pair.pair,
            token: session.pair.token,
            persistenceError,
          });
        }
        this.logger.error('Entrée confirmée; reprise manuelle requise après erreur de stockage.', {
          pair: session.pair.pair,
          token: session.pair.token,
          transactionHash: trade.transactionHash,
          error,
        });
        return;
      }

      const broadcastError =
        error instanceof BroadcastedTransactionError ? error : undefined;
      if (trade.transactionHash === undefined && broadcastError !== undefined) {
        trade.transactionHash = broadcastError.transactionHash;
      }
      trade.status =
        broadcastError !== undefined && broadcastError.outcome !== 'REVERTED'
          ? 'UNKNOWN'
          : 'FAILED';
      trade.error = error instanceof Error ? error.message : String(error);
      trade.updatedAtMs = Date.now();
      session.markError(error);
      await this.persistSessionAndTrade(session, trade);
      this.logger.error("Échec de l'entrée; vérifier le wallet si une transaction a été diffusée.", {
        pair: session.pair.pair,
        token: session.pair.token,
        transactionHash: trade.transactionHash,
        transactionOutcome: broadcastError?.outcome,
        error,
      });
    }
  }

  private async exit(session: TokenSession): Promise<void> {
    const entry = session.snapshot.entry;
    if (entry === undefined) {
      session.markError("Position d'entrée absente au moment de vendre.");
      await this.store.saveSession(session.snapshot);
      return;
    }

    session.markSellPending();
    await this.store.saveSession(session.snapshot);
    const trade = this.newTrade(session, 'SELL', entry.amountOutToken);
    await this.store.saveTrade(trade);

    try {
      const result = await this.sellExecutor.execute(session, async (hash) => {
        trade.transactionHash = hash;
        trade.updatedAtMs = Date.now();
        await this.store.saveTrade(trade);
      });
      session.markClosed({
        mode: result.mode,
        transactionHash: result.transactionHash,
        cursor: result.cursor,
        amountInToken: result.amountIn,
        amountOutWei: result.amountOut,
        confirmedAtMs: Date.now(),
      });
      trade.status = result.mode === 'dry-run' ? 'SIMULATED' : 'CONFIRMED';
      trade.transactionHash = result.transactionHash;
      trade.amountOut = result.amountOut;
      trade.blockNumber = result.blockNumber;
      trade.updatedAtMs = Date.now();
      await this.persistSessionAndTrade(session, trade);
      this.logger.info('Sortie effectuée après le nombre cible d’achats.', {
        mode: result.mode,
        pair: session.pair.pair,
        token: session.pair.token,
        transactionHash: result.transactionHash,
        countedBuys: session.snapshot.subsequentBuyCount,
        amountOutWei: result.amountOut,
      });
    } catch (error) {
      if (session.status === 'CLOSED') {
        this.logger.error('Vente confirmée mais persistance incomplète; vérifier le stockage.', {
          pair: session.pair.pair,
          token: session.pair.token,
          transactionHash: trade.transactionHash,
          error,
        });
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      const broadcastError =
        error instanceof BroadcastedTransactionError ? error : undefined;
      if (trade.transactionHash === undefined && broadcastError !== undefined) {
        trade.transactionHash = broadcastError.transactionHash;
      }
      const outcomeRequiresManualCheck =
        broadcastError !== undefined && broadcastError.outcome !== 'REVERTED';
      trade.status = outcomeRequiresManualCheck ? 'UNKNOWN' : 'FAILED';
      trade.error = message;
      trade.updatedAtMs = Date.now();
      if (session.status === 'SELL_PENDING') {
        if (outcomeRequiresManualCheck) {
          session.markError(
            `Vente diffusée mais résultat non réconcilié; vérifier le wallet et le reçu ${trade.transactionHash ?? ''}.`,
          );
        } else {
          session.markSellFailed(message);
        }
      } else {
        session.markError(error);
      }

      await this.persistSessionAndTrade(session, trade);
      if (session.status === 'HOLDING') {
        this.logger.error(
          'Échec connu de la vente; la position reste suivie et sera retentée au prochain Swap.',
          {
            pair: session.pair.pair,
            token: session.pair.token,
            transactionHash: trade.transactionHash,
            transactionOutcome: broadcastError?.outcome,
            sellAttempts: session.snapshot.sellAttempts,
            error,
          },
        );
      } else {
        this.logger.error(
          'Résultat de vente ambigu après diffusion; session arrêtée pour réconciliation manuelle.',
          {
            pair: session.pair.pair,
            token: session.pair.token,
            transactionHash: trade.transactionHash,
            transactionOutcome: broadcastError?.outcome,
            error,
          },
        );
      }
    }
  }

  private async persistSessionAndTrade(
    session: TokenSession,
    trade: TradeRecord,
  ): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await Promise.all([
          this.store.saveSession(session.snapshot),
          this.store.saveTrade(trade),
        ]);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 250));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private newTrade(
    session: TokenSession,
    side: TradeRecord['side'],
    amountIn: bigint,
  ): TradeRecord {
    const now = Date.now();
    return {
      id: randomUUID(),
      pair: session.pair.pair,
      token: session.pair.token,
      side,
      mode: this.config.executionMode,
      status: 'PENDING',
      transactionHash: undefined,
      amountIn,
      amountOut: 0n,
      blockNumber: undefined,
      error: undefined,
      createdAtMs: now,
      updatedAtMs: now,
    };
  }
}
