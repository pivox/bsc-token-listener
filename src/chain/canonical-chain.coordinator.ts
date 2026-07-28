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
  ConfirmedRangeRequest,
  ListenerCheckpoint,
} from './canonical-chain.types.js';
import { confirmedHead } from './confirmed-blocks.js';

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

export interface CanonicalChainCoordinatorOptions {
  blockReader: CanonicalBlockReader;
  canonicalStore: CanonicalChainStore;
  checkpoints: ListenerCheckpointStore;
  confirmations?: number;
  chunkSize?: number;
}

export interface CanonicalChainCoordinatorStatus {
  running: boolean;
  pendingRequests: number;
}

export class CanonicalChainContinuityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalChainContinuityError';
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
  journalHeaders: CanonicalBlock[];
  legacyHeader: CanonicalBlock | null;
}

class TemporaryChunkHeaderStore {
  private handle: FileHandle | null;

  private constructor(
    private readonly path: string,
    handle: FileHandle,
  ) {
    this.handle = handle;
  }

  static async create(): Promise<TemporaryChunkHeaderStore> {
    const path = join(
      tmpdir(),
      `bsc-canonical-chunks-${randomUUID()}.tmp`,
    );
    return new TemporaryChunkHeaderStore(
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
    await this.finish().catch(() => undefined);
    await unlink(this.path).catch((error: unknown) => {
      if (
        !(error instanceof Error)
        || !('code' in error)
        || error.code !== 'ENOENT'
      ) {
        throw error;
      }
    });
  }
}

export class CanonicalChainCoordinator {
  private readonly blockReader: CanonicalBlockReader;
  private readonly canonicalStore: CanonicalChainStore;
  private readonly checkpoints: ListenerCheckpointStore;
  private readonly confirmations: number;
  private readonly chunkSize: bigint;
  private tail: Promise<void> = Promise.resolve();
  private status: CanonicalChainCoordinatorStatus = {
    running: false,
    pendingRequests: 0,
  };

  constructor(options: CanonicalChainCoordinatorOptions) {
    this.blockReader = options.blockReader;
    this.canonicalStore = options.canonicalStore;
    this.checkpoints = options.checkpoints;
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
    const latestBlock = await this.blockReader.getBlockNumber();
    const head = confirmedHead(latestBlock, this.confirmations);
    if (head === null) return;

    const [checkpoint, tip, descending] = await Promise.all([
      this.checkpoints.get(request.listenerKey),
      this.canonicalStore.getCanonicalTip(),
      this.canonicalStore.listCanonicalDescending(
        DEFAULT_CANONICAL_RETENTION,
      ),
    ]);
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
    const chunkHeaders = await TemporaryChunkHeaderStore.create();
    try {
      const prepared = await this.prepareCanonicalScan(
        checkpoint,
        tip,
        knownHeaders,
        fromBlock,
        head,
        chunkHeaders,
      );
      await chunkHeaders.finish();
      const saved = prepared.journalHeaders.length > 0;
      if (saved) {
        await this.canonicalStore.saveCanonicalBlocks(
          prepared.journalHeaders,
        );
      }
      let checkpointPersisted = false;
      if (checkpoint?.blockHash === null) {
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
        const windowStart = this.canonicalWindowStart(head);
        const oldestCheckpoint = await this.checkpoints.getOldestBlockNumber();
        const cutoff =
          oldestCheckpoint === null || windowStart < oldestCheckpoint
            ? windowStart
            : oldestCheckpoint;
        await this.canonicalStore.pruneCanonicalBefore(cutoff);
      }
    } finally {
      await chunkHeaders.dispose();
    }
  }

  private async prepareCanonicalScan(
    checkpoint: ListenerCheckpoint | null,
    tip: CanonicalBlock | null,
    knownHeaders: Map<bigint, CanonicalBlock>,
    fromBlock: bigint,
    head: bigint,
    chunkHeaders: TemporaryChunkHeaderStore,
  ): Promise<PreparedCanonicalScan> {
    const scanCandidates: bigint[] = [];
    const journalNeedsExtension = !tip || tip.number < head;
    if (journalNeedsExtension) {
      scanCandidates.push(tip ? tip.number : this.canonicalWindowStart(head));
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
        journalHeaders: [],
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
    const journalHeaders: CanonicalBlock[] = [];
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
      if (
        journalNeedsExtension
        && (!tip || number > tip.number)
      ) {
        journalHeaders.push(header);
        if (journalHeaders.length > DEFAULT_CANONICAL_RETENTION) {
          journalHeaders.shift();
        }
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
    return { journalHeaders, legacyHeader };
  }

  private canonicalWindowStart(head: bigint): bigint {
    const retainedDistance = BigInt(DEFAULT_CANONICAL_RETENTION - 1);
    return head > retainedDistance ? head - retainedDistance : 0n;
  }
}
