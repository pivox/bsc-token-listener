import type { Address, Hash } from 'viem';
import { pancakePairAbi } from '../abi/pancake-pair.abi.js';
import type {
  CanonicalBlock,
  ConfirmedRangeRequest,
} from '../chain/canonical-chain.types.js';
import { config } from '../config/env.js';
import { publicClient, wsClient } from '../rpc/clients.js';
import type { CheckpointRepository } from '../storage/repositories.js';
import { classifySwap } from '../strategy/swap-classifier.js';
import type { SessionEngine } from '../strategy/session-engine.js';
import { isSessionMonitorable } from '../strategy/session-monitor-policy.js';
import type { SwapEvent, TokenSession } from '../types/domain.js';
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
    throw new Error('Log Swap HTTP confirmé invalide: blockNumber absent.');
  }
  if (!log.blockHash) {
    throw new Error('Log Swap HTTP confirmé invalide: blockHash absent.');
  }
  if (!log.transactionHash) {
    throw new Error(
      'Log Swap HTTP confirmé invalide: transactionHash absent.',
    );
  }
  if (
    !Number.isSafeInteger(log.transactionIndex)
    || (log.transactionIndex ?? -1) < 0
  ) {
    throw new Error(
      'Log Swap HTTP confirmé invalide: transactionIndex absent.',
    );
  }
  if (!Number.isSafeInteger(log.logIndex) || (log.logIndex ?? -1) < 0) {
    throw new Error('Log Swap HTTP confirmé invalide: logIndex absent.');
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

export class SwapListener {
  private readonly engine: SwapEngine;
  private readonly onTerminal: (pair: Address) => void;
  private readonly dependencies: SwapListenerDependencies;
  private stopWatch?: () => void;
  private interval?: NodeJS.Timeout;
  private reconciliation: Promise<void> | null = null;
  private reconcilePending = false;
  private stopped = false;
  private terminalNotified = false;
  private externalIngestionEnabled = false;
  private replayPrepared = false;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(
    session: TokenSession,
    checkpoints: CheckpointRepository,
    engine: SessionEngine,
    onTerminal: (pair: Address) => void,
  );
  constructor(
    session: TokenSession,
    engine: SwapEngine,
    onTerminal: (pair: Address) => void,
    dependencies: SwapListenerDependencies,
  );
  constructor(
    private readonly session: TokenSession,
    second: CheckpointRepository | SwapEngine,
    third: SessionEngine | ((pair: Address) => void),
    fourth: ((pair: Address) => void) | SwapListenerDependencies,
  ) {
    if (typeof third === 'function') {
      this.engine = second as SwapEngine;
      this.onTerminal = third;
      this.dependencies = fourth as SwapListenerDependencies;
      return;
    }
    void second;
    this.engine = third;
    this.onTerminal = fourth as (pair: Address) => void;
    this.dependencies = defaultDependencies;
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.terminalNotified = false;
    this.externalIngestionEnabled = true;
    this.replayPrepared = false;
    this.installWatcher();

    await this.requestReconcile();
    if (this.stopped || !isSessionMonitorable(this.session)) return;
    this.installInterval();
    this.logActive();
  }

  async startForReplay(): Promise<void> {
    this.stopped = false;
    this.terminalNotified = false;
    this.externalIngestionEnabled = false;
    this.replayPrepared = true;
    this.installWatcher();
    await this.requestReconcile();
  }

  activateAfterReplay(): void {
    if (this.stopped || !this.replayPrepared) return;
    this.replayPrepared = false;
    this.externalIngestionEnabled = true;
    if (!isSessionMonitorable(this.session)) return;
    this.installInterval();
    this.logActive();
  }

  private installWatcher(): void {
    this.stopWatch = this.dependencies.watcher.watchContractEvent({
      address: this.session.pair.pair,
      abi: pancakePairAbi,
      eventName: 'Swap',
      onLogs: () => {
        if (this.stopped || !this.externalIngestionEnabled) return;
        void this.requestReconcile().catch((error: unknown) =>
          logger.error(
            {
              pair: this.session.pair.pair,
              errorType: safeErrorType(error),
            },
            'Réconciliation Swap déclenchée par WebSocket échouée.',
          ),
        );
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

  private installInterval(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = setInterval(() => {
      if (this.stopped) return;
      void this.track(this.tick()).catch((error: unknown) =>
        logger.error(
          {
            pair: this.session.pair.pair,
            errorType: safeErrorType(error),
          },
          'Réconciliation Swap échouée.',
        ),
      );
    }, this.dependencies.reconcileIntervalMs ?? config.reconcileSeconds * 1_000);
  }

  private logActive(): void {
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
    this.stopped = true;
    this.externalIngestionEnabled = false;
    this.replayPrepared = false;
    this.stopWatch?.();
    if (this.interval) clearInterval(this.interval);
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  reconcileNow(): Promise<void> {
    return this.requestReconcile();
  }

  private async tick(): Promise<void> {
    if (await this.engine.expireIfNeeded(this.session)) {
      this.stopAndNotifyTerminal();
      return;
    }
    await this.requestReconcile();
    if (this.engine.isTerminal(this.session)) {
      this.stopAndNotifyTerminal();
    }
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
            listenerKey: `swap:${this.session.pair.pair.toLowerCase()}`,
            startBlock: this.session.pair.createdBlock,
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
    const tracked = this.track(execution);
    this.reconciliation = tracked.finally(() => {
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
      address: this.session.pair.pair,
      abi: pancakePairAbi,
      eventName: 'Swap',
      fromBlock,
      toBlock,
    });
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
    const sorted = [...identified].sort((a, b) => {
      if (a.blockNumber !== b.blockNumber) {
        return a.blockNumber < b.blockNumber ? -1 : 1;
      }
      if (a.transactionIndex !== b.transactionIndex) {
        return a.transactionIndex - b.transactionIndex;
      }
      return a.logIndex - b.logIndex;
    });

    for (const log of sorted) {
      const args = log.args;
      if (
        !args.sender || !args.to
        || args.amount0In === undefined || args.amount1In === undefined
        || args.amount0Out === undefined || args.amount1Out === undefined
      ) continue;

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
        this.stopAndNotifyTerminal();
        return false;
      }
    }
    return true;
  }

  private stopAndNotifyTerminal(): void {
    this.stop();
    if (this.terminalNotified) return;
    this.terminalNotified = true;
    this.onTerminal(this.session.pair.pair);
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => {
      this.inFlight.delete(tracked);
    });
    this.inFlight.add(tracked);
    return tracked;
  }
}
