import type { Address, Hash } from 'viem';
import { pancakeFactoryAbi } from '../abi/pancake-factory.abi.js';
import type { ConfirmedRangeRequest } from '../chain/canonical-chain.types.js';
import { config } from '../config/env.js';
import { publicClient, wsClient } from '../rpc/clients.js';
import type { CheckpointRepository } from '../storage/repositories.js';
import type { PairInfo } from '../types/domain.js';
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

function assertPairCreatedLogIdentity(
  log: PairCreatedLog,
): asserts log is PairCreatedLog & {
  blockNumber: bigint;
  blockHash: Hash;
  transactionHash: Hash;
  logIndex: number;
} {
  if (typeof log.blockNumber !== 'bigint') {
    throw new Error(
      'Log PairCreated HTTP confirmé invalide: blockNumber absent.',
    );
  }
  if (!log.blockHash) {
    throw new Error(
      'Log PairCreated HTTP confirmé invalide: blockHash absent.',
    );
  }
  if (!log.transactionHash) {
    throw new Error(
      'Log PairCreated HTTP confirmé invalide: transactionHash absent.',
    );
  }
  if (!Number.isSafeInteger(log.logIndex) || (log.logIndex ?? -1) < 0) {
    throw new Error(
      'Log PairCreated HTTP confirmé invalide: logIndex absent.',
    );
  }
}

interface ListenerWatcher {
  watchContractEvent(options: {
    address: Address;
    abi: readonly unknown[];
    eventName: string;
    onLogs(logs: readonly unknown[]): void;
    onError(error: unknown): void;
  }): () => void;
}

interface PairCreatedLogReader {
  getContractEvents(options: {
    address: Address;
    abi: readonly unknown[];
    eventName: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly unknown[]>;
}

interface ConfirmedRangeCoordinator {
  reconcile(request: ConfirmedRangeRequest): Promise<void>;
}

export interface PairCreatedListenerDependencies {
  watcher: ListenerWatcher;
  logReader: PairCreatedLogReader;
  coordinator: ConfirmedRangeCoordinator;
  reconcileIntervalMs?: number;
}

const missingCoordinator: ConfirmedRangeCoordinator = {
  reconcile: async () => {
    throw new Error(
      'CanonicalChainCoordinator requis pour ingérer les événements confirmés.',
    );
  },
};

const defaultDependencies: PairCreatedListenerDependencies = {
  watcher: wsClient as unknown as ListenerWatcher,
  logReader: publicClient as unknown as PairCreatedLogReader,
  coordinator: missingCoordinator,
};

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return error.name !== 'Error' ? error.name : error.constructor.name;
}

export class PairCreatedListener {
  private readonly onPair: (pair: PairInfo) => Promise<void>;
  private readonly dependencies: PairCreatedListenerDependencies;
  private stopWatch?: () => void;
  private interval?: NodeJS.Timeout;
  private reconciliation: Promise<void> | null = null;
  private reconcilePending = false;
  private stopped = false;

  constructor(
    checkpoints: CheckpointRepository,
    onPair: (pair: PairInfo) => Promise<void>,
  );
  constructor(
    onPair: (pair: PairInfo) => Promise<void>,
    dependencies: PairCreatedListenerDependencies,
  );
  constructor(
    first: CheckpointRepository | ((pair: PairInfo) => Promise<void>),
    second:
      | ((pair: PairInfo) => Promise<void>)
      | PairCreatedListenerDependencies,
  ) {
    if (typeof first === 'function') {
      this.onPair = first;
      this.dependencies = second as PairCreatedListenerDependencies;
      return;
    }
    void first;
    this.onPair = second as (pair: PairInfo) => Promise<void>;
    this.dependencies = defaultDependencies;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.stopWatch = this.dependencies.watcher.watchContractEvent({
      address: config.factory,
      abi: pancakeFactoryAbi,
      eventName: 'PairCreated',
      onLogs: () => {
        void this.requestReconcile().catch((error: unknown) =>
          logger.error(
            { errorType: safeErrorType(error) },
            'Réconciliation PairCreated déclenchée par WebSocket échouée.',
          ),
        );
      },
      onError: (error: unknown) => logger.error(
        { errorType: safeErrorType(error) },
        'WebSocket PairCreated en erreur.',
      ),
    });

    await this.requestReconcile();
    if (this.stopped) return;
    this.interval = setInterval(() => {
      void this.requestReconcile().catch((error: unknown) =>
        logger.error(
          { errorType: safeErrorType(error) },
          'Réconciliation PairCreated échouée.',
        ),
      );
    }, this.dependencies.reconcileIntervalMs ?? config.reconcileSeconds * 1_000);

    logger.info(
      { factory: config.factory, reconcileSeconds: config.reconcileSeconds },
      'Écoute PairCreated active.',
    );
  }

  stop(): void {
    this.stopped = true;
    this.stopWatch?.();
    if (this.interval) clearInterval(this.interval);
  }

  private requestReconcile(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.reconciliation) {
      this.reconcilePending = true;
      return this.reconciliation;
    }

    const execution = (async () => {
      let firstFailure: unknown;
      let failed = false;
      do {
        this.reconcilePending = false;
        try {
          await this.dependencies.coordinator.reconcile({
            listenerKey: 'pair-created',
            startBlock: 0n,
            processChunk: (fromBlock, toBlock) =>
              this.processChunk(fromBlock, toBlock),
          });
        } catch (error) {
          if (!failed) firstFailure = error;
          failed = true;
        }
      } while (this.reconcilePending && !this.stopped);
      if (failed) throw firstFailure;
    })();
    this.reconciliation = execution.finally(() => {
      this.reconciliation = null;
    });
    return this.reconciliation;
  }

  private async processChunk(
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<boolean> {
    const logs = await this.dependencies.logReader.getContractEvents({
      address: config.factory,
      abi: pancakeFactoryAbi,
      eventName: 'PairCreated',
      fromBlock,
      toBlock,
    });
    await this.processLogs(logs as PairCreatedLog[]);
    return true;
  }

  private async processLogs(logs: PairCreatedLog[]): Promise<void> {
    const identified = logs.map((log) => {
      assertPairCreatedLogIdentity(log);
      return log;
    });
    const sorted = [...identified].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber < b.blockNumber ? -1 : 1;
      }
      return a.logIndex - b.logIndex;
    });

    for (const log of sorted) {
      const { token0, token1, pair } = log.args;
      if (
        !token0 || !token1 || !pair
      ) continue;
      const token0IsWbnb =
        token0.toLowerCase() === config.wbnb.toLowerCase();
      const token1IsWbnb =
        token1.toLowerCase() === config.wbnb.toLowerCase();
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
        createdLogIndex: log.logIndex,
        discoveredAtMs: Date.now(),
      });
    }
  }
}
