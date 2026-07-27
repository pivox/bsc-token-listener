import type { Address, Hash } from 'viem';
import { pancakeFactoryAbi } from '../abi/pancake-factory.abi.js';
import type { AppConfig } from '../config/env.js';
import type { PancakeV2Contracts } from '../config/network.js';
import type { PairCreatedDetection } from '../discovery/pair-resolver.js';
import type { RpcClients } from '../rpc/clients.js';
import { Logger } from '../utils/logger.js';
import { SerialTaskQueue } from '../utils/serial-task-queue.js';

interface PairCreatedLogLike {
  args: {
    token0?: Address;
    token1?: Address;
    pair?: Address;
  };
  blockNumber: bigint | null;
  transactionHash: Hash | null;
  logIndex: number | null;
  removed?: boolean;
}

function comparePairCreatedLogs(left: PairCreatedLogLike, right: PairCreatedLogLike): number {
  const leftBlock = left.blockNumber ?? (1n << 255n);
  const rightBlock = right.blockNumber ?? (1n << 255n);
  if (leftBlock !== rightBlock) {
    return leftBlock < rightBlock ? -1 : 1;
  }

  const leftIndex = left.logIndex ?? Number.MAX_SAFE_INTEGER;
  const rightIndex = right.logIndex ?? Number.MAX_SAFE_INTEGER;
  return leftIndex - rightIndex;
}

export class PairCreatedListener {
  private unwatch: (() => void) | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private nextScanBlock: bigint | undefined;
  private initializing = false;
  private readonly bufferedLogs: PairCreatedLogLike[] = [];
  private readonly queue = new SerialTaskQueue();
  private readonly seen = new Set<string>();
  private readonly failures = new Map<string, number>();

  public constructor(
    private readonly config: AppConfig,
    private readonly clients: RpcClients,
    private readonly contracts: PancakeV2Contracts,
    private readonly logger: Logger,
    private readonly onPairCreated: (detection: PairCreatedDetection) => Promise<void>,
  ) {}

  public async start(): Promise<void> {
    if (this.unwatch !== undefined) {
      return;
    }

    this.initializing = true;
    this.unwatch = this.clients.subscriptionClient.watchContractEvent({
      address: this.contracts.factory,
      abi: pancakeFactoryAbi,
      eventName: 'PairCreated',
      onLogs: (logs) => {
        const normalized = logs as readonly PairCreatedLogLike[];
        if (this.initializing) {
          this.bufferedLogs.push(...normalized);
          return;
        }
        this.enqueueLogs(normalized);
      },
      onError: (error) => {
        this.logger.error("Erreur de l'écoute WebSocket PairCreated.", { error });
      },
    });

    try {
      // Ne rejoue pas des créations anciennes sur une installation fraîche :
      // une paire historique ne doit jamais provoquer une entrée tardive.
      const startupBlock = await this.clients.publicClient.getBlockNumber();
      this.nextScanBlock = startupBlock;
      try {
        await this.scanRange(startupBlock, startupBlock);
      } catch (error) {
        this.logger.error(
          'Lecture initiale du bloc courant PairCreated incomplète; le rattrapage périodique reprendra.',
          { startupBlock, error },
        );
      }

      await this.drainBufferedLogs();
      this.initializing = false;

      this.reconcileTimer = setInterval(() => {
        void this.reconcile().catch((error: unknown) => {
          this.logger.error('Échec du rattrapage HTTP PairCreated; nouvel essai au prochain cycle.', {
            error,
          });
        });
      }, this.config.eventReconcileSeconds * 1000);
      this.reconcileTimer.unref();

      this.logger.info('Écoute PairCreated active.', {
        factory: this.contracts.factory,
        startupBlock,
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

  private enqueueLogs(logs: readonly PairCreatedLogLike[]): void {
    void this.queue.run(() => this.processLogs(logs)).catch((error: unknown) => {
      this.logger.error('Échec du traitement WebSocket PairCreated.', { error });
    });
  }

  private async drainBufferedLogs(): Promise<void> {
    while (this.bufferedLogs.length > 0) {
      const batch = this.bufferedLogs.splice(0, this.bufferedLogs.length);
      await this.queue.run(() => this.processLogs(batch));
    }
  }

  private async reconcile(): Promise<void> {
    const currentBlock = await this.clients.publicClient.getBlockNumber();
    const fromBlock = this.nextScanBlock ?? currentBlock;
    if (fromBlock > currentBlock) {
      return;
    }
    await this.scanRange(fromBlock, currentBlock);
  }

  private async scanRange(fromBlock: bigint, toBlock: bigint): Promise<void> {
    if (fromBlock > toBlock) {
      return;
    }

    const chunkSize = BigInt(this.config.eventBackfillChunkSize);
    let cursor = fromBlock;
    while (cursor <= toBlock) {
      const tentativeEnd = cursor + chunkSize - 1n;
      const chunkEnd = tentativeEnd < toBlock ? tentativeEnd : toBlock;
      const logs = await this.clients.publicClient.getContractEvents({
        address: this.contracts.factory,
        abi: pancakeFactoryAbi,
        eventName: 'PairCreated',
        fromBlock: cursor,
        toBlock: chunkEnd,
      });
      await this.queue.run(() => this.processLogs(logs as readonly PairCreatedLogLike[]));
      this.nextScanBlock = chunkEnd + 1n;
      cursor = chunkEnd + 1n;
    }
  }

  private async processLogs(logs: readonly PairCreatedLogLike[]): Promise<void> {
    const orderedLogs = [...logs].sort(comparePairCreatedLogs);
    for (const log of orderedLogs) {
      if (log.removed === true) {
        this.logger.warn('PairCreated retiré à la suite d’une réorganisation; événement ignoré.', {
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
        });
        continue;
      }

      const { token0, token1, pair } = log.args;
      if (
        token0 === undefined ||
        token1 === undefined ||
        pair === undefined ||
        log.blockNumber === null ||
        log.transactionHash === null ||
        log.logIndex === null
      ) {
        this.logger.warn('Log PairCreated incomplet; événement ignoré.');
        continue;
      }

      const id = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
      if (this.seen.has(id)) {
        continue;
      }
      try {
        await this.onPairCreated({
          token0,
          token1,
          pair,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
        });
        this.markSeen(id);
        this.failures.delete(id);
      } catch (error) {
        const attempts = (this.failures.get(id) ?? 0) + 1;
        this.failures.set(id, attempts);
        this.logger.error("Échec du traitement d'une nouvelle paire.", {
          pair,
          transactionHash: log.transactionHash,
          attempts,
          error,
        });
        if (attempts >= 3) {
          this.markSeen(id);
          this.failures.delete(id);
          this.logger.warn('Paire abandonnée après trois échecs de résolution.', {
            pair,
            transactionHash: log.transactionHash,
          });
          continue;
        }
        throw error;
      }
    }
  }

  private markSeen(id: string): void {
    this.seen.add(id);
    if (this.seen.size > 20_000) {
      const oldest = this.seen.values().next().value as string | undefined;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
  }
}
