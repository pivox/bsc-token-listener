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
  ConfirmedRangeRequest,
  ListenerCheckpoint,
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

export interface CanonicalChainCoordinatorOptions {
  blockReader: CanonicalBlockReader;
  canonicalStore: CanonicalChainStore;
  checkpoints: ListenerCheckpointStore;
  reorgHandler: CanonicalReorgHandler;
  confirmations?: number;
  chunkSize?: number;
  headerSpoolFactory?: CanonicalHeaderSpoolFactory;
  onCleanupError?: (errorType: string) => void;
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
  private readonly confirmations: number;
  private readonly chunkSize: bigint;
  private readonly headerSpoolFactory: CanonicalHeaderSpoolFactory;
  private readonly onCleanupError: ((errorType: string) => void) | undefined;
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
    this.headerSpoolFactory =
      options.headerSpoolFactory ?? DEFAULT_HEADER_SPOOL_FACTORY;
    this.onCleanupError = options.onCleanupError;
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
    return { ...this.status };
  }

  reconcile(request: ConfirmedRangeRequest): Promise<void> {
    this.status = {
      ...this.status,
      pendingRequests: this.status.pendingRequests + 1,
    };
    const execution = this.tail.then(async () => {
      this.status = { ...this.status, running: true };
      try {
        await this.execute(request);
      } finally {
        this.status = {
          ...this.status,
          running: false,
          pendingRequests: this.status.pendingRequests - 1,
        };
      }
    });
    this.tail = execution.catch(() => undefined);
    return execution;
  }

  waitForIdle(): Promise<void> {
    return this.tail;
  }

  private async execute(request: ConfirmedRangeRequest): Promise<void> {
    if (this.status.state === 'MANUAL_REVIEW') return;

    const latestBlock = await this.blockReader.getBlockNumber();
    const head = confirmedHead(latestBlock, this.confirmations);
    if (head === null) return;

    const tip = await this.canonicalStore.getCanonicalTip();
    if (tip && tip.number > head) return;

    const checkpoint = await this.checkpoints.get(request.listenerKey);
    if (
      checkpoint?.blockHash === null
      && checkpoint.blockNumber > head
    ) {
      return;
    }

    const [oldestCheckpointBefore, descending] = await Promise.all([
      this.checkpoints.getOldestBlockNumber(),
      this.canonicalStore.listCanonicalDescending(
        DEFAULT_CANONICAL_RETENTION,
      ),
    ]);
    if (tip) {
      const remoteTip = validateHeader(
        await this.blockReader.getBlock(tip.number),
        tip.number,
      );
      if (remoteTip.hash.toLowerCase() !== tip.hash.toLowerCase()) {
        await this.reconcileDivergence(tip, remoteTip, descending, head);
        return;
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

    const fromBlock = checkpoint
      ? checkpoint.blockNumber + 1n
      : request.startBlock;
    const windowStart = this.canonicalWindowStart(head);
    const journalStart =
      oldestCheckpointBefore !== null && oldestCheckpointBefore < windowStart
        ? oldestCheckpointBefore
        : windowStart;
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
        checkpoint,
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
        checkpoint?.blockHash === null
        && checkpoint.blockNumber <= head
      ) {
        const legacyHeader = prepared.legacyHeader;
        if (!legacyHeader) {
          throw new Error(
            `Header legacy préparé absent pour le bloc ${checkpoint.blockNumber}.`,
          );
        }
        await this.checkpoints.set(request.listenerKey, {
          blockNumber: checkpoint.blockNumber,
          blockHash: legacyHeader.hash,
        });
        checkpointPersisted = true;
      }

      let chunkStart = fromBlock;
      for await (const header of chunkHeaders.headers()) {
        const processed = await request.processChunk(
          chunkStart,
          header.number,
        );
        if (!processed) break;
        await this.checkpoints.set(request.listenerKey, {
          blockNumber: header.number,
          blockHash: header.hash,
        });
        checkpointPersisted = true;
        chunkStart = header.number + 1n;
      }

      if (saved || checkpointPersisted) {
        const oldestCheckpoint = await this.checkpoints.getOldestBlockNumber();
        const cutoff =
          oldestCheckpoint === null || windowStart < oldestCheckpoint
            ? windowStart
            : oldestCheckpoint;
        await this.canonicalStore.pruneCanonicalBefore(cutoff);
      }
    } finally {
      await this.disposeSpools(spools);
    }
  }

  private async reconcileDivergence(
    oldTip: CanonicalBlock,
    remoteOldTip: CanonicalBlock,
    descending: CanonicalBlock[],
    head: bigint,
  ): Promise<void> {
    const window = this.validateDescendingWindow(oldTip, descending);
    const newTip =
      head === oldTip.number
        ? remoteOldTip
        : validateHeader(await this.blockReader.getBlock(head), head);
    const remoteHeaders = new Map<bigint, CanonicalBlock>([
      [oldTip.number, remoteOldTip],
      [head, newTip],
    ]);
    let newerRemote = newTip;
    for (
      let number = head - 1n;
      number >= oldTip.number;
      number -= 1n
    ) {
      const remote =
        number === oldTip.number
          ? remoteOldTip
          : validateHeader(
              await this.blockReader.getBlock(number),
              number,
            );
      assertContinuous(remote, newerRemote);
      remoteHeaders.set(number, remote);
      newerRemote = remote;
    }
    let ancestor: CanonicalBlock | null = null;
    for (const stored of window) {
      const remote =
        remoteHeaders.get(stored.number)
        ?? validateHeader(
              await this.blockReader.getBlock(stored.number),
              stored.number,
            );
      if (stored.number < oldTip.number) {
        assertContinuous(remote, newerRemote);
      }
      if (remote.hash.toLowerCase() === stored.hash.toLowerCase()) {
        ancestor = stored;
        break;
      }
      newerRemote = remote;
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
    this.status = { ...this.status, state: 'RECONCILING' };
    try {
      const impact = await this.reorgHandler.reconcileReorg(reorg);
      this.status = {
        ...this.status,
        state: ancestor ? 'HEALTHY' : 'MANUAL_REVIEW',
        lastReorg: { ...reorg, impact },
      };
    } catch (error: unknown) {
      if (!ancestor) {
        this.status = { ...this.status, state: 'MANUAL_REVIEW' };
      }
      throw error;
    }
    if (!ancestor) throw new DeepReorgError();
  }

  private validateDescendingWindow(
    tip: CanonicalBlock,
    descending: CanonicalBlock[],
  ): CanonicalBlock[] {
    if (descending.length === 0) {
      return [validateHeader(tip, tip.number)];
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
      if (
        number >= fromBlock
        && (
          (number - fromBlock + 1n) % this.chunkSize === 0n
          || number === head
        )
      ) {
        await chunkHeaders.append(header);
      }
      if (checkpoint?.blockHash === null && number === checkpoint.blockNumber) {
        legacyHeader = header;
      }
      previous = header;
    }
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
