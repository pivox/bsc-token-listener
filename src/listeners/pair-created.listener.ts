import type { Address, Hash } from 'viem';
import { pancakeFactoryAbi } from '../abi/pancake-factory.abi.js';
import { config } from '../config/env.js';
import { publicClient, wsClient } from '../rpc/clients.js';
import { CheckpointRepository } from '../storage/repositories.js';
import type { PairInfo } from '../types/domain.js';
import { errorMessage } from '../utils/error.js';
import { logger } from '../utils/logger.js';

interface PairCreatedLog {
  args: {
    token0?: Address;
    token1?: Address;
    pair?: Address;
  };
  blockNumber: bigint | null;
  blockHash: Hash | null;
  transactionHash: Hash | null;
  logIndex: number | null;
}

export class PairCreatedListener {
  private stopWatch?: () => void;
  private interval?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly checkpoints: CheckpointRepository,
    private readonly onPair: (pair: PairInfo) => Promise<void>,
  ) {}

  async start(): Promise<void> {
    this.stopWatch = wsClient.watchContractEvent({
      address: config.factory,
      abi: pancakeFactoryAbi,
      eventName: 'PairCreated',
      onLogs: (logs: unknown[]) => {
        void this.processLogs(logs as PairCreatedLog[]).catch((error: unknown) =>
          logger.error({ error: errorMessage(error) }, 'Erreur PairCreated WebSocket.'),
        );
      },
      onError: (error: unknown) => logger.error({ error: errorMessage(error) }, 'WebSocket PairCreated en erreur.'),
    });

    await this.reconcile();
    this.interval = setInterval(() => {
      void this.reconcile().catch((error: unknown) =>
        logger.error({ error: errorMessage(error) }, 'Réconciliation PairCreated échouée.'),
      );
    }, config.reconcileSeconds * 1000);

    logger.info(
      { factory: config.factory, reconcileSeconds: config.reconcileSeconds },
      'Écoute PairCreated active.',
    );
  }

  stop(): void {
    this.stopWatch?.();
    if (this.interval) clearInterval(this.interval);
  }

  private async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const latest = await publicClient.getBlockNumber();
      const stored = await this.checkpoints.get('pair-created');
      let fromBlock = stored === null ? latest : stored.blockNumber + 1n;
      const chunk = 1_500n;
      while (fromBlock <= latest) {
        const toBlock = fromBlock + chunk - 1n > latest ? latest : fromBlock + chunk - 1n;
        const logs = await publicClient.getContractEvents({
          address: config.factory,
          abi: pancakeFactoryAbi,
          eventName: 'PairCreated',
          fromBlock,
          toBlock,
        });
        await this.processLogs(logs as PairCreatedLog[]);
        const block = await publicClient.getBlock({ blockNumber: toBlock });
        await this.checkpoints.set('pair-created', {
          blockNumber: toBlock,
          blockHash: block.hash,
        });
        fromBlock = toBlock + 1n;
      }
    } finally {
      this.running = false;
    }
  }

  private async processLogs(logs: PairCreatedLog[]): Promise<void> {
    const sorted = [...logs].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n) ? -1 : 1;
      return (a.logIndex ?? 0) - (b.logIndex ?? 0);
    });

    for (const log of sorted) {
      const { token0, token1, pair } = log.args;
      if (
        !token0 || !token1 || !pair || log.blockNumber === null ||
        !log.blockHash || !log.transactionHash
      ) continue;
      const token0IsWbnb = token0.toLowerCase() === config.wbnb.toLowerCase();
      const token1IsWbnb = token1.toLowerCase() === config.wbnb.toLowerCase();
      if (!token0IsWbnb && !token1IsWbnb) continue;

      await this.onPair({
        factory: config.factory,
        router: config.router,
        wbnb: config.wbnb,
        pair,
        token: token0IsWbnb ? token1 : token0,
        token0,
        token1,
        createdBlock: log.blockNumber,
        blockHash: log.blockHash,
        createdTransactionHash: log.transactionHash,
        createdLogIndex: log.logIndex ?? 0,
        discoveredAtMs: Date.now(),
      });
    }
  }
}
