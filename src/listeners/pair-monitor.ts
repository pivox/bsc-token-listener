import type { Address, Hash } from 'viem';
import { pancakePairAbi } from '../abi/pancake-pair.abi.js';
import type { AppConfig } from '../config/env.js';
import type { RpcClients } from '../rpc/clients.js';
import type { BotStore } from '../storage/store.js';
import { classifySwap } from '../strategy/swap-classifier.js';
import { TokenSession } from '../strategy/token-session.js';
import type { ClassifiedSwap } from '../types/domain.js';
import { Logger } from '../utils/logger.js';
import { SerialTaskQueue } from '../utils/serial-task-queue.js';

interface SwapLogLike {
  args: {
    sender?: Address;
    to?: Address;
    amount0In?: bigint;
    amount1In?: bigint;
    amount0Out?: bigint;
    amount1Out?: bigint;
  };
  blockNumber: bigint | null;
  transactionHash: Hash | null;
  transactionIndex: number | null;
  logIndex: number | null;
  removed?: boolean;
}

function compareSwapLogs(left: SwapLogLike, right: SwapLogLike): number {
  const leftBlock = left.blockNumber ?? (1n << 255n);
  const rightBlock = right.blockNumber ?? (1n << 255n);
  if (leftBlock !== rightBlock) {
    return leftBlock < rightBlock ? -1 : 1;
  }

  const leftTransaction = left.transactionIndex ?? Number.MAX_SAFE_INTEGER;
  const rightTransaction = right.transactionIndex ?? Number.MAX_SAFE_INTEGER;
  if (leftTransaction !== rightTransaction) {
    return leftTransaction - rightTransaction;
  }

  const leftLog = left.logIndex ?? Number.MAX_SAFE_INTEGER;
  const rightLog = right.logIndex ?? Number.MAX_SAFE_INTEGER;
  return leftLog - rightLog;
}

export class PairMonitor {
  private unwatch: (() => void) | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private nextScanBlock: bigint | undefined;
  private reconcileRunning = false;
  private initializing = false;
  private failed = false;
  private terminalNotified = false;
  private readonly bufferedLogs: SwapLogLike[] = [];
  private readonly queue = new SerialTaskQueue();

  public constructor(
    private readonly config: AppConfig,
    private readonly clients: RpcClients,
    private readonly store: BotStore,
    private readonly session: TokenSession,
    private readonly logger: Logger,
    private readonly onSwap: (event: ClassifiedSwap) => Promise<void>,
    private readonly onTerminal: () => void,
  ) {}

  public async start(): Promise<void> {
    if (this.unwatch !== undefined) {
      return;
    }

    this.initializing = true;
    this.unwatch = this.clients.subscriptionClient.watchContractEvent({
      address: this.session.pair.pair,
      abi: pancakePairAbi,
      eventName: 'Swap',
      onLogs: (logs) => {
        const normalized = logs as readonly SwapLogLike[];
        if (this.initializing) {
          this.bufferedLogs.push(...normalized);
          return;
        }
        this.enqueueLogs(normalized);
      },
      onError: (error) => {
        this.logger.error("Erreur de l'écoute WebSocket Swap dédiée à la paire.", {
          pair: this.session.pair.pair,
          error,
        });
      },
    });

    try {
      await this.initialBackfill();
      if (this.session.isTerminal) {
        this.initializing = false;
        this.bufferedLogs.length = 0;
        this.stop();
        this.notifyTerminal();
        return;
      }

      await this.drainBufferedLogs();
      this.initializing = false;
      if (this.session.isTerminal) {
        this.stop();
        this.notifyTerminal();
        return;
      }

      this.reconcileTimer = setInterval(() => {
        void this.reconcile();
      }, this.config.eventReconcileSeconds * 1000);
      this.reconcileTimer.unref();

      this.logger.info('Écoute Swap dédiée active.', {
        pair: this.session.pair.pair,
        token: this.session.pair.token,
        status: this.session.status,
        reconcileSeconds: this.config.eventReconcileSeconds,
      });
    } catch (error) {
      this.initializing = false;
      this.stop();
      throw error;
    }
  }

  public stop(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    this.initializing = false;
    this.bufferedLogs.length = 0;
    if (this.reconcileTimer !== undefined) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = undefined;
    }
  }

  private enqueueLogs(logs: readonly SwapLogLike[]): void {
    void this.queue.run(() => this.processLogs(logs)).catch((error: unknown) => {
      void this.fail(error, 'traitement WebSocket');
    });
  }

  private async drainBufferedLogs(): Promise<void> {
    while (this.bufferedLogs.length > 0 && !this.failed && !this.session.isTerminal) {
      const batch = this.bufferedLogs.splice(0, this.bufferedLogs.length);
      await this.queue.run(() => this.processLogs(batch));
    }
  }

  private async initialBackfill(): Promise<void> {
    const currentBlock = await this.clients.publicClient.getBlockNumber();
    const configuredBackfill = BigInt(this.config.eventBackfillBlocks);
    const minimumBlock = currentBlock > configuredBackfill ? currentBlock - configuredBackfill : 0n;
    const desiredStart =
      this.session.snapshot.lastProcessedCursor?.blockNumber ?? this.session.pair.createdBlock;

    if (desiredStart < minimumBlock) {
      throw new Error(
        `La coupure dépasse EVENT_BACKFILL_BLOCKS: reprise automatique refusée (dernier=${desiredStart}, minimum=${minimumBlock}, courant=${currentBlock}).`,
      );
    }

    this.nextScanBlock = desiredStart;
    await this.scanUntil(currentBlock);
  }

  private async reconcile(): Promise<void> {
    if (this.reconcileRunning || this.failed || this.session.isTerminal) {
      return;
    }
    this.reconcileRunning = true;
    try {
      let currentBlock: bigint;
      try {
        currentBlock = await this.clients.publicClient.getBlockNumber();
      } catch (error) {
        this.logger.warn('Bloc courant indisponible pour le rattrapage HTTP.', {
          pair: this.session.pair.pair,
          error,
        });
        return;
      }
      if (this.nextScanBlock === undefined) {
        this.nextScanBlock = currentBlock;
      }
      await this.scanUntil(currentBlock);
    } catch (error) {
      await this.fail(error, 'traitement du rattrapage HTTP');
    } finally {
      this.reconcileRunning = false;
    }
  }

  private async scanUntil(toBlock: bigint): Promise<void> {
    const initialCursor = this.nextScanBlock;
    if (initialCursor === undefined || initialCursor > toBlock) {
      return;
    }

    let cursor: bigint = initialCursor;
    const chunkSize = BigInt(this.config.eventBackfillChunkSize);
    while (cursor <= toBlock && !this.failed && !this.session.isTerminal) {
      const tentativeEnd = cursor + chunkSize - 1n;
      const chunkEnd = tentativeEnd < toBlock ? tentativeEnd : toBlock;

      let logs;
      try {
        logs = await this.clients.publicClient.getContractEvents({
          address: this.session.pair.pair,
          abi: pancakePairAbi,
          eventName: 'Swap',
          fromBlock: cursor,
          toBlock: chunkEnd,
        });
      } catch (error) {
        this.logger.warn('Rattrapage HTTP Swap temporairement indisponible.', {
          pair: this.session.pair.pair,
          fromBlock: cursor,
          toBlock: chunkEnd,
          error,
        });
        return;
      }

      await this.queue.run(() => this.processLogs(logs as readonly SwapLogLike[]));
      this.nextScanBlock = chunkEnd + 1n;
      cursor = chunkEnd + 1n;
    }
  }

  private async processLogs(logs: readonly SwapLogLike[]): Promise<void> {
    const orderedLogs = [...logs].sort(compareSwapLogs);
    for (const log of orderedLogs) {
      if (this.failed || this.session.isTerminal) {
        return;
      }
      if (log.removed === true) {
        this.logger.warn('Swap retiré à la suite d’une réorganisation; réconciliation manuelle requise.', {
          pair: this.session.pair.pair,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
        });
        continue;
      }

      const args = log.args;
      if (
        args.sender === undefined ||
        args.to === undefined ||
        args.amount0In === undefined ||
        args.amount1In === undefined ||
        args.amount0Out === undefined ||
        args.amount1Out === undefined ||
        log.blockNumber === null ||
        log.transactionHash === null ||
        log.transactionIndex === null ||
        log.logIndex === null
      ) {
        this.logger.warn('Log Swap incomplet; événement ignoré.', { pair: this.session.pair.pair });
        continue;
      }

      const event = classifySwap(this.session.pair, {
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        transactionIndex: log.transactionIndex,
        logIndex: log.logIndex,
        sender: args.sender,
        recipient: args.to,
        amount0In: args.amount0In,
        amount1In: args.amount1In,
        amount0Out: args.amount0Out,
        amount1Out: args.amount1Out,
      });

      const inserted = await this.store.saveSwapEvent(event);
      if (!inserted) {
        continue;
      }

      await this.onSwap(event);
      if (this.session.isTerminal) {
        this.stop();
        this.notifyTerminal();
        return;
      }
    }
  }

  private async fail(error: unknown, source: string): Promise<void> {
    if (this.failed) {
      return;
    }
    this.failed = true;
    this.stop();

    if (!this.session.isTerminal) {
      this.session.markError(`${source}: ${error instanceof Error ? error.message : String(error)}`);
      try {
        await this.store.saveSession(this.session.snapshot);
      } catch (persistenceError) {
        this.logger.error("Impossible de persister l'état ERROR de la session.", {
          pair: this.session.pair.pair,
          persistenceError,
        });
      }
    }

    this.logger.error('Moniteur de paire arrêté; vérification manuelle du wallet requise.', {
      pair: this.session.pair.pair,
      token: this.session.pair.token,
      source,
      error,
    });
    this.notifyTerminal();
  }

  private notifyTerminal(): void {
    if (this.terminalNotified) {
      return;
    }
    this.terminalNotified = true;
    this.onTerminal();
  }
}
