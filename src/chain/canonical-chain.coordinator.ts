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
}

export interface ListenerCheckpointStore {
  get(listenerKey: string): Promise<ListenerCheckpoint | null>;
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

    const newHeaders = await this.readCanonicalExtension(tip, head);
    for (const header of newHeaders) knownHeaders.set(header.number, header);

    let legacyAnchor: AnchoredListenerCheckpoint | null = null;
    if (checkpoint?.blockHash === null) {
      const header = await this.readHeader(checkpoint.blockNumber, knownHeaders);
      legacyAnchor = {
        blockNumber: checkpoint.blockNumber,
        blockHash: header.hash,
      };
    }

    const fromBlock = checkpoint
      ? checkpoint.blockNumber + 1n
      : request.startBlock;
    const chunkEnds: bigint[] = [];
    if (fromBlock <= head) {
      for (
        let chunkStart = fromBlock;
        chunkStart <= head;
        chunkStart += this.chunkSize
      ) {
        const candidate = chunkStart + this.chunkSize - 1n;
        chunkEnds.push(candidate < head ? candidate : head);
      }
    }
    for (const chunkEnd of chunkEnds) {
      await this.readHeader(chunkEnd, knownHeaders);
    }

    if (newHeaders.length > 0) {
      await this.canonicalStore.saveCanonicalBlocks(newHeaders);
    }
    if (legacyAnchor) {
      await this.checkpoints.set(request.listenerKey, legacyAnchor);
    }

    let chunkStart = fromBlock;
    for (const chunkEnd of chunkEnds) {
      const processed = await request.processChunk(chunkStart, chunkEnd);
      if (!processed) return;
      const header = knownHeaders.get(chunkEnd);
      if (!header) {
        throw new Error(`Header préparé absent pour le bloc ${chunkEnd}.`);
      }
      await this.checkpoints.set(request.listenerKey, {
        blockNumber: chunkEnd,
        blockHash: header.hash,
      });
      chunkStart = chunkEnd + 1n;
    }
  }

  private async readCanonicalExtension(
    tip: CanonicalBlock | null,
    head: bigint,
  ): Promise<CanonicalBlock[]> {
    if (tip && tip.number >= head) return [];
    const retention = BigInt(DEFAULT_CANONICAL_RETENTION);
    const firstBlock = tip
      ? tip.number + 1n
      : head >= retention
        ? head - retention + 1n
        : 0n;
    const headers: CanonicalBlock[] = [];
    for (let number = firstBlock; number <= head; number += 1n) {
      headers.push(
        validateHeader(await this.blockReader.getBlock(number), number),
      );
    }

    let previous = tip;
    for (const header of headers) {
      if (previous) assertContinuous(previous, header);
      previous = header;
    }
    return headers;
  }

  private async readHeader(
    number: bigint,
    knownHeaders: Map<bigint, CanonicalBlock>,
  ): Promise<CanonicalBlock> {
    const known = knownHeaders.get(number);
    if (known) return known;
    const header = validateHeader(
      await this.blockReader.getBlock(number),
      number,
    );
    knownHeaders.set(number, header);
    return header;
  }
}
