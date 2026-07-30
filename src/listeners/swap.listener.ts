import type { Address, Hash } from 'viem';
import { pancakePairAbi } from '../abi/pancake-pair.abi.js';
import type {
  CanonicalBlock,
  ConfirmedRangeRequest,
} from '../chain/canonical-chain.types.js';
import { config } from '../config/env.js';
import { publicClient, wsClient } from '../rpc/clients.js';
import { classifySwap } from '../strategy/swap-classifier.js';
import type { SessionEngine } from '../strategy/session-engine.js';
import { isSessionMonitorable } from '../strategy/session-monitor-policy.js';
import type { SwapEvent, TokenSession } from '../types/domain.js';
import { errorMessage } from '../utils/error.js';
import { logger } from '../utils/logger.js';

export interface SwapLog {
  args: {
    sender?: Address;
    to?: Address;
    amount0In?: bigint;
    amount1In?: bigint;
    amount0Out?: bigint;
    amount1Out?: bigint;
  };
  blockNumber: bigint | null;
  blockHash: Hash | null;
  transactionHash: Hash | null;
  transactionIndex: number | null;
  logIndex: number | null;
}

function assertSwapLogIdentity(
  log: SwapLog,
): asserts log is SwapLog & {
  blockNumber: bigint;
  blockHash: Hash;
  transactionHash: Hash;
  transactionIndex: number;
  logIndex: number;
} {
  if (typeof log.blockNumber !== 'bigint') {
    throw new Error('Log Swap HTTP invalide: blockNumber absent.');
  }
  if (!log.blockHash) {
    throw new Error('Log Swap HTTP invalide: blockHash absent.');
  }
  if (!log.transactionHash) {
    throw new Error('Log Swap HTTP invalide: transactionHash absent.');
  }
  if (
    !Number.isSafeInteger(log.transactionIndex)
    || (log.transactionIndex ?? -1) < 0
  ) {
    throw new Error('Log Swap HTTP invalide: transactionIndex absent.');
  }
  if (!Number.isSafeInteger(log.logIndex) || (log.logIndex ?? -1) < 0) {
    throw new Error('Log Swap HTTP invalide: logIndex absent.');
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

interface SwapLogReader {
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

interface SwapEngine {
  onSwap(session: TokenSession, event: SwapEvent): Promise<boolean>;
  expireIfNeeded(session: TokenSession): Promise<boolean>;
  isTerminal(session: TokenSession): boolean;
}

export interface SwapListenerDependencies {
  watcher: ListenerWatcher;
  logReader: SwapLogReader;
  coordinator: ConfirmedRangeCoordinator;
  requestReconcile?: (pair: Address) => void;
  requestAndWait?: (pair: Address, signal?: AbortSignal) => Promise<void>;
  reconcileIntervalMs?: number;
}

const missingCoordinator: ConfirmedRangeCoordinator = {
  reconcile: async () => {
    throw new Error(
      'CanonicalChainCoordinator requis pour ingérer les événements confirmés.',
    );
  },
};

const defaultDependencies: SwapListenerDependencies = {
  watcher: wsClient as unknown as ListenerWatcher,
  logReader: publicClient as unknown as SwapLogReader,
  coordinator: missingCoordinator,
};

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return error.name !== 'Error' ? error.name : error.constructor.name;
}

function getCoordinatorKey(pair: Address): string {
  return `swap:${pair.toLowerCase()}`;
}

export class SwapListener {
  private readonly engine: SwapEngine;
  private readonly onTerminal: (pair: Address) => void;
  private readonly dependencies: SwapListenerDependencies;
  private stopWatch: (() => void) | null = null;
  private reconciliation: Promise<void> | null = null;
  private reconcilePending = false;
  private stopped = false;
  private terminalNotified = false;
  private externalIngestionEnabled = false;
  private replayPrepared = false;
  private readonly hasCentralReconciliation: boolean;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    private readonly session: TokenSession,
    second: SwapEngine,
    third: SessionEngine | ((pair: Address) => void),
    fourth?: ((pair: Address) => void) | SwapListenerDependencies,
  ) {
    if (typeof third === 'function') {
      this.engine = second as SwapEngine;
      this.onTerminal = third;
      this.dependencies = typeof fourth === 'object' && fourth !== null
        ? fourth
        : defaultDependencies;
      this.hasCentralReconciliation = Boolean(
        this.dependencies.requestReconcile || this.dependencies.requestAndWait,
      );
      return;
    }

    this.engine = third as SwapEngine;
    this.onTerminal = fourth as (pair: Address) => void;
    this.dependencies = defaultDependencies;
    this.hasCentralReconciliation = false;
  }

  get pair(): Address {
    return this.session.pair.pair;
  }

  get createdBlock(): bigint {
    return this.session.pair.createdBlock;
  }

  get pairKey(): string {
    return getCoordinatorKey(this.session.pair.pair);
  }

  isReconcileCapable(): boolean {
    return !this.stopped && !this.replayPrepared;
  }

  async start(options: { signal?: AbortSignal } = {}): Promise<void> {
    logger.debug(
      {
        pair: this.session.pair.pair,
        token: this.session.pair.token,
        hasSignal: Boolean(options.signal),
      },
      'Démarrage de l’écouteur Swap.',
    );
    this.stopped = false;
    this.terminalNotified = false;
    this.externalIngestionEnabled = true;
    this.replayPrepared = false;
    this.installWatcher();

    await this.requestReconcile(options.signal);
    if (options.signal?.aborted) {
      this.stop();
      return;
    }
    if (this.stopped || !isSessionMonitorable(this.session)) return;
    logger.debug(
      {
        pair: this.session.pair.pair,
        token: this.session.pair.token,
      },
      'Swap listener prêt en mode monitorage.',
    );
  }

  async startForReplay(): Promise<void> {
    logger.debug(
      {
        pair: this.session.pair.pair,
        token: this.session.pair.token,
        createdBlock: this.session.pair.createdBlock.toString(),
      },
      'Démarrage de l’écouteur Swap en mode replay.',
    );
    this.stopped = false;
    this.terminalNotified = false;
    this.externalIngestionEnabled = false;
    this.replayPrepared = true;
    this.installWatcher();
    await this.requestReconcile();
  }

  async activateAfterReplay(): Promise<void> {
    if (this.stopped || !this.replayPrepared) return;
    logger.debug(
      {
        pair: this.session.pair.pair,
        token: this.session.pair.token,
      },
      'Fin du replay Swap: activation de l’ingestion WS.',
    );
    this.replayPrepared = false;
    this.externalIngestionEnabled = true;
    await this.requestReconcile();
  }

  private installWatcher(): void {
    if (this.hasCentralReconciliation && !this.dependencies.requestReconcile) {
      this.stopWatch = null;
      logger.debug(
        {
          pair: this.session.pair.pair,
        },
        'Mode réconciliation centralisée: watcher Swap désactivé.',
      );
      return;
    }
    logger.debug(
      {
        pair: this.session.pair.pair,
        listenerMode: this.replayPrepared ? 'replay' : 'live',
      },
      'Installation du watcher Swap.',
    );
    this.stopWatch = this.dependencies.watcher.watchContractEvent({
      address: this.session.pair.pair,
      abi: pancakePairAbi,
      eventName: 'Swap',
      onLogs: () => {
        if (this.stopped || !this.externalIngestionEnabled) return;
        this.signalReconcile();
      },
      onError: (error: unknown) => logger.error(
        {
          pair: this.session.pair.pair,
          errorType: safeErrorType(error),
        },
        'WebSocket Swap en erreur.',
      ),
    });
  }

  private requestReconcile(signal?: AbortSignal): Promise<void> {
    if (this.stopped) {
      logger.debug(
        { pair: this.session.pair.pair },
        'Réconciliation Swap ignorée: listener arrêté.',
      );
      return Promise.resolve();
    }

    if (this.dependencies.requestAndWait) {
      return this.track(
        this.dependencies.requestAndWait(this.session.pair.pair, signal),
      );
    }

    if (this.dependencies.requestReconcile) {
      this.dependencies.requestReconcile(this.session.pair.pair);
      return Promise.resolve();
    }

    if (this.reconciliation) {
      this.reconcilePending = true;
      logger.debug(
        { pair: this.session.pair.pair, pending: this.reconcilePending },
        'Réconciliation Swap déjà en cours; passage planifié.',
      );
      return this.reconciliation;
    }

    logger.debug(
      {
        pair: this.session.pair.pair,
        createdBlock: this.session.pair.createdBlock.toString(),
        hasSignal: Boolean(signal),
      },
      'Début d’un cycle de réconciliation Swap.',
    );

    const execution = this.runCanonicalReconcile(signal);
    this.reconciliation = execution.finally(() => {
      this.reconciliation = null;
    });
    return this.reconciliation;
  }

  private runCanonicalReconcile(signal?: AbortSignal): Promise<void> {
    logger.debug(
      {
        pair: this.session.pair.pair,
        createdBlock: this.session.pair.createdBlock.toString(),
        hasSignal: Boolean(signal),
      },
      'Début d’un cycle de réconciliation Swap.',
    );

    const execution = (async () => {
      let firstFailure: unknown;
      let failed = false;
      do {
        this.reconcilePending = false;
        try {
          await this.dependencies.coordinator.reconcile({
            listenerKey: getCoordinatorKey(this.session.pair.pair),
            startBlock: this.session.pair.createdBlock,
            ...(signal ? { signal } : {}),
            processChunk: (fromBlock, toBlock, canonicalHeaders) =>
              this.processChunk(fromBlock, toBlock, canonicalHeaders),
          });
        } catch (error) {
          logger.error(
            {
              pair: this.session.pair.pair,
              attempt: failed ? 'retry' : 'first',
              error: errorMessage(error),
            },
            'Échec de réconciliation Swap.',
          );
          if (!failed) firstFailure = error;
          failed = true;
        }
      } while (this.reconcilePending && !this.stopped && !signal?.aborted);
      if (failed) {
        logger.error(
          {
            pair: this.session.pair.pair,
            error: errorMessage(firstFailure),
          },
          'Cycle de réconciliation Swap terminé en erreur.',
        );
      } else {
        logger.debug(
          { pair: this.session.pair.pair },
          'Cycle de réconciliation Swap terminé avec succès.',
        );
      }
      if (failed) throw firstFailure;
    })();
    const tracked = this.track(execution);
    return tracked;
  }

  private signalReconcile(): void {
    if (this.hasCentralReconciliation) {
      this.dependencies.requestReconcile?.(this.session.pair.pair);
      return;
    }
    void this.requestReconcile().catch((error: unknown) => {
      logger.error(
        {
          pair: this.session.pair.pair,
          errorType: safeErrorType(error),
        },
        'Réconciliation Swap déclenchée par WebSocket échouée.',
      );
    });
  }

  async reconcileChunk(
    fromBlock: bigint,
    toBlock: bigint,
    canonicalHeaders: readonly CanonicalBlock[],
    logs: readonly unknown[],
  ): Promise<boolean> {
    return this.track(this.applySwapLogs(fromBlock, toBlock, canonicalHeaders, logs));
  }

  private async processChunk(
    fromBlock: bigint,
    toBlock: bigint,
    canonicalHeaders: readonly CanonicalBlock[],
  ): Promise<boolean> {
    logger.debug(
      {
        pair: this.session.pair.pair,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        expectedHeaderCount: canonicalHeaders.length,
      },
      'Lecture de chunk Swap confirmé.',
    );
    const logs = await this.dependencies.logReader.getContractEvents({
      address: this.session.pair.pair,
      abi: pancakePairAbi,
      eventName: 'Swap',
      fromBlock,
      toBlock,
    });
    logger.debug(
      {
        pair: this.session.pair.pair,
        rawLogCount: logs.length,
      },
      'Chunk Swap confirmé récupéré.',
    );
    return this.applySwapLogs(fromBlock, toBlock, canonicalHeaders, logs);
  }

  private async applySwapLogs(
    fromBlock: bigint,
    toBlock: bigint,
    canonicalHeaders: readonly CanonicalBlock[],
    logs: readonly unknown[],
  ): Promise<boolean> {
    return this.processLogs(
      logs as SwapLog[],
      fromBlock,
      toBlock,
      canonicalHeaders,
    );
  }

  private async processLogs(
    logs: SwapLog[],
    fromBlock: bigint,
    toBlock: bigint,
    canonicalHeaders: readonly CanonicalBlock[],
  ): Promise<boolean> {
    logger.debug(
      {
        pair: this.session.pair.pair,
        fromBlock: fromBlock.toString(),
        toBlock: toBlock.toString(),
        headerCount: canonicalHeaders.length,
        received: logs.length,
      },
      'Traitement des logs Swap confirmés.',
    );
    const expectedHashes = new Map(
      canonicalHeaders.map((header) => [
        header.number,
        header.hash.toLowerCase(),
      ]),
    );
    const identified = logs.map((log) => {
      assertSwapLogIdentity(log);
      if (log.blockNumber < fromBlock || log.blockNumber > toBlock) {
        throw new Error(
          `Log Swap HTTP hors plage confirmée: ${log.blockNumber}.`,
        );
      }
      if (
        expectedHashes.get(log.blockNumber)
        !== log.blockHash.toLowerCase()
      ) {
        throw new Error(
          `Log Swap incohérent avec le header canonique préparé au bloc ${log.blockNumber}.`,
        );
      }
      return log;
    });
    logger.debug(
      {
        pair: this.session.pair.pair,
        identifiedCount: identified.length,
      },
      'Logs Swap validés et alignés avec la chaîne canonique.',
    );
    const sorted = [...identified].sort((left, right) => {
      if (left.blockNumber !== right.blockNumber) {
        return left.blockNumber < right.blockNumber ? -1 : 1;
      }
      if (left.transactionIndex !== right.transactionIndex) {
        return left.transactionIndex - right.transactionIndex;
      }
      return left.logIndex - right.logIndex;
    });

    for (const log of sorted) {
      const args = log.args;
      if (
        !args.sender || !args.to
        || args.amount0In === undefined || args.amount1In === undefined
        || args.amount0Out === undefined || args.amount1Out === undefined
      ) continue;
      logger.debug(
        {
          pair: this.session.pair.pair,
          blockNumber: log.blockNumber.toString(),
        },
        'Log Swap ignoré: champs requis manquants.',
      );

      const event = classifySwap(this.session.pair, {
        pair: this.session.pair.pair,
        transactionHash: log.transactionHash,
        blockHash: log.blockHash,
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
      const consumed = await this.engine.onSwap(this.session, event);
      if (!consumed || !isSessionMonitorable(this.session)) {
        logger.debug(
          {
            pair: this.session.pair.pair,
            consumed,
          },
          'Arrêt du traitement Swap: session plus monitorable ou événement non consommé.',
        );
        this.stopAndNotifyTerminal();
        return false;
      }
    }
    logger.debug(
      {
        pair: this.session.pair.pair,
        processed: sorted.length,
      },
      'Chunk Swap terminé.',
    );
    return true;
  }

  async reconcileNow(): Promise<void> {
    logger.debug(
      {
        pair: this.session.pair.pair,
      },
      'Réconciliation Swap déclenchée manuellement.',
    );
    if (this.dependencies.requestAndWait) {
      return this.runCanonicalReconcile();
    }
    return this.requestReconcile();
  }

  private stopAndNotifyTerminal(): void {
    logger.warn(
      { pair: this.session.pair.pair },
      'Session terminale détectée, arrêt de l’écouteur Swap.',
    );
    this.stop();
    if (this.terminalNotified) return;
    this.terminalNotified = true;
    this.onTerminal(this.session.pair.pair);
  }

  stop(): void {
    logger.debug(
      {
        pair: this.session.pair.pair,
        inFlight: this.inFlight.size,
      },
      'Arrêt de l’écouteur Swap.',
    );
    this.stopped = true;
    this.externalIngestionEnabled = false;
    this.replayPrepared = false;
    this.stopWatch?.();
  }

  async stopAndDrain(): Promise<void> {
    logger.debug(
      {
        pair: this.session.pair.pair,
      },
      'Drain des opérations Swap en cours.',
    );
    this.stop();
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight]);
    }
    logger.debug(
      {
        pair: this.session.pair.pair,
      },
      'Opérations Swap en cours drainées.',
    );
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => {
      this.inFlight.delete(tracked);
    });
    this.inFlight.add(tracked);
    return tracked;
  }
}
