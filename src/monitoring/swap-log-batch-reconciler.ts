import {
  isAddress,
  isHash,
  type Address,
  type Hash,
} from 'viem';
import { pancakePairAbi } from '../abi/pancake-pair.abi.js';
import type {
  AnchoredListenerCheckpoint,
  CanonicalBlock,
  ConfirmedRangeRequest,
  ListenerCheckpoint,
} from '../chain/canonical-chain.types.js';

export interface SwapLogBatchTarget {
  readonly pair: Address;
  readonly pairKey: string;
  readonly createdBlock: bigint;
  isReconcileCapable(): boolean;
  reconcileChunk(
    fromBlock: bigint,
    toBlock: bigint,
    canonicalHeaders: readonly CanonicalBlock[],
    logs: readonly unknown[],
  ): Promise<boolean>;
}

interface SwapBatchCoordinator {
  reconcile(request: ConfirmedRangeRequest): Promise<void>;
}

interface SwapBatchCheckpointStore {
  getMany(keys: readonly string[]): Promise<Map<string, ListenerCheckpoint>>;
  setManyAtomically(
    writes: readonly {
      key: string;
      checkpoint: AnchoredListenerCheckpoint;
    }[],
  ): Promise<void>;
}

interface SwapBatchLogReader {
  getContractEvents(options: {
    address: Address[];
    abi: readonly unknown[];
    eventName: 'Swap';
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly unknown[]>;
}

export interface SwapLogBatchReconcilerOptions {
  coordinator: SwapBatchCoordinator;
  checkpoints: SwapBatchCheckpointStore;
  logReader: SwapBatchLogReader;
  maxAddressesPerBatch: number;
}

interface SnapshotEntry {
  readonly target: SwapLogBatchTarget;
  readonly address: Address;
  readonly addressKey: string;
  readonly checkpoint: ListenerCheckpoint | null;
  nextBlock: bigint;
}

interface IdentifiedSwapLog {
  readonly raw: unknown;
  readonly addressKey: string;
  readonly blockNumber: bigint;
  readonly blockHash: Hash;
  readonly transactionHash: Hash;
  readonly transactionIndex: number;
  readonly logIndex: number;
  readonly fingerprint: string;
}

function partition<T>(values: readonly T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size));
  }
  return batches;
}

function assertIndex(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`Log Swap groupé invalide: ${field} absent.`);
  }
}

function identifyLog(
  raw: unknown,
  fromBlock: bigint,
  toBlock: bigint,
  expectedHashes: ReadonlyMap<bigint, string>,
  snapshotByAddress: ReadonlyMap<string, SnapshotEntry>,
): IdentifiedSwapLog {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Log Swap groupé invalide: réponse RPC mal formée.');
  }
  const log = raw as {
    address?: unknown;
    args?: Record<string, unknown>;
    blockNumber?: unknown;
    blockHash?: unknown;
    transactionHash?: unknown;
    transactionIndex?: unknown;
    logIndex?: unknown;
  };
  if (typeof log.address !== 'string' || !isAddress(log.address)) {
    throw new Error('Log Swap groupé invalide: address absent.');
  }
  const addressKey = log.address.toLowerCase();
  if (!snapshotByAddress.has(addressKey)) {
    throw new Error(`Log Swap groupé reçu pour une adresse inconnue: ${addressKey}.`);
  }
  if (typeof log.blockNumber !== 'bigint') {
    throw new Error('Log Swap groupé invalide: blockNumber absent.');
  }
  if (log.blockNumber < fromBlock || log.blockNumber > toBlock) {
    throw new Error(`Log Swap groupé hors plage confirmée: ${log.blockNumber}.`);
  }
  if (typeof log.blockHash !== 'string' || !isHash(log.blockHash)) {
    throw new Error('Log Swap groupé invalide: blockHash absent.');
  }
  if (expectedHashes.get(log.blockNumber) !== log.blockHash.toLowerCase()) {
    throw new Error(
      `Log Swap groupé incohérent avec le header canonique au bloc ${log.blockNumber}.`,
    );
  }
  if (typeof log.transactionHash !== 'string' || !isHash(log.transactionHash)) {
    throw new Error('Log Swap groupé invalide: transactionHash absent.');
  }
  assertIndex(log.transactionIndex, 'transactionIndex');
  assertIndex(log.logIndex, 'logIndex');
  const args = log.args ?? {};
  const fingerprint = [
    addressKey,
    log.blockNumber.toString(),
    log.blockHash.toLowerCase(),
    log.transactionHash.toLowerCase(),
    String(log.transactionIndex),
    String(log.logIndex),
    String(args.sender ?? ''),
    String(args.to ?? ''),
    String(args.amount0In ?? ''),
    String(args.amount1In ?? ''),
    String(args.amount0Out ?? ''),
    String(args.amount1Out ?? ''),
  ].join(':');
  return {
    raw,
    addressKey,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    transactionHash: log.transactionHash,
    transactionIndex: log.transactionIndex,
    logIndex: log.logIndex,
    fingerprint,
  };
}

function selectAggregateCheckpoint(
  entries: readonly SnapshotEntry[],
  firstBlock: bigint,
): ListenerCheckpoint | undefined {
  const candidates = entries
    .filter((entry) =>
      entry.nextBlock === firstBlock
      && entry.checkpoint !== null
      && entry.checkpoint.blockNumber + 1n === firstBlock)
    .map((entry) => entry.checkpoint as ListenerCheckpoint);
  const anchored = candidates.filter(
    (checkpoint): checkpoint is AnchoredListenerCheckpoint =>
      checkpoint.blockHash !== null,
  );
  const first = anchored[0] ?? candidates[0];
  if (!first) return undefined;
  for (const checkpoint of anchored.slice(1)) {
    if (checkpoint.blockHash.toLowerCase() !== anchored[0]?.blockHash.toLowerCase()) {
      throw new Error(`Checkpoints Swap incohérents au bloc ${firstBlock - 1n}.`);
    }
  }
  return structuredClone(first);
}

export class SwapLogBatchReconciler {
  private readonly options: SwapLogBatchReconcilerOptions;

  constructor(options: SwapLogBatchReconcilerOptions) {
    if (
      !Number.isSafeInteger(options.maxAddressesPerBatch)
      || options.maxAddressesPerBatch < 1
    ) {
      throw new Error('maxAddressesPerBatch doit être un entier positif.');
    }
    this.options = options;
  }

  async reconcile(targets: readonly SwapLogBatchTarget[]): Promise<void> {
    const targetSnapshot = [...targets].filter((target) =>
      target.isReconcileCapable());
    if (targetSnapshot.length === 0) return;

    const targetByAddress = new Map<string, SwapLogBatchTarget>();
    const listenerKeys = new Set<string>();
    for (const target of targetSnapshot) {
      const addressKey = target.pair.toLowerCase();
      if (targetByAddress.has(addressKey) || listenerKeys.has(target.pairKey)) {
        throw new Error(`Listener Swap dupliqué dans le snapshot: ${addressKey}.`);
      }
      targetByAddress.set(addressKey, target);
      listenerKeys.add(target.pairKey);
    }

    const checkpoints = await this.options.checkpoints.getMany(
      targetSnapshot.map((target) => target.pairKey),
    );
    const entries = targetSnapshot.map<SnapshotEntry>((target) => {
      const checkpoint = checkpoints.get(target.pairKey) ?? null;
      return {
        target,
        address: target.pair,
        addressKey: target.pair.toLowerCase(),
        checkpoint,
        nextBlock: checkpoint
          ? checkpoint.blockNumber + 1n
          : target.createdBlock,
      };
    });
    const firstBlock = entries.reduce(
      (minimum, entry) => entry.nextBlock < minimum ? entry.nextBlock : minimum,
      entries[0]!.nextBlock,
    );
    const aggregateCheckpoint = selectAggregateCheckpoint(entries, firstBlock);

    await this.options.coordinator.reconcile({
      listenerKey: 'swap-batch',
      startBlock: firstBlock,
      ...(aggregateCheckpoint ? { checkpoint: aggregateCheckpoint } : {}),
      ignoreStoredCheckpoint: true,
      persistCheckpoint: false,
      processChunk: (fromBlock, toBlock, canonicalHeaders) =>
        this.processChunk(entries, fromBlock, toBlock, canonicalHeaders),
    });
  }

  private async processChunk(
    entries: SnapshotEntry[],
    fromBlock: bigint,
    toBlock: bigint,
    canonicalHeaders: readonly CanonicalBlock[],
  ): Promise<boolean> {
    const concerned = entries.filter((entry) => entry.nextBlock <= toBlock);
    if (concerned.length === 0) return true;
    for (const entry of concerned) this.assertActive(entry);

    const addressBatches = partition(
      concerned.map((entry) => entry.address),
      this.options.maxAddressesPerBatch,
    );
    const reads = await Promise.allSettled(
      addressBatches.map((address) =>
        this.options.logReader.getContractEvents({
          address,
          abi: pancakePairAbi,
          eventName: 'Swap',
          fromBlock,
          toBlock,
        })),
    );
    const failed = reads.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failed) throw failed.reason;

    const expectedHashes = new Map(
      canonicalHeaders.map((header) => [
        header.number,
        header.hash.toLowerCase(),
      ]),
    );
    const snapshotByAddress = new Map(
      entries.map((entry) => [entry.addressKey, entry]),
    );
    const seen = new Map<string, string>();
    const identified: IdentifiedSwapLog[] = [];
    for (const result of reads) {
      if (result.status !== 'fulfilled') continue;
      for (const raw of result.value) {
        const log = identifyLog(
          raw,
          fromBlock,
          toBlock,
          expectedHashes,
          snapshotByAddress,
        );
        const identity = `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
        const previous = seen.get(identity);
        if (previous !== undefined) {
          if (previous !== log.fingerprint) {
            throw new Error(`Log Swap dupliqué avec contenu incohérent: ${identity}.`);
          }
          continue;
        }
        seen.set(identity, log.fingerprint);
        identified.push(log);
      }
    }
    identified.sort((left, right) => {
      if (left.blockNumber !== right.blockNumber) {
        return left.blockNumber < right.blockNumber ? -1 : 1;
      }
      if (left.transactionIndex !== right.transactionIndex) {
        return left.transactionIndex - right.transactionIndex;
      }
      return left.logIndex - right.logIndex;
    });

    for (const log of identified) {
      const entry = snapshotByAddress.get(log.addressKey);
      if (!entry) {
        throw new Error(`Log Swap groupé reçu pour une adresse inconnue: ${log.addressKey}.`);
      }
      if (log.blockNumber < entry.nextBlock) continue;
      this.assertActive(entry);
      const processed = await entry.target.reconcileChunk(
        fromBlock,
        toBlock,
        canonicalHeaders,
        [log.raw],
      );
      if (!processed) {
        throw new Error(`Paire Swap arrêtée pendant le chunk: ${entry.addressKey}.`);
      }
    }

    for (const entry of concerned) this.assertActive(entry);
    const finalHeader = canonicalHeaders.at(-1);
    if (!finalHeader || finalHeader.number !== toBlock) {
      throw new Error(`Headers canoniques incomplets pour le chunk terminé à ${toBlock}.`);
    }
    await this.options.checkpoints.setManyAtomically(
      concerned.map((entry) => ({
        key: entry.target.pairKey,
        checkpoint: {
          blockNumber: toBlock,
          blockHash: finalHeader.hash,
        },
      })),
    );
    for (const entry of concerned) entry.nextBlock = toBlock + 1n;
    return true;
  }

  private assertActive(entry: SnapshotEntry): void {
    if (!entry.target.isReconcileCapable()) {
      throw new Error(
        `Paire Swap retirée ou arrêtée pendant le chunk: ${entry.addressKey}.`,
      );
    }
  }
}
