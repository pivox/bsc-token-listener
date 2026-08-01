import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import {
  open,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isHash } from 'viem';
import type {
  AnchoredListenerCheckpoint,
  CanonicalBlock,
  CanonicalBlockReader,
  CanonicalChainState,
  CanonicalReorgHandler,
  CanonicalReorgSummary,
  ChainBlockReference,
  ConfirmedRangeRequest,
  ListenerCheckpoint,
  ReorgImpact,
  ReorgReconciliation,
} from './canonical-chain.types.js';
import { confirmedHead } from './confirmed-blocks.js';
import { logger } from '../utils/logger.js';

export const DEFAULT_CONFIRMED_CHUNK_SIZE = 1_500;
export const DEFAULT_CANONICAL_RETENTION = 128;

export interface CanonicalChainStore {
  getCanonicalTip(): Promise<CanonicalBlock | null>;
  listCanonicalDescending(limit: number): Promise<CanonicalBlock[]>;
  saveCanonicalBlocks(blocks: CanonicalBlock[]): Promise<void>;
  pruneCanonicalBefore(blockNumber: bigint): Promise<void>;
}

export interface ListenerCheckpointStore {
  get(listenerKey: string): Promise<ListenerCheckpoint | null>;
  getOldestBlockNumber(): Promise<bigint | null>;
  set(
    listenerKey: string,
    checkpoint: AnchoredListenerCheckpoint,
  ): Promise<void>;
}

export interface CanonicalHeaderSpool {
  append(header: CanonicalBlock): Promise<void>;
  finish(): Promise<void>;
  headers(): AsyncGenerator<CanonicalBlock>;
  dispose(): Promise<void>;
}

export interface CanonicalHeaderSpoolFactory {
  create(): Promise<CanonicalHeaderSpool>;
}

export interface CanonicalListenerBarrier {
  runListener<T>(operation: () => Promise<T>): Promise<T>;
}

export interface CanonicalChainCoordinatorOptions {
  blockReader: CanonicalBlockReader;
  canonicalStore: CanonicalChainStore;
  checkpoints: ListenerCheckpointStore;
  reorgHandler: CanonicalReorgHandler;
  runtimeBarrier?: CanonicalListenerBarrier;
  confirmations?: number;
  chunkSize?: number;
  cutoff?: CanonicalBlock;
  headerSpoolFactory?: CanonicalHeaderSpoolFactory;
  afterReorg?: (state: CanonicalChainState) => Promise<CanonicalReorgCompletion | void>;
  onRecovered?: () => void | Promise<void>;
  onCleanupError?: (errorType: string) => void;
}

export interface CanonicalReorgCompletion {
  readonly identity: string;
  readonly reorgId: string;
  readonly replayedEvents: number;
}

export interface CanonicalReorgHydration {
  readonly reorgId: string;
  readonly detectedAtMs: number;
  readonly ancestor: ChainBlockReference;
  readonly oldTip: ChainBlockReference;
  readonly newTip: ChainBlockReference;
  readonly impact: ReorgImpact;
}

export interface CanonicalManualReviewHydration {
  readonly reorgId: string;
  readonly detectedAtMs: number;
  readonly ancestor: ChainBlockReference | null;
  readonly oldTip: ChainBlockReference;
  readonly newTip: ChainBlockReference;
  readonly impact: ReorgImpact;
}

export interface CanonicalChainCoordinatorStatus {
  running: boolean;
  pendingRequests: number;
  state: CanonicalChainState;
  lastReorg: CanonicalReorgSummary | null;
}

export type {
  CanonicalReorgHandler,
  ReorgReconciliation,
} from './canonical-chain.types.js';

export class CanonicalChainContinuityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalChainContinuityError';
  }
}

export class DeepReorgError extends CanonicalChainContinuityError {
  constructor() {
    super(
      `Aucun ancêtre canonique trouvé dans les ${DEFAULT_CANONICAL_RETENTION} derniers blocs.`,
    );
    this.name = 'DeepReorgError';
  }
}

export class FreshStartBoundaryError extends CanonicalChainContinuityError {
  constructor() {
    super('La reorg traverse le cutoff fresh-start.');
    this.name = 'FreshStartBoundaryError';
  }
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(
      `${name} doit être un entier entre ${minimum} et ${maximum}.`,
    );
  }
  return value;
}

function validateHeader(
  header: CanonicalBlock,
  expectedNumber: bigint,
): CanonicalBlock {
  if (
    typeof header?.number !== 'bigint'
    || header.number !== expectedNumber
    || !isHash(header.hash)
    || !isHash(header.parentHash)
  ) {
    throw new Error(
      `Header blockchain invalide pour le bloc ${expectedNumber}.`,
    );
  }
  return header;
}

function assertContinuous(
  previous: CanonicalBlock,
  next: CanonicalBlock,
): void {
  if (
    next.number !== previous.number + 1n
    || next.parentHash.toLowerCase() !== previous.hash.toLowerCase()
  ) {
    throw new CanonicalChainContinuityError(
      `Discontinuité canonique entre les blocs ${previous.number} et ${next.number}.`,
    );
  }
}

function sameHeader(left: CanonicalBlock, right: CanonicalBlock): boolean {
  return (
    left.number === right.number
    && left.hash.toLowerCase() === right.hash.toLowerCase()
    && left.parentHash.toLowerCase() === right.parentHash.toLowerCase()
  );
}

function cloneReconciliation(
  reorg: ReorgReconciliation,
): ReorgReconciliation {
  return {
    ancestor: reorg.ancestor ? { ...reorg.ancestor } : null,
    oldTip: { ...reorg.oldTip },
    newTip: { ...reorg.newTip },
    depth: reorg.depth,
  };
}

function cloneImpact(impact: ReorgImpact): ReorgImpact {
  return { ...impact };
}

function minimum(values: bigint[]): bigint | null {
  let result: bigint | null = null;
  for (const value of values) {
    if (result === null || value < result) result = value;
  }
  return result;
}

interface PreparedCanonicalScan {
  legacyHeader: CanonicalBlock | null;
}

interface PostReorgScope {
  active: boolean;
  reorgDetected: boolean;
  inFlight: Set<Promise<void>>;
  hasError: boolean;
  firstError: unknown;
}

class TemporaryCanonicalHeaderSpool implements CanonicalHeaderSpool {
  private handle: FileHandle | null;

  private constructor(
    private readonly path: string,
    handle: FileHandle,
  ) {
    this.handle = handle;
  }

  static async create(): Promise<TemporaryCanonicalHeaderSpool> {
    const path = join(
      tmpdir(),
      `bsc-canonical-chunks-${randomUUID()}.tmp`,
    );
    return new TemporaryCanonicalHeaderSpool(
      path,
      await open(path, 'wx', 0o600),
    );
  }

  async append(header: CanonicalBlock): Promise<void> {
    if (!this.handle) {
      throw new Error('Stockage temporaire de chunks déjà fermé.');
    }
    await this.handle.appendFile(
      `${header.number}\t${header.hash}\t${header.parentHash}\n`,
      'utf8',
    );
  }

  async finish(): Promise<void> {
    if (!this.handle) return;
    await this.handle.close();
    this.handle = null;
  }

  async *headers(): AsyncGenerator<CanonicalBlock> {
    await this.finish();
    const input = createReadStream(this.path, { encoding: 'utf8' });
    const lines = createInterface({
      input,
      crlfDelay: Infinity,
    });
    try {
      for await (const line of lines) {
        const [number, hash, parentHash, extra] = line.split('\t');
        if (
          number === undefined
          || hash === undefined
          || parentHash === undefined
          || extra !== undefined
        ) {
          throw new Error('Header temporaire de chunk invalide.');
        }
        let blockNumber: bigint;
        try {
          blockNumber = BigInt(number);
        } catch {
          throw new Error('Numéro temporaire de chunk invalide.');
        }
        yield validateHeader(
          { number: blockNumber, hash, parentHash } as CanonicalBlock,
          blockNumber,
        );
      }
    } finally {
      lines.close();
      if (!input.closed) {
        const closed = once(input, 'close');
        input.destroy();
        await closed;
      }
    }
  }

  async dispose(): Promise<void> {
    let cleanupError: unknown;
    try {
      await this.finish();
    } catch (error: unknown) {
      cleanupError = error;
    }
    try {
      await unlink(this.path);
    } catch (error: unknown) {
      if (
        !(error instanceof Error)
        || !('code' in error)
        || error.code !== 'ENOENT'
      ) {
        cleanupError ??= error;
      }
    }
    if (cleanupError !== undefined) throw cleanupError;
  }
}

const DEFAULT_HEADER_SPOOL_FACTORY: CanonicalHeaderSpoolFactory = {
  create: () => TemporaryCanonicalHeaderSpool.create(),
};

function safeErrorType(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return error.name !== 'Error' ? error.name : error.constructor.name;
}

export class CanonicalChainCoordinator {
  private readonly blockReader: CanonicalBlockReader;
  private readonly canonicalStore: CanonicalChainStore;
  private readonly checkpoints: ListenerCheckpointStore;
  private readonly reorgHandler: CanonicalReorgHandler;
  private readonly runtimeBarrier: CanonicalListenerBarrier | undefined;
  private readonly confirmations: number;
  private readonly chunkSize: bigint;
  private readonly cutoff: CanonicalBlock | null;
  private readonly headerSpoolFactory: CanonicalHeaderSpoolFactory;
  private readonly afterReorg:
    ((state: CanonicalChainState) => Promise<CanonicalReorgCompletion | void>) | undefined;
  private readonly onRecovered: (() => void | Promise<void>) | undefined;
  private readonly onCleanupError: ((errorType: string) => void) | undefined;
  private readonly postReorgScopes =
    new AsyncLocalStorage<PostReorgScope>();
  private activeRequests = 0;
  private reorgReadyForFinalization = false;
  private hydratedReorgs: CanonicalReorgHydration[] = [];
  private tail: Promise<void> = Promise.resolve();
  private status: CanonicalChainCoordinatorStatus = {
    running: false,
    pendingRequests: 0,
    state: 'HEALTHY',
    lastReorg: null,
  };

  constructor(options: CanonicalChainCoordinatorOptions) {
    this.blockReader = options.blockReader;
    this.canonicalStore = options.canonicalStore;
    this.checkpoints = options.checkpoints;
    this.reorgHandler = options.reorgHandler;
    this.runtimeBarrier = options.runtimeBarrier;
    this.headerSpoolFactory =
      options.headerSpoolFactory ?? DEFAULT_HEADER_SPOOL_FACTORY;
    this.afterReorg = options.afterReorg;
    this.onRecovered = options.onRecovered;
    this.onCleanupError = options.onCleanupError;
    if (options.cutoff !== undefined && options.cutoff.number < 0n) {
      throw new Error('Le cutoff fresh-start doit être positif.');
    }
    this.cutoff = options.cutoff === undefined
      ? null
      : structuredClone(
          validateHeader(options.cutoff, options.cutoff.number),
        );
    this.confirmations = boundedInteger(
      options.confirmations ?? 5,
      'confirmations',
      1,
      100,
    );
    this.chunkSize = BigInt(
      boundedInteger(
        options.chunkSize ?? DEFAULT_CONFIRMED_CHUNK_SIZE,
        'chunkSize',
        1,
        DEFAULT_CONFIRMED_CHUNK_SIZE,
      ),
    );
  }

  get currentStatus(): CanonicalChainCoordinatorStatus {
    return structuredClone(this.status);
  }

  hydratePendingReorg(reorg: CanonicalReorgHydration): void {
    this.hydratePendingReorgs([reorg]);
  }

  hydrateManualReviewReorg(reorg: CanonicalManualReviewHydration): void {
    if (this.status.state !== 'HEALTHY' || this.status.lastReorg !== null) {
      throw new Error('Une reorg runtime est déjà présente pendant l’hydratation.');
    }
    const validReference = (reference: ChainBlockReference): boolean =>
      reference.number >= 0n && isHash(reference.hash);
    const expectedId =
      `reorg:${reorg.oldTip.hash.toLowerCase()}:${reorg.newTip.hash.toLowerCase()}`;
    const shallow = reorg.ancestor !== null;
    const validShallow = shallow
      && validReference(reorg.ancestor as ChainBlockReference)
      && reorg.impact.depth !== null
      && Number.isSafeInteger(reorg.impact.depth)
      && reorg.impact.depth >= 1
      && reorg.impact.depth <= DEFAULT_CANONICAL_RETENTION
      && reorg.oldTip.number > (reorg.ancestor as ChainBlockReference).number
      && BigInt(reorg.impact.depth)
        === reorg.oldTip.number - (reorg.ancestor as ChainBlockReference).number
      && reorg.newTip.number >= reorg.oldTip.number;
    const validDeep = !shallow && reorg.impact.depth === null;
    if (
      reorg.reorgId !== expectedId
      || !Number.isSafeInteger(reorg.detectedAtMs)
      || reorg.detectedAtMs < 0
      || !validReference(reorg.oldTip)
      || !validReference(reorg.newTip)
      || !Number.isSafeInteger(reorg.impact.orphanedEvents)
      || reorg.impact.orphanedEvents < 0
      || !Number.isSafeInteger(reorg.impact.replayedEvents)
      || reorg.impact.replayedEvents < 0
      || reorg.impact.requiresManualReview !== true
      || (!validShallow && !validDeep)
    ) {
      throw new Error('Hydratation MANUAL_REVIEW persistée invalide.');
    }
    const persistedBlock = (
      reference: ChainBlockReference,
    ): CanonicalBlock => ({
      number: reference.number,
      hash: reference.hash,
      parentHash: reference.hash,
    });
    this.status = {
      ...this.status,
      state: 'MANUAL_REVIEW',
      lastReorg: {
        ancestor: reorg.ancestor === null
          ? null
          : persistedBlock(reorg.ancestor),
        oldTip: persistedBlock(reorg.oldTip),
        newTip: persistedBlock(reorg.newTip),
        depth: reorg.impact.depth,
        detectedAtMs: reorg.detectedAtMs,
        status: 'MANUAL_REVIEW',
        impact: cloneImpact(reorg.impact),
      },
    };
    this.reorgReadyForFinalization = false;
    this.hydratedReorgs = [];
  }

  hydratePendingReorgs(reorgs: readonly CanonicalReorgHydration[]): void {
    if (this.status.state !== 'HEALTHY' || this.status.lastReorg !== null) {
      throw new Error('Une reorg runtime est déjà présente pendant l’hydratation.');
    }
    if (reorgs.length === 0) {
      throw new Error('Aucun rollback shallow persisté à hydrater.');
    }
    const identities = new Set<string>();
    const reorgIds = new Set<string>();
    let previousDetectedAtMs = -1;
    for (const reorg of reorgs) {
      this.validateHydratedReorg(reorg);
      const identity =
        `${reorg.oldTip.hash.toLowerCase()}:${reorg.newTip.hash.toLowerCase()}`;
      if (
        identities.has(identity)
        || reorgIds.has(reorg.reorgId)
        || reorg.detectedAtMs < previousDetectedAtMs
      ) {
        throw new Error('Cascade de rollbacks shallow persistés invalide.');
      }
      identities.add(identity);
      reorgIds.add(reorg.reorgId);
      previousDetectedAtMs = reorg.detectedAtMs;
    }
    this.hydratedReorgs = reorgs.map((reorg) => structuredClone(reorg));
    this.installHydratedReorg(this.hydratedReorgs[0] as CanonicalReorgHydration);
  }

  requireManualReviewForPendingReorg(
    identity: string,
    reorgId: string,
  ): void {
    const lastReorg = this.status.lastReorg;
    const hydrated = this.hydratedReorgs[0];
    if (
      this.status.state !== 'RECONCILING'
      || lastReorg === null
      || lastReorg.status !== 'RECONCILING'
      || this.reorgIdentity(lastReorg) !== identity
      || (
        hydrated !== undefined
        && hydrated.reorgId !== reorgId
      )
    ) {
      throw new Error('Revue manuelle incompatible avec le rollback hydraté courant.');
    }
    this.status = {
      ...this.status,
      state: 'MANUAL_REVIEW',
      lastReorg: {
        ...lastReorg,
        status: 'MANUAL_REVIEW',
        impact: {
          ...lastReorg.impact,
          requiresManualReview: true,
        },
      },
    };
    this.reorgReadyForFinalization = false;
    this.hydratedReorgs = [];
  }

  private validateHydratedReorg(reorg: CanonicalReorgHydration): void {
    if (
      reorg.reorgId.length === 0
      || !Number.isSafeInteger(reorg.detectedAtMs)
      || reorg.detectedAtMs < 0
      || !Number.isSafeInteger(reorg.impact.depth)
      || reorg.impact.depth === null
      || reorg.impact.depth < 1
      || reorg.impact.depth > DEFAULT_CANONICAL_RETENTION
      || reorg.ancestor.number < 0n
      || reorg.oldTip.number <= reorg.ancestor.number
      || reorg.newTip.number < reorg.ancestor.number
      || BigInt(reorg.impact.depth) !== reorg.oldTip.number - reorg.ancestor.number
      || !isHash(reorg.ancestor.hash)
      || !isHash(reorg.oldTip.hash)
      || !isHash(reorg.newTip.hash)
    ) {
      throw new Error('Hydratation de rollback shallow persisté invalide.');
    }
  }

  private installHydratedReorg(reorg: CanonicalReorgHydration): void {
    const persistedBlock = (reference: ChainBlockReference): CanonicalBlock => ({
      number: reference.number,
      hash: reference.hash,
      // L’audit persiste les références, pas les parent hashes; ils ne servent
      // qu’à exposer l’état et ne sont jamais réutilisés pour une continuité RPC.
      parentHash: reference.hash,
    });
    this.status = {
      ...this.status,
      state: 'RECONCILING',
      lastReorg: {
        ancestor: persistedBlock(reorg.ancestor),
        oldTip: persistedBlock(reorg.oldTip),
        newTip: persistedBlock(reorg.newTip),
        depth: reorg.impact.depth,
        detectedAtMs: reorg.detectedAtMs,
        status: 'RECONCILING',
        impact: cloneImpact(reorg.impact),
      },
    };
    this.reorgReadyForFinalization = true;
  }

  reconcile(request: ConfirmedRangeRequest): Promise<void> {
    const scope = this.postReorgScopes.getStore();
    logger.debug(
      {
        listenerKey: request.listenerKey,
        state: this.status.state,
        pendingRequests: this.status.pendingRequests + 1,
      },
      'Réception d’une demande de réconciliation canonique.',
    );
    this.status = {
      ...this.status,
      pendingRequests: this.status.pendingRequests + 1,
    };
    if (scope?.active === true) {
      const execution = this.runRequest(request).then((reorgDetected) => {
        if (reorgDetected) scope.reorgDetected = true;
      });
      let observed: Promise<void>;
      observed = execution.then(
        () => {
          scope.inFlight.delete(observed);
        },
        (error: unknown) => {
          if (!scope.hasError) {
            scope.hasError = true;
            scope.firstError = error;
          }
          scope.inFlight.delete(observed);
        },
      );
      scope.inFlight.add(observed);
      return execution;
    }

    let requestStarted = false;
    let requestCancelled = false;
    let pendingReleased = false;
    const releasePending = (): void => {
      if (pendingReleased) return;
      pendingReleased = true;
      this.status = {
        ...this.status,
        pendingRequests: this.status.pendingRequests - 1,
      };
      logger.debug(
        { listenerKey: request.listenerKey },
        'Requête canonique désenregistrée des pending.',
      );
    };
    const cancelQueuedRequest = (): boolean => {
      if (requestStarted || requestCancelled) return false;
      requestCancelled = true;
      releasePending();
      return true;
    };
    const queuedRequestCancelled = (): boolean => {
      if (!requestCancelled && request.signal?.aborted === true) {
        cancelQueuedRequest();
      }
      return requestCancelled;
    };

    if (this.status.state === 'RECONCILING') {
      logger.debug(
        { listenerKey: request.listenerKey },
        'Mode RECONCILING: sérialisation de la demande en queue.',
      );
      const operation = this.tail.then(async () => {
        try {
          if (queuedRequestCancelled()) return;
          if (this.status.state === 'RECONCILING') {
            await this.finalizePendingReorg();
          }
          if (queuedRequestCancelled()) return;
          requestStarted = true;
          await this.runRequest(request);
        } catch (error: unknown) {
          if (!requestStarted) releasePending();
          throw error;
        }
      });
      this.tail = operation.catch(() => undefined);
      return this.observeQueuedCancellation(
        operation,
        request.signal,
        cancelQueuedRequest,
      );
    }

    const operation = this.tail.then(() => {
      if (queuedRequestCancelled()) return false;
      requestStarted = true;
      logger.debug(
        { listenerKey: request.listenerKey },
        'Lancement immédiat de la réconciliation canonique.',
      );
      return this.runRequest(request);
    });
    const execution = operation.then(() => undefined);
    const queued = operation.then(async (reorgDetected) => {
      if (!reorgDetected) return;
      try {
        await this.finalizePendingReorg();
      } catch (error: unknown) {
        if (this.status.state === 'HEALTHY') {
          this.status = {
            ...this.status,
            state: 'RECONCILING',
            lastReorg: this.status.lastReorg === null
              ? null
              : { ...this.status.lastReorg, status: 'RECONCILING' },
          };
        }
        logger.error(
          { errorType: safeErrorType(error) },
          'Finalisation post-reorg échouée.',
        );
        throw error;
      }
    });
    this.tail = queued.catch(() => undefined);
    return this.observeQueuedCancellation(
      execution,
      request.signal,
      cancelQueuedRequest,
    );
  }

  private observeQueuedCancellation(
    operation: Promise<void>,
    signal: AbortSignal | undefined,
    cancel: () => boolean,
  ): Promise<void> {
    if (!signal) return operation;
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        if (cancel()) resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
      operation.then(
        () => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  private async finalizePendingReorg(): Promise<void> {
    if (!this.reorgReadyForFinalization) {
      throw new Error('Rollback shallow incomplet: finalisation post-reorg indisponible.');
    }
    const completion = await this.runPostReorg();
    await this.onRecovered?.();
    this.promoteRecoveredReorg(completion);
  }

  waitForIdle(): Promise<void> {
    return this.tail;
  }

  private async runRequest(
    request: ConfirmedRangeRequest,
  ): Promise<boolean> {
    logger.debug(
      {
        listenerKey: request.listenerKey,
        activeRequests: this.activeRequests + 1,
      },
      'Démarrage d’une requête runRequest.',
    );
    this.activeRequests += 1;
    this.status = { ...this.status, running: true };
    try {
      return await this.execute(request);
    } finally {
      this.activeRequests -= 1;
      this.status = {
        ...this.status,
        running: this.activeRequests > 0,
        pendingRequests: this.status.pendingRequests - 1,
      };
      logger.debug(
        {
          listenerKey: request.listenerKey,
          activeRequests: this.activeRequests,
          running: this.status.running,
        },
        'runRequest terminée.',
      );
    }
  }

  private async runPostReorg(): Promise<CanonicalReorgCompletion | undefined> {
    const afterReorg = this.afterReorg;
    const scope: PostReorgScope = {
      active: true,
      reorgDetected: false,
      inFlight: new Set(),
      hasError: false,
      firstError: undefined,
    };
    let completion: CanonicalReorgCompletion | undefined;
    try {
      await this.postReorgScopes.run(scope, async () => {
        do {
          scope.reorgDetected = false;
          if (afterReorg) {
            try {
              const result = await afterReorg(this.status.state);
              if (result !== undefined) completion = result;
            } catch (error: unknown) {
              if (!scope.hasError) {
                scope.hasError = true;
                scope.firstError = error;
              }
            }
          }
          while (scope.inFlight.size > 0) {
            await Promise.all([...scope.inFlight]);
          }
          if (scope.hasError) throw scope.firstError;
          if (
            !scope.reorgDetected
            && this.hydratedReorgs.length > 1
            && (completion !== undefined || afterReorg === undefined)
          ) {
            this.promoteRecoveredReorg(completion);
            const next = this.hydratedReorgs[0];
            if (!next) {
              throw new Error('Cascade de rollbacks hydratés incohérente.');
            }
            this.installHydratedReorg(next);
            completion = undefined;
            scope.reorgDetected = true;
          }
        } while (scope.reorgDetected);
      });
      return completion;
    } finally {
      scope.active = false;
    }
  }

  private async execute(request: ConfirmedRangeRequest): Promise<boolean> {
    const inPostReorgScope = this.postReorgScopes.getStore()?.active === true;
    logger.debug(
      {
        listenerKey: request.listenerKey,
        inPostReorgScope,
        state: this.status.state,
      },
      'Entrée execute() canonique.',
    );
    if (
      this.status.state !== 'HEALTHY'
      && !(this.status.state === 'RECONCILING' && inPostReorgScope)
    ) {
      logger.debug(
        {
          listenerKey: request.listenerKey,
          state: this.status.state,
        },
        'Execution canonique ignorée pour état incompatible.',
      );
      return false;
    }
    if (
      request.bootstrap !== undefined
      && request.bootstrap !== 'confirmed-head'
    ) {
      throw new Error(
        `Mode de bootstrap listener invalide: ${String(request.bootstrap)}.`,
      );
    }

    const latestBlock = await this.blockReader.getBlockNumber();
    const head = confirmedHead(latestBlock, this.confirmations);
    logger.debug(
      {
        listenerKey: request.listenerKey,
        latestBlock: latestBlock.toString(),
        head: head === null ? null : head.toString(),
      },
      'Tête confirmée calculée.',
    );
    if (head === null) return false;
    if (this.cutoff !== null && head < this.cutoff.number) return false;

    const storedTip = await this.canonicalStore.getCanonicalTip();
    const tip =
      this.cutoff !== null
      && storedTip !== null
      && storedTip.number < this.cutoff.number
        ? null
        : storedTip;
    if (tip && tip.number > head) return false;

    const storedCheckpoint = request.ignoreStoredCheckpoint
      ? null
      : await this.checkpoints.get(request.listenerKey);
    const checkpoint = request.checkpoint ?? storedCheckpoint;
    const availableCheckpoint = checkpoint ?? storedCheckpoint;
    const needsCutoffAnchor =
      this.cutoff !== null
      && availableCheckpoint !== null
      && (
        availableCheckpoint.blockNumber < this.cutoff.number
        || (
          availableCheckpoint.blockNumber === this.cutoff.number
          && (
            availableCheckpoint.blockHash === null
            || availableCheckpoint.blockHash.toLowerCase()
              !== this.cutoff.hash.toLowerCase()
          )
        )
      );
    const effectiveCheckpoint =
      needsCutoffAnchor && this.cutoff !== null
        ? {
            blockNumber: this.cutoff.number,
            blockHash: this.cutoff.hash,
          }
        : checkpoint;
    if (
      checkpoint?.blockHash === null
      && checkpoint.blockNumber > head
    ) {
      return false;
    }

    const [oldestCheckpointRaw, descendingRaw] = await Promise.all([
      this.checkpoints.getOldestBlockNumber(),
      this.canonicalStore.listCanonicalDescending(
        DEFAULT_CANONICAL_RETENTION,
      ),
    ]);
    const oldestCheckpointBefore =
      this.cutoff !== null
      && (
        oldestCheckpointRaw === null
        || oldestCheckpointRaw < this.cutoff.number
      )
        ? this.cutoff.number
        : oldestCheckpointRaw;
    const descending = this.cutoff === null
      ? descendingRaw
      : descendingRaw.filter(
          ({ number }) => number >= this.cutoff!.number,
        );
    if (tip) {
      const remoteTip = validateHeader(
        await this.blockReader.getBlock(tip.number),
        tip.number,
      );
      if (remoteTip.hash.toLowerCase() !== tip.hash.toLowerCase()) {
        await this.reconcileDivergence(tip, remoteTip, descending, head);
        return true;
      }
    }
    const knownHeaders = new Map<bigint, CanonicalBlock>();
    for (const header of descending) {
      knownHeaders.set(
        header.number,
        validateHeader(header, header.number),
      );
    }
    if (tip) {
      knownHeaders.set(tip.number, validateHeader(tip, tip.number));
    }

    const requestedFromBlock = effectiveCheckpoint
      ? effectiveCheckpoint.blockNumber + 1n
      : request.bootstrap === 'confirmed-head'
        ? head
        : request.startBlock;
    const fromBlock = this.cutoff === null
      ? requestedFromBlock
      : requestedFromBlock > this.cutoff.number
        ? requestedFromBlock
        : this.cutoff.number + 1n;
    const windowStart = this.canonicalWindowStart(head);
    const requestedJournalStart =
      oldestCheckpointBefore !== null && oldestCheckpointBefore < windowStart
        ? oldestCheckpointBefore
        : windowStart;
    const journalStart =
      this.cutoff !== null && requestedJournalStart < this.cutoff.number
        ? this.cutoff.number
        : requestedJournalStart;
    const journalNeedsPersistence = !this.hasContinuousCachedJournal(
      knownHeaders,
      journalStart,
      head,
    );
    const spools: CanonicalHeaderSpool[] = [];
    try {
      const chunkHeaders = await this.headerSpoolFactory.create();
      spools.push(chunkHeaders);
      const journalHeaders = await this.headerSpoolFactory.create();
      spools.push(journalHeaders);
      const prepared = await this.prepareCanonicalScan(
        effectiveCheckpoint,
        tip,
        knownHeaders,
        fromBlock,
        head,
        chunkHeaders,
        journalHeaders,
        journalStart,
        journalNeedsPersistence,
      );
      await Promise.all([
        chunkHeaders.finish(),
        journalHeaders.finish(),
      ]);
      await this.validateSpools(chunkHeaders, journalHeaders);
      const saved = journalNeedsPersistence
        ? await this.persistJournal(journalHeaders)
        : false;
      let checkpointPersisted = false;
      if (
        effectiveCheckpoint?.blockHash === null
        && effectiveCheckpoint.blockNumber <= head
      ) {
        const legacyHeader = prepared.legacyHeader;
        if (!legacyHeader) {
          throw new Error(
            `Header legacy préparé absent pour le bloc ${effectiveCheckpoint.blockNumber}.`,
          );
        }
        if (request.persistCheckpoint !== false) {
          await this.setCheckpoint(request.listenerKey, {
            blockNumber: effectiveCheckpoint.blockNumber,
            blockHash: legacyHeader.hash,
          });
          checkpointPersisted = true;
        }
      }

      let chunkStart = fromBlock;
      let preparedChunk: CanonicalBlock[] = [];
      let chunkAttempted = false;
      for await (const header of chunkHeaders.headers()) {
        preparedChunk.push(header);
        if (
          preparedChunk.length < Number(this.chunkSize)
          && header.number !== head
        ) {
          continue;
        }
        const canonicalHeaders = preparedChunk;
        preparedChunk = [];
        if (
          this.cutoff !== null
          && (
            chunkStart <= this.cutoff.number
            || canonicalHeaders.some(
              ({ number }) => number <= this.cutoff!.number,
            )
          )
        ) {
          throw new FreshStartBoundaryError();
        }
        const processChunk = () =>
          request.processChunk(chunkStart, header.number, canonicalHeaders);
        chunkAttempted = true;
        const processed = this.runtimeBarrier
          ? await this.runtimeBarrier.runListener(processChunk)
          : await processChunk();
        if (!processed) break;
        if (request.persistCheckpoint !== false) {
          await this.setCheckpoint(request.listenerKey, {
            blockNumber: header.number,
            blockHash: header.hash,
          });
          checkpointPersisted = true;
        }
        chunkStart = header.number + 1n;
      }
      if (
        needsCutoffAnchor
        && this.cutoff !== null
        && !chunkAttempted
      ) {
        await this.setCheckpoint(request.listenerKey, {
          blockNumber: this.cutoff.number,
          blockHash: this.cutoff.hash,
        });
        checkpointPersisted = true;
      }

      if (saved || checkpointPersisted) {
        const oldestCheckpoint = await this.checkpoints.getOldestBlockNumber();
        const retentionCutoff =
          oldestCheckpoint === null || windowStart < oldestCheckpoint
            ? windowStart
            : oldestCheckpoint;
        const pruneBefore =
          this.cutoff !== null && retentionCutoff < this.cutoff.number
            ? this.cutoff.number
            : retentionCutoff;
        await this.canonicalStore.pruneCanonicalBefore(pruneBefore);
      }
    } finally {
      await this.disposeSpools(spools);
    }
    return false;
  }

  private async reconcileDivergence(
    oldTip: CanonicalBlock,
    remoteOldTip: CanonicalBlock,
    descending: CanonicalBlock[],
    head: bigint,
  ): Promise<void> {
    logger.warn(
      {
        oldTip: oldTip.number.toString(),
        remoteTip: remoteOldTip.hash,
        descendingCount: descending.length,
        head: head.toString(),
      },
      'Divergence canonique détectée; démarrage reorg.',
    );
    const validatedWindow = this.validateDescendingWindow(oldTip, descending);
    const window = this.cutoff === null
      ? validatedWindow
      : validatedWindow.filter(
          ({ number }) => number >= this.cutoff!.number,
        );
    const newTip = validateHeader(
      await this.blockReader.getBlock(head),
      head,
    );
    let newerRemote: CanonicalBlock | null = null;
    let ancestor: CanonicalBlock | null = null;
    for (const stored of window) {
      const remote =
        stored.number === oldTip.number
          ? remoteOldTip
          : validateHeader(
              await this.blockReader.getBlock(stored.number),
              stored.number,
            );
      if (newerRemote) {
        assertContinuous(remote, newerRemote);
      }
      if (remote.hash.toLowerCase() === stored.hash.toLowerCase()) {
        ancestor = stored;
        break;
      }
      newerRemote = remote;
    }
    const verifiedNewTip = validateHeader(
      await this.blockReader.getBlock(head),
      head,
    );
    if (!sameHeader(newTip, verifiedNewTip)) {
      throw new CanonicalChainContinuityError(
        `Le tip RPC ${head} a changé pendant la recherche d’ancêtre.`,
      );
    }

    const depth = ancestor
      ? this.reorgDepth(oldTip.number - ancestor.number)
      : null;
    const reorg: ReorgReconciliation = {
      ancestor,
      oldTip,
      newTip,
      depth,
    };
    logger.debug(
      {
        oldTip: oldTip.number.toString(),
        newTip: newTip.number.toString(),
        ancestor: ancestor?.number.toString() ?? null,
        depth,
      },
      'Reconciliation de divergence préparée.',
    );
    const detectedAtMs = Date.now();
    this.reorgReadyForFinalization = false;
    this.status = {
      ...this.status,
      state: 'RECONCILING',
      lastReorg: {
        ...cloneReconciliation(reorg),
        detectedAtMs,
        status: 'RECONCILING',
        impact: { depth, orphanedEvents: 0, replayedEvents: 0 },
      },
    };
    try {
      const handlerImpact = await this.reorgHandler.reconcileReorg(
        cloneReconciliation(reorg),
      );
      const crossedFreshStartBoundary =
        ancestor === null && this.cutoff !== null;
      const impact = crossedFreshStartBoundary
        ? { ...handlerImpact, requiresManualReview: true }
        : handlerImpact;
      const requiresManualReview = impact.requiresManualReview === true;
      const canRecoverAutomatically = ancestor && !requiresManualReview;
      this.status = {
        ...this.status,
        state: canRecoverAutomatically ? 'RECONCILING' : 'MANUAL_REVIEW',
        lastReorg: {
          ...cloneReconciliation(reorg),
          detectedAtMs,
          status: canRecoverAutomatically ? 'RECONCILING' : 'MANUAL_REVIEW',
          impact: cloneImpact(impact),
        },
      };
      this.reorgReadyForFinalization = Boolean(canRecoverAutomatically);
    } catch (error: unknown) {
      if (!ancestor) {
        this.status = {
          ...this.status,
          state: 'MANUAL_REVIEW',
          lastReorg: this.status.lastReorg
            ? { ...this.status.lastReorg, status: 'MANUAL_REVIEW' }
            : null,
        };
      }
      throw error;
    }
    if (!ancestor) {
      if (this.cutoff !== null) throw new FreshStartBoundaryError();
      throw new DeepReorgError();
    }
  }

  private async setCheckpoint(
    listenerKey: string,
    checkpoint: AnchoredListenerCheckpoint,
  ): Promise<void> {
    if (
      this.cutoff !== null
      && checkpoint.blockNumber < this.cutoff.number
    ) {
      throw new FreshStartBoundaryError();
    }
    await this.checkpoints.set(listenerKey, checkpoint);
  }

  private promoteRecoveredReorg(
    completion: CanonicalReorgCompletion | undefined,
  ): void {
    const lastReorg = this.status.lastReorg;
    if (
      this.status.state !== 'RECONCILING'
      || lastReorg === null
      || lastReorg.status !== 'RECONCILING'
    ) return;
    const expectedIdentity = this.reorgIdentity(lastReorg);
    const hydrated = this.hydratedReorgs[0];
    const finalized = completion ?? (
      this.afterReorg === undefined
        ? {
            identity: expectedIdentity,
            reorgId: `runtime:${expectedIdentity}`,
            replayedEvents: lastReorg.impact.replayedEvents,
          }
        : null
    );
    if (
      finalized === null
      || finalized.identity !== expectedIdentity
      || (
        hydrated !== undefined
        && finalized.reorgId !== hydrated.reorgId
      )
      || finalized.reorgId.length === 0
      || !Number.isSafeInteger(finalized.replayedEvents)
      || finalized.replayedEvents < 0
    ) {
      throw new Error('Finalisation post-reorg incompatible avec le fork courant.');
    }
    this.status = {
      ...this.status,
      state: 'HEALTHY',
      lastReorg: {
        ...lastReorg,
        status: 'RECOVERED',
        impact: {
          ...lastReorg.impact,
          replayedEvents: finalized.replayedEvents,
        },
      },
    };
    if (hydrated !== undefined) this.hydratedReorgs.shift();
    this.reorgReadyForFinalization = false;
  }

  private reorgIdentity(reorg: ReorgReconciliation): string {
    return `${reorg.oldTip.hash.toLowerCase()}:${reorg.newTip.hash.toLowerCase()}`;
  }

  private validateDescendingWindow(
    tip: CanonicalBlock,
    descending: CanonicalBlock[],
  ): CanonicalBlock[] {
    if (descending.length === 0) {
      throw new CanonicalChainContinuityError(
        'Fenêtre canonique vide malgré un tip stocké.',
      );
    }
    if (descending.length > DEFAULT_CANONICAL_RETENTION) {
      throw new CanonicalChainContinuityError(
        `Fenêtre canonique supérieure à ${DEFAULT_CANONICAL_RETENTION} blocs.`,
      );
    }
    const window = descending.map((header) =>
      validateHeader(header, header.number));
    if (!sameHeader(window[0] as CanonicalBlock, tip)) {
      throw new CanonicalChainContinuityError(
        'La fenêtre canonique ne commence pas au tip stocké.',
      );
    }
    for (let index = 1; index < window.length; index += 1) {
      const newer = window[index - 1] as CanonicalBlock;
      const older = window[index] as CanonicalBlock;
      if (
        newer.number !== older.number + 1n
        || newer.parentHash.toLowerCase() !== older.hash.toLowerCase()
      ) {
        throw new CanonicalChainContinuityError(
          `Fenêtre canonique discontinue entre les blocs ${newer.number} et ${older.number}.`,
        );
      }
    }
    return window;
  }

  private reorgDepth(value: bigint): number {
    if (
      value < 0n
      || value > BigInt(DEFAULT_CANONICAL_RETENTION)
      || value > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new CanonicalChainContinuityError(
        `Profondeur de reorg hors limite: ${value}.`,
      );
    }
    return Number(value);
  }

  private async prepareCanonicalScan(
    checkpoint: ListenerCheckpoint | null,
    tip: CanonicalBlock | null,
    knownHeaders: Map<bigint, CanonicalBlock>,
    fromBlock: bigint,
    head: bigint,
    chunkHeaders: CanonicalHeaderSpool,
    journalHeaders: CanonicalHeaderSpool,
    journalStart: bigint,
    journalNeedsPersistence: boolean,
  ): Promise<PreparedCanonicalScan> {
    const scanCandidates: bigint[] = [];
    if (journalNeedsPersistence) {
      scanCandidates.push(
        tip && tip.number < journalStart
          ? tip.number
          : journalStart,
      );
    }
    if (fromBlock <= head) {
      scanCandidates.push(
        checkpoint?.blockHash === null
          ? checkpoint.blockNumber
          : fromBlock,
      );
    }
    const scanStart = minimum(scanCandidates);
    if (scanStart === null) {
      logger.debug(
        { checkpoint: checkpoint?.blockNumber?.toString() ?? null },
        'Aucun scan canonique à préparer.',
      );
      return {
        legacyHeader: null,
      };
    }

    let previous: CanonicalBlock | null =
      tip && scanStart === tip.number + 1n
        ? tip
        : checkpoint?.blockHash !== null
          && checkpoint !== null
          && scanStart === checkpoint.blockNumber + 1n
          ? {
              number: checkpoint.blockNumber,
              hash: checkpoint.blockHash,
              parentHash: checkpoint.blockHash,
            }
          : null;
    let legacyHeader: CanonicalBlock | null = null;

    for (let number = scanStart; number <= head; number += 1n) {
      const stored = knownHeaders.get(number);
      const header = validateHeader(
        await this.blockReader.getBlock(number),
        number,
      );
      if (stored && !sameHeader(stored, header)) {
        throw new CanonicalChainContinuityError(
          `Header canonique divergent au bloc ${number}.`,
        );
      }
      if (previous) assertContinuous(previous, header);
      if (
        checkpoint?.blockHash !== null
        && checkpoint !== null
        && number === checkpoint.blockNumber
        && header.hash.toLowerCase() !== checkpoint.blockHash.toLowerCase()
      ) {
        throw new CanonicalChainContinuityError(
          `Checkpoint divergent au bloc ${number}.`,
        );
      }
      if (journalNeedsPersistence && number >= journalStart) {
        await journalHeaders.append(header);
      }
      if (number >= fromBlock) {
        await chunkHeaders.append(header);
      }
      if (checkpoint?.blockHash === null && number === checkpoint.blockNumber) {
        legacyHeader = header;
      }
      previous = header;
    }
    logger.debug(
      {
        checkpoint: checkpoint?.blockNumber?.toString() ?? null,
        scanStart: scanStart.toString(),
        legacyHeader: legacyHeader === null ? null : legacyHeader.number.toString(),
      },
      'Préparation de scan canonique terminée.',
    );
    return { legacyHeader };
  }

  private hasContinuousCachedJournal(
    knownHeaders: Map<bigint, CanonicalBlock>,
    start: bigint,
    head: bigint,
  ): boolean {
    if (head - start + 1n > BigInt(DEFAULT_CANONICAL_RETENTION)) {
      return false;
    }
    let previous: CanonicalBlock | null = null;
    for (let number = start; number <= head; number += 1n) {
      const header = knownHeaders.get(number);
      if (!header) return false;
      if (previous) assertContinuous(previous, header);
      previous = header;
    }
    return true;
  }

  private async validateSpools(
    chunkHeaders: CanonicalHeaderSpool,
    journalHeaders: CanonicalHeaderSpool,
  ): Promise<void> {
    for await (const _header of chunkHeaders.headers()) {
      // Le parsing strict du spool est la validation attendue ici.
    }
    let previous: CanonicalBlock | null = null;
    for await (const header of journalHeaders.headers()) {
      if (previous) assertContinuous(previous, header);
      previous = header;
    }
  }

  private async persistJournal(
    journalHeaders: CanonicalHeaderSpool,
  ): Promise<boolean> {
    let saved = false;
    let batch: CanonicalBlock[] = [];
    for await (const header of journalHeaders.headers()) {
      batch.push(header);
      if (batch.length === DEFAULT_CANONICAL_RETENTION) {
        await this.canonicalStore.saveCanonicalBlocks(batch);
        saved = true;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await this.canonicalStore.saveCanonicalBlocks(batch);
      saved = true;
    }
    return saved;
  }

  private async disposeSpools(
    spools: CanonicalHeaderSpool[],
  ): Promise<void> {
    for (const spool of spools) {
      try {
        await spool.dispose();
      } catch (error: unknown) {
        const errorType = safeErrorType(error);
        try {
          if (this.onCleanupError) {
            this.onCleanupError(errorType);
          } else {
            logger.warn(
              { errorType },
              'Nettoyage du spool canonique échoué.',
            );
          }
        } catch {
          try {
            logger.warn(
              { errorType },
              'Rapport du nettoyage du spool canonique échoué.',
            );
          } catch {
            // Le cleanup reste strictement secondaire.
          }
        }
      }
    }
  }

  private canonicalWindowStart(head: bigint): bigint {
    const retainedDistance = BigInt(DEFAULT_CANONICAL_RETENTION - 1);
    return head > retainedDistance ? head - retainedDistance : 0n;
  }
}
