import type { Address, Hash } from 'viem';
import { pancakeFactoryAbi } from '../abi/pancake-factory.abi.js';
import type {
  CanonicalBlock,
  ConfirmedRangeRequest,
} from '../chain/canonical-chain.types.js';
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
  transactionIndex: number | null;
  logIndex: number | null;
}

function assertPairCreatedLogIdentity(
  log: PairCreatedLog,
): asserts log is PairCreatedLog & {
  blockNumber: bigint;
  blockHash: Hash;
  transactionHash: Hash;
  transactionIndex: number;
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
  if (
    !Number.isSafeInteger(log.transactionIndex)
    || (log.transactionIndex ?? -1) < 0
  ) {
    throw new Error(
      'Log PairCreated HTTP confirmé invalide: transactionIndex absent.',
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
    logger.debug(
      {
        factory: config.factory,
        reconcileSeconds: config.reconcileSeconds,
        startBlock: 0,
      },
      'Démarrage de l’écouteur PairCreated.',
    );
    this.stopWatch = this.dependencies.watcher.watchContractEvent({
      address: config.factory,
      abi: pancakeFactoryAbi,
      eventName: 'PairCreated',
      onLogs: () => {
        logger.debug(
          { factory: config.factory },
          'PairCreated: événements WS reçus, lancement réconciliation immédiate.',
        );
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
      logger.debug(
        { factory: config.factory },
        'Réconciliation périodique PairCreated planifiée.',
      );
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
    logger.debug(
      { factory: config.factory },
      'Arrêt de l’écouteur PairCreated.',
    );
    this.stopped = true;
    this.stopWatch?.();
    if (this.interval) clearInterval(this.interval);
  }

  reconcileNow(): Promise<void> {
    logger.debug(
      { factory: config.factory },
      'Réconciliation PairCreated déclenchée manuellement.',
    );
    return this.requestReconcile();
  }

  private requestReconcile(): Promise<void> {
    if (this.stopped) {
      logger.debug(
        { factory: config.factory },
        'Réconciliation PairCreated ignorée: listener arrêté.',
      );
      return Promise.resolve();
    }
    if (this.reconciliation) {
      this.reconcilePending = true;
      logger.debug(
        { factory: config.factory },
        'Réconciliation PairCreated déjà en cours; marquage en attente.',
      );
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
            bootstrap: 'confirmed-head',
            processChunk: (fromBlock, toBlock, canonicalHeaders) =>
              this.processChunk(fromBlock, toBlock, canonicalHeaders),
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
    canonicalHeaders: readonly CanonicalBlock[],
  ): Promise<boolean> {
    const logs = await this.dependencies.logReader.getContractEvents({
      address: config.factory,
      abi: pancakeFactoryAbi,
      eventName: 'PairCreated',
      fromBlock,
      toBlock,
    });
    logger.debug(
      {
        listenerKey: 'pair-created',
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        rawLogCount: logs.length,
      },
      'Chunk PairCreated confirmé récupéré.',
    );
    await this.processLogs(
      logs as PairCreatedLog[],
      fromBlock,
      toBlock,
      canonicalHeaders,
    );
    return true;
  }

  private async processLogs(
    logs: PairCreatedLog[],
    fromBlock: bigint,
    toBlock: bigint,
    canonicalHeaders: readonly CanonicalBlock[],
  ): Promise<void> {
    const totalLogs = logs.length;
    logger.debug(
      {
        listenerKey: 'pair-created',
        totalLogs,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
      },
      'Traitement des logs PairCreated confirmés.',
    );
    const expectedHashes = new Map(
      canonicalHeaders.map((header) => [
        header.number,
        header.hash.toLowerCase(),
      ]),
    );
    const identified = logs.map((log) => {
      assertPairCreatedLogIdentity(log);
      if (log.blockNumber < fromBlock || log.blockNumber > toBlock) {
        throw new Error(
          `Log PairCreated HTTP hors plage confirmée: ${log.blockNumber}.`,
        );
      }
      if (
        expectedHashes.get(log.blockNumber)
        !== log.blockHash.toLowerCase()
      ) {
        throw new Error(
          `Log PairCreated incohérent avec le header canonique préparé au bloc ${log.blockNumber}.`,
        );
      }
      return log;
    });
    const sorted = [...identified].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber < b.blockNumber ? -1 : 1;
      }
      if (a.transactionIndex !== b.transactionIndex) {
        return a.transactionIndex - b.transactionIndex;
      }
      return a.logIndex - b.logIndex;
    });
    logger.debug(
      { identified: sorted.length },
      'Logs PairCreated identifiés après validation.',
    );

    for (const log of sorted) {
      const { token0, token1, pair } = log.args;
      if (!token0 || !token1 || !pair) {
        logger.debug(
          { blockNumber: log.blockNumber.toString() },
          'Log PairCreated ignoré: champs token/pair manquants.',
        );
        continue;
      }
      const token0IsWbnb =
        token0.toLowerCase() === config.wbnb.toLowerCase();
      const token1IsWbnb =
        token1.toLowerCase() === config.wbnb.toLowerCase();
      if (!token0IsWbnb && !token1IsWbnb) {
        logger.debug(
          {
            pair,
            token0,
            token1,
          },
          'Log PairCreated ignoré: paire non liée au WBNB.',
        );
        continue;
      }
      logger.debug(
        {
          pair,
          token: token0IsWbnb ? token1 : token0,
          token0IsWbnb,
          totalRawLogs: totalLogs,
        },
        'Log PairCreated WBNB détecté.',
      );

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
