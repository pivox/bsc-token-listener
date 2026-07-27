import type { Address, Hash } from 'viem';
import { pancakePairAbi } from '../abi/pancake-pair.abi.js';
import { config } from '../config/env.js';
import { publicClient, wsClient } from '../rpc/clients.js';
import {
  CheckpointRepository,
  SwapEventRepository,
} from '../storage/repositories.js';
import { classifySwap } from '../strategy/swap-classifier.js';
import { SessionEngine } from '../strategy/session-engine.js';
import type { TokenSession } from '../types/domain.js';
import { errorMessage } from '../utils/error.js';
import { logger } from '../utils/logger.js';

interface SwapLog {
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
}

export class SwapListener {
  private stopWatch?: () => void;
  private interval?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly session: TokenSession,
    private readonly checkpoints: CheckpointRepository,
    private readonly events: SwapEventRepository,
    private readonly engine: SessionEngine,
    private readonly onTerminal: (pair: Address) => void,
  ) {}

  async start(): Promise<void> {
    this.stopWatch = wsClient.watchContractEvent({
      address: this.session.pair.pair,
      abi: pancakePairAbi,
      eventName: 'Swap',
      onLogs: (logs: unknown[]) => {
        void this.processLogs(logs as SwapLog[]).catch((error: unknown) =>
          logger.error(
            { pair: this.session.pair.pair, error: errorMessage(error) },
            'Erreur Swap WebSocket.',
          ),
        );
      },
      onError: (error: unknown) => logger.error(
        { pair: this.session.pair.pair, error: errorMessage(error) },
        'WebSocket Swap en erreur.',
      ),
    });

    await this.reconcile();
    this.interval = setInterval(() => {
      void this.tick().catch((error: unknown) =>
        logger.error(
          { pair: this.session.pair.pair, error: errorMessage(error) },
          'Réconciliation Swap échouée.',
        ),
      );
    }, config.reconcileSeconds * 1000);

    logger.info(
      {
        pair: this.session.pair.pair,
        token: this.session.pair.token,
        status: this.session.status,
      },
      'Écoute Swap dédiée active.',
    );
  }

  stop(): void {
    this.stopWatch?.();
    if (this.interval) clearInterval(this.interval);
  }

  private async tick(): Promise<void> {
    if (await this.engine.expireIfNeeded(this.session)) {
      this.stop();
      this.onTerminal(this.session.pair.pair);
      return;
    }
    await this.reconcile();
    if (this.engine.isTerminal(this.session)) {
      this.stop();
      this.onTerminal(this.session.pair.pair);
    }
  }

  private async reconcile(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const key = `swap:${this.session.pair.pair.toLowerCase()}`;
    try {
      const latest = await publicClient.getBlockNumber();
      const stored = await this.checkpoints.get(key);
      let fromBlock = stored === null ? this.session.pair.createdBlock : stored + 1n;
      const chunk = 1_500n;
      while (fromBlock <= latest) {
        const toBlock = fromBlock + chunk - 1n > latest ? latest : fromBlock + chunk - 1n;
        const logs = await publicClient.getContractEvents({
          address: this.session.pair.pair,
          abi: pancakePairAbi,
          eventName: 'Swap',
          fromBlock,
          toBlock,
        });
        await this.processLogs(logs as SwapLog[]);
        await this.checkpoints.set(key, toBlock);
        fromBlock = toBlock + 1n;
      }
    } finally {
      this.running = false;
    }
  }

  private async processLogs(logs: SwapLog[]): Promise<void> {
    const sorted = [...logs].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) return (a.blockNumber ?? 0n) < (b.blockNumber ?? 0n) ? -1 : 1;
      if (a.transactionIndex !== b.transactionIndex) return (a.transactionIndex ?? 0) - (b.transactionIndex ?? 0);
      return (a.logIndex ?? 0) - (b.logIndex ?? 0);
    });

    for (const log of sorted) {
      const args = log.args;
      if (
        !args.sender || !args.to ||
        args.amount0In === undefined || args.amount1In === undefined ||
        args.amount0Out === undefined || args.amount1Out === undefined ||
        log.blockNumber === null || !log.transactionHash
      ) continue;

      const event = classifySwap(this.session.pair, {
        pair: this.session.pair.pair,
        transactionHash: log.transactionHash,
        blockNumber: log.blockNumber,
        transactionIndex: log.transactionIndex ?? 0,
        logIndex: log.logIndex ?? 0,
        sender: args.sender,
        recipient: args.to,
        amount0In: args.amount0In,
        amount1In: args.amount1In,
        amount0Out: args.amount0Out,
        amount1Out: args.amount1Out,
      });
      if (!(await this.events.claim(event))) continue;
      try {
        await this.engine.onSwap(this.session, event);
        await this.events.markProcessed(event.id);
      } catch (error) {
        await this.events.markFailed(event.id, errorMessage(error));
        throw error;
      }
    }
  }
}
