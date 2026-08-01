import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hash } from 'viem';
import {
  CanonicalChainContinuityError,
  CanonicalChainCoordinator,
  DeepReorgError,
  DEFAULT_CANONICAL_RETENTION,
} from '../src/chain/canonical-chain.coordinator.js';
import type {
  CanonicalChainCoordinatorOptions,
  CanonicalReorgHandler,
  ReorgReconciliation,
} from '../src/chain/canonical-chain.coordinator.js';
import type {
  CanonicalBlock,
  ListenerCheckpoint,
  ReorgImpact,
} from '../src/chain/canonical-chain.types.js';
import { scheduleMonitorReconcile } from '../src/monitoring/monitor-reconcile-request.js';
import { RuntimeRecoveryBarrier } from '../src/recovery/runtime-recovery-barrier.js';

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve = (_value: T | PromiseLike<T>): void => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function hash(number: bigint): Hash {
  return `0x${number.toString(16).padStart(64, '0')}` as Hash;
}

const ZERO_HASH = hash(0n);

function block(number: bigint): CanonicalBlock {
  return {
    number,
    hash: hash(number + 1n),
    parentHash: number === 0n ? ZERO_HASH : hash(number),
  };
}

class MemoryBlockReader {
  readonly reads: bigint[] = [];
  blockNumberReads = 0;
  failAt: bigint | null = null;

  constructor(readonly latest: bigint) {}

  async getBlockNumber(): Promise<bigint> {
    this.blockNumberReads += 1;
    return this.latest;
  }

  async getBlock(blockNumber: bigint): Promise<CanonicalBlock> {
    this.reads.push(blockNumber);
    if (blockNumber === this.failAt) {
      throw new Error(`RPC indisponible au bloc ${blockNumber}`);
    }
    return block(blockNumber);
  }
}

class MemoryReorgHandler implements CanonicalReorgHandler {
  readonly calls: ReorgReconciliation[] = [];
  readonly events: string[] = [];
  impact: ReorgImpact = {
    depth: 0,
    orphanedEvents: 0,
    replayedEvents: 0,
  };
  onReconcile: ((reorg: ReorgReconciliation) => Promise<void>) | null = null;

  async reconcileReorg(reorg: ReorgReconciliation): Promise<ReorgImpact> {
    this.calls.push(reorg);
    this.events.push('handler');
    await this.onReconcile?.(reorg);
    return { ...this.impact, depth: reorg.depth };
  }
}

class MemoryCanonicalStore {
  readonly blocks = new Map<bigint, CanonicalBlock>();
  readonly saves: CanonicalBlock[][] = [];
  readonly pruneCalls: bigint[] = [];
  readonly listLimits: number[] = [];

  constructor(initial: CanonicalBlock[] = []) {
    for (const header of initial) this.blocks.set(header.number, header);
  }

  async getCanonicalTip(): Promise<CanonicalBlock | null> {
    const numbers = [...this.blocks.keys()].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0);
    const number = numbers.at(-1);
    return number === undefined ? null : (this.blocks.get(number) ?? null);
  }

  async listCanonicalDescending(limit: number): Promise<CanonicalBlock[]> {
    this.listLimits.push(limit);
    return [...this.blocks.values()]
      .sort((left, right) =>
        left.number > right.number ? -1 : left.number < right.number ? 1 : 0)
      .slice(0, limit);
  }

  async saveCanonicalBlocks(headers: CanonicalBlock[]): Promise<void> {
    this.saves.push([...headers]);
    for (const header of headers) this.blocks.set(header.number, header);
  }

  async pruneCanonicalBefore(blockNumber: bigint): Promise<void> {
    this.pruneCalls.push(blockNumber);
    for (const number of this.blocks.keys()) {
      if (number < blockNumber) this.blocks.delete(number);
    }
  }
}

class MemoryCheckpoints {
  readonly values = new Map<string, ListenerCheckpoint>();
  readonly writes: Array<{
    listenerKey: string;
    checkpoint: ListenerCheckpoint;
  }> = [];

  async get(listenerKey: string): Promise<ListenerCheckpoint | null> {
    return this.values.get(listenerKey) ?? null;
  }

  async getOldestBlockNumber(): Promise<bigint | null> {
    let oldest: bigint | null = null;
    for (const checkpoint of this.values.values()) {
      if (oldest === null || checkpoint.blockNumber < oldest) {
        oldest = checkpoint.blockNumber;
      }
    }
    return oldest;
  }

  async set(
    listenerKey: string,
    checkpoint: Exclude<ListenerCheckpoint, { blockHash: null }>,
  ): Promise<void> {
    this.values.set(listenerKey, checkpoint);
    this.writes.push({ listenerKey, checkpoint });
  }
}

class CleanupFailureError extends Error {}

class MemoryHeaderSpool {
  readonly stored: CanonicalBlock[] = [];

  async append(header: CanonicalBlock): Promise<void> {
    this.stored.push(header);
  }

  async finish(): Promise<void> {}

  async *headers(): AsyncGenerator<CanonicalBlock> {
    for (const header of this.stored) yield header;
  }

  async dispose(): Promise<void> {
    throw new CleanupFailureError('cleanup failed');
  }
}

class CleanMemoryHeaderSpool extends MemoryHeaderSpool {
  override async dispose(): Promise<void> {}
}

const memoryHeaderSpoolFactory = {
  create: async (): Promise<CleanMemoryHeaderSpool> =>
    new CleanMemoryHeaderSpool(),
};

class ThrowingCleanupSpoolFactory {
  readonly spools: MemoryHeaderSpool[] = [];

  async create(): Promise<MemoryHeaderSpool> {
    const spool = new MemoryHeaderSpool();
    this.spools.push(spool);
    return spool;
  }
}

type HasConfigurableRetention =
  'retention' extends keyof CanonicalChainCoordinatorOptions ? true : false;
const hasConfigurableRetention: HasConfigurableRetention = false;

function coordinator(
  reader: MemoryBlockReader,
  canonicalStore = new MemoryCanonicalStore(),
  checkpoints = new MemoryCheckpoints(),
  options: {
    confirmations?: number;
    chunkSize?: number;
    cutoff?: CanonicalBlock;
    reorgHandler?: CanonicalReorgHandler;
    runtimeBarrier?: RuntimeRecoveryBarrier;
    headerSpoolFactory?: CanonicalChainCoordinatorOptions['headerSpoolFactory'];
    afterReorg?: CanonicalChainCoordinatorOptions['afterReorg'];
    onRecovered?: CanonicalChainCoordinatorOptions['onRecovered'];
  } = {},
): CanonicalChainCoordinator {
  return new CanonicalChainCoordinator({
    blockReader: reader,
    canonicalStore,
    checkpoints,
    reorgHandler: options.reorgHandler ?? new MemoryReorgHandler(),
    confirmations: options.confirmations ?? 5,
    ...(options.cutoff === undefined ? {} : { cutoff: options.cutoff }),
    ...(options.chunkSize === undefined
      ? {}
      : { chunkSize: options.chunkSize }),
    ...(options.runtimeBarrier === undefined
      ? {}
      : { runtimeBarrier: options.runtimeBarrier }),
    ...(options.headerSpoolFactory === undefined
      ? {}
      : { headerSpoolFactory: options.headerSpoolFactory }),
    ...(options.afterReorg === undefined
      ? {}
      : { afterReorg: options.afterReorg }),
    ...(options.onRecovered === undefined
      ? {}
      : { onRecovered: options.onRecovered }),
  });
}

function forkedBlock(
  number: bigint,
  ancestor: bigint,
  salt = 10_000n,
): CanonicalBlock {
  if (number <= ancestor) return block(number);
  return {
    number,
    hash: hash(salt + number),
    parentHash:
      number === ancestor + 1n
        ? block(ancestor).hash
        : hash(salt + number - 1n),
  };
}

test('refuse des confirmations hors de la plage sûre 1 à 100', () => {
  for (const invalid of [0, 101]) {
    assert.throws(
      () => coordinator(new MemoryBlockReader(20n), undefined, undefined, {
        confirmations: invalid,
      }),
      /confirmations.*1.*100/iu,
    );
  }
});

test('refuse un chunk supérieur au maximum de production', () => {
  assert.throws(
    () => coordinator(new MemoryBlockReader(20n), undefined, undefined, {
      chunkSize: 1_501,
    }),
    /chunkSize.*1.*1500/iu,
  );
});

test('ignore toute ancienne option runtime et impose une rétention de 128', async () => {
  assert.equal(hasConfigurableRetention, false);
  const reader = new MemoryBlockReader(132n);
  const canonicalStore = new MemoryCanonicalStore();
  const checkpoints = new MemoryCheckpoints();
  const legacyOptions = {
    blockReader: reader,
    canonicalStore,
    checkpoints,
    reorgHandler: new MemoryReorgHandler(),
    confirmations: 5,
    retention: 1,
  };
  const subject = new CanonicalChainCoordinator(legacyOptions);

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 200n,
    processChunk: async () => true,
  });

  assert.deepEqual(canonicalStore.listLimits, [128]);
  assert.equal(canonicalStore.saves[0]?.length, 128);
});

test('traite uniquement la plage confirmée puis ancre le checkpoint', async () => {
  const reader = new MemoryBlockReader(20n);
  const canonicalStore = new MemoryCanonicalStore();
  const checkpoints = new MemoryCheckpoints();
  const ranges: Array<[bigint, bigint]> = [];
  const subject = coordinator(reader, canonicalStore, checkpoints);

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 10n,
    processChunk: async (fromBlock, toBlock) => {
      ranges.push([fromBlock, toBlock]);
      return true;
    },
  });
  await subject.waitForIdle();

  assert.deepEqual(ranges, [[10n, 15n]]);
  assert.deepEqual(checkpoints.values.get('pairs'), {
    blockNumber: 15n,
    blockHash: hash(16n),
  });
});

test('ne traite jamais le cutoff ni un checkpoint plus ancien', async () => {
  const cutoff = block(100n);
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 10n,
    blockHash: hash(11n),
  });
  const ranges: Array<[bigint, bigint]> = [];
  const subject = coordinator(
    new MemoryBlockReader(110n),
    new MemoryCanonicalStore([cutoff]),
    checkpoints,
    { confirmations: 5, cutoff },
  );

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 0n,
    processChunk: async (from, to, headers) => {
      ranges.push([from, to]);
      assert.ok(headers.every(({ number }) => number > cutoff.number));
      return true;
    },
  });

  assert.deepEqual(ranges, [[101n, 105n]]);
  assert.ok(
    checkpoints.writes.every(
      ({ checkpoint }) => checkpoint.blockNumber >= cutoff.number,
    ),
  );
});

test('ne rappelle pas processChunk tant que le head confirmé égale le cutoff', async () => {
  const cutoff = block(100n);
  let chunks = 0;
  const subject = coordinator(
    new MemoryBlockReader(105n),
    new MemoryCanonicalStore([cutoff]),
    new MemoryCheckpoints(),
    { confirmations: 5, cutoff },
  );

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 0n,
    processChunk: async () => {
      chunks += 1;
      return true;
    },
  });

  assert.equal(chunks, 0);
});

test('une erreur RPC ne persiste pas l’ancrage d’un checkpoint sous le cutoff', async () => {
  const cutoff = block(100n);
  const reader = new MemoryBlockReader(110n);
  reader.failAt = cutoff.number;
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 10n,
    blockHash: hash(11n),
  });
  const subject = coordinator(
    reader,
    new MemoryCanonicalStore([cutoff]),
    checkpoints,
    { cutoff },
  );

  await assert.rejects(
    subject.reconcile({
      listenerKey: 'pairs',
      startBlock: 0n,
      processChunk: async () => true,
    }),
    /RPC indisponible/u,
  );
  assert.deepEqual(checkpoints.writes, []);
});

test('une erreur RPC de logs ne persiste pas l’ancrage sous le cutoff', async () => {
  const cutoff = block(100n);
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 10n,
    blockHash: hash(11n),
  });
  const subject = coordinator(
    new MemoryBlockReader(110n),
    new MemoryCanonicalStore([cutoff]),
    checkpoints,
    { cutoff },
  );

  await assert.rejects(
    subject.reconcile({
      listenerKey: 'pairs',
      startBlock: 0n,
      processChunk: async () => {
        throw new Error('log RPC unavailable');
      },
    }),
    /log RPC unavailable/u,
  );
  assert.deepEqual(checkpoints.writes, []);
});

test('passe en revue manuelle si une reorg traverse le cutoff', async () => {
  const cutoff = block(100n);
  const reader = new MemoryBlockReader(110n);
  reader.getBlock = async (number) => {
    reader.reads.push(number);
    return {
      number,
      hash: hash(20_000n + number),
      parentHash:
        number === 0n ? ZERO_HASH : hash(20_000n + number - 1n),
    };
  };
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 4 }, (_, index) => block(BigInt(100 + index))),
  );
  const reorgHandler = new MemoryReorgHandler();
  reorgHandler.impact = {
    depth: null,
    orphanedEvents: 0,
    replayedEvents: 0,
    requiresManualReview: true,
  };
  const subject = coordinator(
    reader,
    canonicalStore,
    new MemoryCheckpoints(),
    { cutoff, reorgHandler },
  );

  await assert.rejects(
    subject.reconcile({
      listenerKey: 'pairs',
      startBlock: 0n,
      processChunk: async () => true,
    }),
    /cutoff fresh-start/iu,
  );
  assert.equal(subject.currentStatus.state, 'MANUAL_REVIEW');
  assert.equal(
    reader.reads.some((number) => number < cutoff.number),
    false,
  );
});

test('bootstrappe un listener Pair fresh au head confirmé sans scanner son historique', async () => {
  const latest = 10_005n;
  const confirmed = 10_000n;
  const reader = new MemoryBlockReader(latest);
  const canonicalStore = new MemoryCanonicalStore();
  const checkpoints = new MemoryCheckpoints();
  const ranges: Array<[bigint, bigint]> = [];
  const subject = coordinator(reader, canonicalStore, checkpoints);

  await subject.reconcile({
    listenerKey: 'pair-created',
    startBlock: 0n,
    bootstrap: 'confirmed-head',
    processChunk: async (fromBlock, toBlock) => {
      ranges.push([fromBlock, toBlock]);
      return true;
    },
  });

  assert.deepEqual(ranges, [[confirmed, confirmed]]);
  assert.ok(
    reader.reads.length <= DEFAULT_CANONICAL_RETENTION + 1,
    `lectures de headers non bornées: ${reader.reads.length}`,
  );
  assert.deepEqual(checkpoints.values.get('pair-created'), {
    blockNumber: confirmed,
    blockHash: hash(confirmed + 1n),
  });
});

test('ne traite et ne checkpoint rien lorsque la tête n’est pas confirmée', async () => {
  const checkpoints = new MemoryCheckpoints();
  let calls = 0;
  const subject = coordinator(
    new MemoryBlockReader(4n),
    new MemoryCanonicalStore(),
    checkpoints,
  );

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 0n,
    processChunk: async () => {
      calls += 1;
      return true;
    },
  });

  assert.equal(calls, 0);
  assert.deepEqual(checkpoints.writes, []);
});

test('bootstrappe au plus 128 vrais headers continus, y compris depuis le bloc zéro', async () => {
  const reader = new MemoryBlockReader(132n);
  const canonicalStore = new MemoryCanonicalStore();
  const subject = coordinator(reader, canonicalStore, new MemoryCheckpoints());

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 200n,
    processChunk: async () => true,
  });

  const saved = canonicalStore.saves[0] ?? [];
  assert.equal(DEFAULT_CANONICAL_RETENTION, 128);
  assert.equal(saved.length, 128);
  assert.equal(saved[0]?.number, 0n);
  assert.equal(saved.at(-1)?.number, 127n);
  for (let index = 1; index < saved.length; index += 1) {
    assert.equal(saved[index]?.parentHash, saved[index - 1]?.hash);
  }
  assert.equal(saved[0]?.parentHash, ZERO_HASH);
  assert.deepEqual(canonicalStore.pruneCalls, [0n]);
});

test('réutilise le journal partagé sans nouvelle persistence pour un second listener', async () => {
  const reader = new MemoryBlockReader(20n);
  const canonicalStore = new MemoryCanonicalStore();
  const subject = coordinator(reader, canonicalStore, new MemoryCheckpoints());
  const request = (listenerKey: string) => ({
    listenerKey,
    startBlock: 16n,
    processChunk: async () => true,
  });

  await subject.reconcile(request('pairs'));
  const readsAfterFirstListener = reader.reads.length;
  await subject.reconcile(request('swaps'));

  assert.equal(
    reader.reads.length,
    readsAfterFirstListener + 1,
  );
  assert.equal(canonicalStore.saves.length, 1);
});

test('reprend après un checkpoint ancré', async () => {
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 12n,
    blockHash: hash(13n),
  });
  const ranges: Array<[bigint, bigint]> = [];
  const subject = coordinator(
    new MemoryBlockReader(20n),
    new MemoryCanonicalStore(),
    checkpoints,
  );

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 10n,
    processChunk: async (fromBlock, toBlock) => {
      ranges.push([fromBlock, toBlock]);
      return true;
    },
  });

  assert.deepEqual(ranges, [[13n, 15n]]);
});

test('ancre un checkpoint legacy exact avant de traiter sans sauter de bloc', async () => {
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', { blockNumber: 12n, blockHash: null });
  const ranges: Array<[bigint, bigint]> = [];
  const subject = coordinator(
    new MemoryBlockReader(20n),
    new MemoryCanonicalStore(),
    checkpoints,
  );

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 10n,
    processChunk: async (fromBlock, toBlock) => {
      ranges.push([fromBlock, toBlock]);
      return true;
    },
  });

  assert.deepEqual(checkpoints.writes[0], {
    listenerKey: 'pairs',
    checkpoint: { blockNumber: 12n, blockHash: hash(13n) },
  });
  assert.deepEqual(ranges, [[13n, 15n]]);
});

test('laisse inchangé un checkpoint legacy au-delà du head confirmé', async () => {
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', { blockNumber: 20n, blockHash: null });
  const canonicalStore = new MemoryCanonicalStore();
  const reader = new MemoryBlockReader(20n);
  let processCalls = 0;
  const subject = coordinator(
    reader,
    canonicalStore,
    checkpoints,
  );

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 10n,
    processChunk: async () => {
      processCalls += 1;
      return true;
    },
  });

  assert.equal(processCalls, 0);
  assert.deepEqual(checkpoints.values.get('pairs'), {
    blockNumber: 20n,
    blockHash: null,
  });
  assert.deepEqual(checkpoints.writes, []);
  assert.deepEqual(reader.reads, []);
  assert.deepEqual(canonicalStore.saves, []);
  assert.deepEqual(canonicalStore.pruneCalls, []);
});

test('une erreur RPC pendant le bootstrap legacy ne mute aucun état', async () => {
  const reader = new MemoryBlockReader(300n);
  reader.failAt = 100n;
  const canonicalStore = new MemoryCanonicalStore();
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', { blockNumber: 100n, blockHash: null });
  const subject = coordinator(reader, canonicalStore, checkpoints);

  await assert.rejects(
    subject.reconcile({
      listenerKey: 'pairs',
      startBlock: 10n,
      processChunk: async () => true,
    }),
    /RPC indisponible/u,
  );

  assert.deepEqual(canonicalStore.saves, []);
  assert.deepEqual(checkpoints.writes, []);
});

test('sérialise strictement les listeners et conserve la queue après un échec', async () => {
  const subject = coordinator(new MemoryBlockReader(6n));
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let signalFirstStarted: (() => void) | undefined;
  const firstStarted = new Promise<void>((resolve) => {
    signalFirstStarted = resolve;
  });

  const first = subject.reconcile({
    listenerKey: 'first',
    startBlock: 1n,
    processChunk: async () => {
      events.push('first:start');
      signalFirstStarted?.();
      await firstGate;
      events.push('first:fail');
      throw new Error('first failed');
    },
  });
  const second = subject.reconcile({
    listenerKey: 'second',
    startBlock: 1n,
    processChunk: async () => {
      events.push('second:start');
      return true;
    },
  });

  await firstStarted;
  assert.deepEqual(events, ['first:start']);
  assert.equal(subject.currentStatus.running, true);
  releaseFirst?.();
  await assert.rejects(first, /first failed/u);
  await second;
  await subject.waitForIdle();

  assert.deepEqual(events, ['first:start', 'first:fail', 'second:start']);
  assert.deepEqual(subject.currentStatus, {
    running: false,
    pendingRequests: 0,
    state: 'HEALTHY',
    lastReorg: null,
  });
});

test('annule immédiatement un reconcile de démarrage encore en queue puis rend sa continuation no-op', async () => {
  const checkpoints = new MemoryCheckpoints();
  const subject = coordinator(
    new MemoryBlockReader(6n),
    new MemoryCanonicalStore(),
    checkpoints,
  );
  const firstStarted = deferred();
  const releaseFirst = deferred();
  let cancelledChunks = 0;

  const first = subject.reconcile({
    listenerKey: 'first',
    startBlock: 1n,
    processChunk: async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return true;
    },
  });
  await firstStarted.promise;

  const controller = new AbortController();
  let cancelledResolved = false;
  const cancelled = subject.reconcile({
    listenerKey: 'cancelled-start',
    startBlock: 1n,
    signal: controller.signal,
    processChunk: async () => {
      cancelledChunks += 1;
      return true;
    },
  }).then(() => {
    cancelledResolved = true;
  });

  controller.abort();
  await flushPromises();
  const resolvedBeforeQueueTurn = cancelledResolved;
  releaseFirst.resolve();
  await Promise.all([first, cancelled]);
  await subject.waitForIdle();

  assert.equal(resolvedBeforeQueueTurn, true);
  assert.equal(cancelledChunks, 0);
  assert.equal(checkpoints.values.has('cancelled-start'), false);
  assert.equal(subject.currentStatus.pendingRequests, 0);
});

test('un callback Pair planifie le monitor sans bloquer son checkpoint avant Swap', async () => {
  const checkpoints = new MemoryCheckpoints();
  const subject = coordinator(
    new MemoryBlockReader(20n),
    new MemoryCanonicalStore(),
    checkpoints,
    { headerSpoolFactory: memoryHeaderSpoolFactory },
  );
  const order: string[] = [];
  const errors: unknown[] = [];

  const pair = subject.reconcile({
    listenerKey: 'pair-created',
    startBlock: 10n,
    processChunk: async () => {
      order.push('pair-start');
      scheduleMonitorReconcile(
        () => subject.reconcile({
          listenerKey: 'swap:pair',
          startBlock: 10n,
          processChunk: async () => {
            assert.deepEqual(checkpoints.values.get('pair-created'), {
              blockNumber: 15n,
              blockHash: hash(16n),
            });
            order.push('swap');
            return true;
          },
        }),
        (error) => {
          errors.push(error);
        },
      );
      order.push('pair-end');
      return true;
    },
  });

  await pair;
  assert.deepEqual(order, ['pair-start', 'pair-end']);
  await subject.waitForIdle();
  assert.deepEqual(order, ['pair-start', 'pair-end', 'swap']);
  assert.deepEqual(errors, []);
});

test('le déclencheur monitor non bloquant rend son échec observable', async () => {
  const failure = new Error('scheduler indisponible');
  const observed = deferred<unknown>();

  scheduleMonitorReconcile(
    () => {
      throw failure;
    },
    (error) => {
      observed.resolve(error);
    },
  );

  assert.equal(await observed.promise, failure);
});

test('découpe par chunks et checkpoint chaque fin exacte', async () => {
  const checkpoints = new MemoryCheckpoints();
  const canonicalStore = new MemoryCanonicalStore();
  const ranges: Array<[bigint, bigint]> = [];
  const subject = coordinator(
    new MemoryBlockReader(3_010n),
    canonicalStore,
    checkpoints,
  );

  await subject.reconcile({
    listenerKey: 'swaps',
    startBlock: 1n,
    processChunk: async (fromBlock, toBlock) => {
      ranges.push([fromBlock, toBlock]);
      return true;
    },
  });

  assert.deepEqual(ranges, [
    [1n, 1_500n],
    [1_501n, 3_000n],
    [3_001n, 3_005n],
  ]);
  assert.deepEqual(
    checkpoints.writes.map(({ checkpoint }) => checkpoint),
    [
      { blockNumber: 1_500n, blockHash: hash(1_501n) },
      { blockNumber: 3_000n, blockHash: hash(3_001n) },
      { blockNumber: 3_005n, blockHash: hash(3_006n) },
    ],
  );
  assert.equal(canonicalStore.saves.length, 1);
  assert.ok(canonicalStore.saves.every((saved) => saved.length <= 128));
  assert.equal(canonicalStore.blocks.size, 128);
});

test('découpe un rattrapage de 250 blocs en 100, 100 puis 50', async () => {
  const checkpoints = new MemoryCheckpoints();
  const canonicalStore = new MemoryCanonicalStore();
  const ranges: Array<[bigint, bigint]> = [];
  const subject = coordinator(
    new MemoryBlockReader(255n),
    canonicalStore,
    checkpoints,
    { chunkSize: 100 },
  );

  await subject.reconcile({
    listenerKey: 'swaps',
    startBlock: 1n,
    processChunk: async (fromBlock, toBlock) => {
      ranges.push([fromBlock, toBlock]);
      return true;
    },
  });

  assert.deepEqual(ranges, [
    [1n, 100n],
    [101n, 200n],
    [201n, 250n],
  ]);
  let nextExpectedStart = 1n;
  for (const [fromBlock, toBlock] of ranges) {
    assert.equal(fromBlock, nextExpectedStart);
    nextExpectedStart = toBlock + 1n;
  }
  assert.equal(nextExpectedStart, 251n);
  assert.equal(
    ranges.every(
      ([fromBlock, toBlock]) => toBlock - fromBlock + 1n <= 100n,
    ),
    true,
  );
});

test('une erreur de chunk ne checkpointe pas le remainder et la reprise reprend sur le bon bloc', async () => {
  const checkpoints = new MemoryCheckpoints();
  const canonicalStore = new MemoryCanonicalStore();
  const firstRun: Array<[bigint, bigint]> = [];
  const subject = coordinator(
    new MemoryBlockReader(255n),
    canonicalStore,
    checkpoints,
    { chunkSize: 100 },
  );
  const failure: Error = new Error('échec chunk 2');

  await assert.rejects(
    subject.reconcile({
      listenerKey: 'swaps',
      startBlock: 1n,
      processChunk: async (fromBlock, toBlock) => {
        firstRun.push([fromBlock, toBlock]);
        if (toBlock === 200n) {
          throw failure;
        }
        return true;
      },
    }),
    (error) => error === failure,
  );

  assert.deepEqual(firstRun, [
    [1n, 100n],
    [101n, 200n],
  ]);
  assert.deepEqual(checkpoints.writes, [{
    listenerKey: 'swaps',
    checkpoint: {
      blockNumber: 100n,
      blockHash: hash(101n),
    },
  }]);
  assert.equal(firstRun.some(([fromBlock, toBlock]) => toBlock - fromBlock + 1n > 100n), false);

  const retryRun: Array<[bigint, bigint]> = [];
  await subject.reconcile({
    listenerKey: 'swaps',
    startBlock: 1n,
    processChunk: async (fromBlock, toBlock) => {
      retryRun.push([fromBlock, toBlock]);
      return true;
    },
  });

  assert.deepEqual(retryRun, [
    [101n, 200n],
    [201n, 250n],
  ]);
  assert.deepEqual(checkpoints.writes.at(-1), {
    listenerKey: 'swaps',
    checkpoint: { blockNumber: 250n, blockHash: hash(251n) },
  });
  assert.equal(retryRun[0]?.[0], 101n);
  assert.deepEqual(
    [...firstRun, ...retryRun],
    [
      [1n, 100n],
      [101n, 200n],
      [101n, 200n],
      [201n, 250n],
    ],
  );
});

test('false stoppe sans checkpoint le chunk ni le remainder', async () => {
  const checkpoints = new MemoryCheckpoints();
  const ranges: Array<[bigint, bigint]> = [];
  const subject = coordinator(
    new MemoryBlockReader(3_010n),
    new MemoryCanonicalStore(),
    checkpoints,
    { chunkSize: 1_500 },
  );

  await subject.reconcile({
    listenerKey: 'swaps',
    startBlock: 1n,
    processChunk: async (fromBlock, toBlock) => {
      ranges.push([fromBlock, toBlock]);
      return false;
    },
  });

  assert.deepEqual(ranges, [[1n, 1_500n]]);
  assert.deepEqual(checkpoints.writes, []);
});

test('un mismatch avec le tip existant bloque sans mutation', async () => {
  const tip = block(10n);
  const reader = new MemoryBlockReader(16n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) => {
    const header = await originalGetBlock(number);
    return number === 11n ? { ...header, parentHash: hash(999n) } : header;
  };
  const canonicalStore = new MemoryCanonicalStore([tip]);
  const checkpoints = new MemoryCheckpoints();
  const subject = coordinator(reader, canonicalStore, checkpoints);

  await assert.rejects(
    subject.reconcile({
      listenerKey: 'pairs',
      startBlock: 11n,
      processChunk: async () => true,
    }),
    CanonicalChainContinuityError,
  );

  assert.deepEqual(canonicalStore.saves, []);
  assert.deepEqual(checkpoints.writes, []);
});

test('une erreur RPC durant une extension ne fait avancer ni journal ni checkpoint', async () => {
  const reader = new MemoryBlockReader(20n);
  reader.failAt = 13n;
  const canonicalStore = new MemoryCanonicalStore([block(10n)]);
  const checkpoints = new MemoryCheckpoints();
  const subject = coordinator(reader, canonicalStore, checkpoints);

  await assert.rejects(
    subject.reconcile({
      listenerKey: 'pairs',
      startBlock: 11n,
      processChunk: async () => true,
    }),
    /RPC indisponible/u,
  );

  assert.deepEqual(canonicalStore.saves, []);
  assert.deepEqual(checkpoints.writes, []);
});

test('borne à 128 le rattrapage d’un tip très ancien puis élague sans accumulation', async () => {
  const reader = new MemoryBlockReader(10_000n);
  const canonicalStore = new MemoryCanonicalStore([block(0n)]);
  const checkpoints = new MemoryCheckpoints();
  const subject = coordinator(reader, canonicalStore, checkpoints);

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 20_000n,
    processChunk: async () => true,
  });

  assert.ok(canonicalStore.saves.length > 0);
  assert.ok(canonicalStore.saves.every((saved) => saved.length <= 128));
  assert.deepEqual(canonicalStore.pruneCalls, [9_868n]);
  assert.equal(canonicalStore.blocks.size, 128);
  assert.equal(canonicalStore.blocks.has(9_868n), true);
  assert.equal(canonicalStore.blocks.has(9_995n), true);
});

test('ne prune aucun header requis par le plus ancien checkpoint', async () => {
  const reader = new MemoryBlockReader(300n);
  const canonicalStore = new MemoryCanonicalStore([block(100n)]);
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('older-listener', {
    blockNumber: 100n,
    blockHash: hash(101n),
  });
  const subject = coordinator(reader, canonicalStore, checkpoints);

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 400n,
    processChunk: async () => true,
  });

  assert.deepEqual(canonicalStore.pruneCalls, [100n]);
  const persisted = [...canonicalStore.blocks.values()]
    .sort((left, right) => left.number < right.number ? -1 : 1);
  assert.equal(persisted.length, 196);
  assert.equal(persisted[0]?.number, 100n);
  assert.equal(persisted.at(-1)?.number, 295n);
  assert.ok(canonicalStore.saves.every((saved) => saved.length <= 128));
  for (let index = 1; index < persisted.length; index += 1) {
    assert.equal(
      persisted[index]?.number,
      (persisted[index - 1]?.number ?? 0n) + 1n,
    );
    assert.equal(
      persisted[index]?.parentHash,
      persisted[index - 1]?.hash,
    );
  }
});

test('prune après avancée d’un checkpoint même si le journal est déjà au head', async () => {
  const reader = new MemoryBlockReader(205n);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 201 }, (_, index) => block(BigInt(index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 100n,
    blockHash: hash(101n),
  });
  const subject = coordinator(reader, canonicalStore, checkpoints);

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 1n,
    processChunk: async () => true,
  });

  assert.deepEqual(canonicalStore.saves, []);
  assert.deepEqual(canonicalStore.pruneCalls, [73n]);
  assert.equal(canonicalStore.blocks.size, 128);
});

test('un mismatch historique hors fenêtre bloque avant toute mutation ou traitement', async () => {
  const reader = new MemoryBlockReader(3_010n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) => {
    const header = await originalGetBlock(number);
    return number === 1_500n
      ? { ...header, parentHash: hash(999n) }
      : header;
  };
  const canonicalStore = new MemoryCanonicalStore();
  const checkpoints = new MemoryCheckpoints();
  let processCalls = 0;
  const subject = coordinator(reader, canonicalStore, checkpoints);

  await assert.rejects(
    subject.reconcile({
      listenerKey: 'swaps',
      startBlock: 1n,
      processChunk: async () => {
        processCalls += 1;
        return true;
      },
    }),
    CanonicalChainContinuityError,
  );

  assert.equal(processCalls, 0);
  assert.deepEqual(canonicalStore.saves, []);
  assert.deepEqual(canonicalStore.pruneCalls, []);
  assert.deepEqual(checkpoints.writes, []);
});

test('revalide par RPC les headers cachés du tip avant tout traitement', async () => {
  const reader = new MemoryBlockReader(105n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) => {
    const header = await originalGetBlock(number);
    return number === 95n ? { ...header, hash: hash(999n) } : header;
  };
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 10 }, (_, index) => block(BigInt(91 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('swaps', {
    blockNumber: 90n,
    blockHash: hash(91n),
  });
  let processCalls = 0;
  const subject = coordinator(reader, canonicalStore, checkpoints);

  await assert.rejects(
    subject.reconcile({
      listenerKey: 'swaps',
      startBlock: 1n,
      processChunk: async () => {
        processCalls += 1;
        return true;
      },
    }),
    CanonicalChainContinuityError,
  );

  assert.equal(processCalls, 0);
  assert.deepEqual(canonicalStore.saves, []);
  assert.deepEqual(canonicalStore.pruneCalls, []);
  assert.deepEqual(checkpoints.writes, []);
});

test('fait confiance au hash du tip confirmé sans rescanner ses ancêtres', async () => {
  const reader = new MemoryBlockReader(20n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) => {
    const header = await originalGetBlock(number);
    return number === 10n ? { ...header, hash: hash(999n) } : header;
  };
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 16 }, (_, index) => block(BigInt(index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 15n,
    blockHash: hash(16n),
  });
  const subject = coordinator(reader, canonicalStore, checkpoints);

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 1n,
    processChunk: async () => true,
  });

  assert.deepEqual(reader.reads, [15n]);
  assert.deepEqual(canonicalStore.saves, []);
  assert.deepEqual(canonicalStore.pruneCalls, []);
  assert.deepEqual(checkpoints.writes, []);
});

test('une erreur RPC au milieu du scan historique ne produit aucune mutation', async () => {
  const reader = new MemoryBlockReader(3_010n);
  reader.failAt = 2_000n;
  const canonicalStore = new MemoryCanonicalStore();
  const checkpoints = new MemoryCheckpoints();
  let processCalls = 0;
  const subject = coordinator(reader, canonicalStore, checkpoints);

  await assert.rejects(
    subject.reconcile({
      listenerKey: 'swaps',
      startBlock: 1n,
      processChunk: async () => {
        processCalls += 1;
        return true;
      },
    }),
    /RPC indisponible/u,
  );

  assert.equal(processCalls, 0);
  assert.deepEqual(canonicalStore.saves, []);
  assert.deepEqual(canonicalStore.pruneCalls, []);
  assert.deepEqual(checkpoints.writes, []);
});

test('préserve l’erreur RPC primaire malgré les erreurs de cleanup', async () => {
  const reader = new MemoryBlockReader(20n);
  const primaryError = new Error('RPC primary');
  reader.getBlock = async () => {
    throw primaryError;
  };
  const canonicalStore = new MemoryCanonicalStore();
  const checkpoints = new MemoryCheckpoints();
  const factory = new ThrowingCleanupSpoolFactory();
  const cleanupErrorTypes: string[] = [];
  const options = {
    blockReader: reader,
    canonicalStore,
    checkpoints,
    reorgHandler: new MemoryReorgHandler(),
    confirmations: 5,
    headerSpoolFactory: factory,
    onCleanupError: (errorType: string) => {
      cleanupErrorTypes.push(errorType);
    },
  };
  const subject = new CanonicalChainCoordinator(options);

  await assert.rejects(
    subject.reconcile({
      listenerKey: 'pairs',
      startBlock: 1n,
      processChunk: async () => true,
    }),
    (error: unknown) => error === primaryError,
  );

  assert.deepEqual(cleanupErrorTypes, [
    'CleanupFailureError',
    'CleanupFailureError',
  ]);
  assert.deepEqual(canonicalStore.saves, []);
  assert.deepEqual(checkpoints.writes, []);
});

test('une erreur de cleanup ne fait pas échouer un checkpoint déjà commité', async () => {
  const reader = new MemoryBlockReader(6n);
  const canonicalStore = new MemoryCanonicalStore();
  const checkpoints = new MemoryCheckpoints();
  const factory = new ThrowingCleanupSpoolFactory();
  const cleanupErrorTypes: string[] = [];
  const options = {
    blockReader: reader,
    canonicalStore,
    checkpoints,
    reorgHandler: new MemoryReorgHandler(),
    confirmations: 5,
    headerSpoolFactory: factory,
    onCleanupError: (errorType: string) => {
      cleanupErrorTypes.push(errorType);
    },
  };
  const subject = new CanonicalChainCoordinator(options);

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 1n,
    processChunk: async () => true,
  });

  assert.deepEqual(checkpoints.values.get('pairs'), {
    blockNumber: 1n,
    blockHash: hash(2n),
  });
  assert.deepEqual(cleanupErrorTypes, [
    'CleanupFailureError',
    'CleanupFailureError',
  ]);
});

test('rejette un header RPC sans numéro ou hash sans mutation', async () => {
  const reader = new MemoryBlockReader(6n);
  reader.getBlock = async () =>
    ({ number: null, hash: null, parentHash: ZERO_HASH }) as unknown as CanonicalBlock;
  const canonicalStore = new MemoryCanonicalStore();
  const checkpoints = new MemoryCheckpoints();
  const subject = coordinator(reader, canonicalStore, checkpoints);

  await assert.rejects(
    subject.reconcile({
      listenerKey: 'pairs',
      startBlock: 1n,
      processChunk: async () => true,
    }),
    /header.*invalide/iu,
  );

  assert.deepEqual(canonicalStore.saves, []);
  assert.deepEqual(checkpoints.writes, []);
});

test('ignore un reorg limité aux blocs non confirmés', async () => {
  const reader = new MemoryBlockReader(20n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) =>
    number > 15n
      ? forkedBlock(number, 15n)
      : originalGetBlock(number);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 16 }, (_, index) => block(BigInt(index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 15n,
    blockHash: block(15n).hash,
  });
  const reorgHandler = new MemoryReorgHandler();
  const subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
  });

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 1n,
    processChunk: async () => true,
  });

  assert.equal(reorgHandler.calls.length, 0);
  assert.equal(subject.currentStatus.state, 'HEALTHY');
});

test('réconcilie depuis l’ancêtre commun avant tout chunk ou checkpoint', async () => {
  const reader = new MemoryBlockReader(115n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) =>
    number > 106n
      ? forkedBlock(number, 106n)
      : originalGetBlock(number);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 110n,
    blockHash: block(110n).hash,
  });
  const reorgHandler = new MemoryReorgHandler();
  const events: string[] = [];
  reorgHandler.onReconcile = async ({ ancestor }) => {
    assert.equal(subject.currentStatus.state, 'RECONCILING');
    assert.deepEqual(checkpoints.writes, []);
    assert.equal(events.length, 0);
    for (const number of canonicalStore.blocks.keys()) {
      if (ancestor && number > ancestor.number) {
        canonicalStore.blocks.delete(number);
      }
    }
    if (ancestor) {
      checkpoints.values.set('pairs', {
        blockNumber: ancestor.number,
        blockHash: ancestor.hash,
      });
    }
  };
  const subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
  });

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => {
      events.push('chunk');
      return true;
    },
  });
  await subject.waitForIdle();

  assert.equal(reorgHandler.calls.length, 1);
  assert.deepEqual(reorgHandler.calls[0], {
    ancestor: block(106n),
    oldTip: block(110n),
    newTip: forkedBlock(110n, 106n),
    depth: 4,
  });
  assert.deepEqual(events, []);
  assert.deepEqual(checkpoints.writes, []);
  assert.equal(subject.currentStatus.state, 'HEALTHY');
  assert.equal(subject.currentStatus.lastReorg?.depth, 4);
});

test('un shallow reorg reste RECONCILING pendant le replay puis promeut le compteur final atomiquement', async () => {
  const replayStarted = deferred();
  const replayGate = deferred();
  const activationStarted = deferred();
  const activationGate = deferred();
  const reader = new MemoryBlockReader(115n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) =>
    number > 106n ? forkedBlock(number, 106n) : originalGetBlock(number);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', { blockNumber: 110n, blockHash: block(110n).hash });
  const reorgHandler = new MemoryReorgHandler();
  const subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
    afterReorg: async (state) => {
      assert.equal(state, 'RECONCILING');
      replayStarted.resolve();
      await replayGate.promise;
      const current = subject.currentStatus.lastReorg;
      assert.ok(current);
      return {
        identity: `${current.oldTip.hash.toLowerCase()}:${current.newTip.hash.toLowerCase()}`,
        reorgId: 'first',
        replayedEvents: 7,
      };
    },
    onRecovered: async () => {
      activationStarted.resolve();
      await activationGate.promise;
    },
  });

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => true,
  });
  await replayStarted.promise;

  assert.equal(subject.currentStatus.state, 'RECONCILING');
  assert.equal(subject.currentStatus.lastReorg?.status, 'RECONCILING');
  assert.equal(subject.currentStatus.lastReorg?.impact.replayedEvents, 0);

  replayGate.resolve();
  await activationStarted.promise;
  assert.equal(subject.currentStatus.state, 'RECONCILING');
  assert.equal(subject.currentStatus.lastReorg?.status, 'RECONCILING');
  activationGate.resolve();
  await subject.waitForIdle();

  assert.equal(subject.currentStatus.state, 'HEALTHY');
  assert.equal(subject.currentStatus.lastReorg?.status, 'RECOVERED');
  assert.equal(subject.currentStatus.lastReorg?.impact.replayedEvents, 7);
});

test('enchaîne deux shallow reorgs pendant le replay et ne promeut que le second résultat FIFO', async () => {
  let salt = 10_000n;
  const reader = new MemoryBlockReader(115n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) =>
    number > 106n ? forkedBlock(number, 106n, salt) : originalGetBlock(number);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', { blockNumber: 110n, blockHash: block(110n).hash });
  const reorgHandler: CanonicalReorgHandler = {
    reconcileReorg: async (reorg) => {
      assert.ok(reorg.ancestor);
      for (let number = reorg.ancestor.number + 1n; number <= reorg.oldTip.number; number += 1n) {
        canonicalStore.blocks.set(number, forkedBlock(number, 106n, salt));
      }
      checkpoints.values.set('pairs', {
        blockNumber: reorg.ancestor.number,
        blockHash: reorg.ancestor.hash,
      });
      if (salt === 10_000n) salt = 20_000n;
      return { depth: reorg.depth, orphanedEvents: 1, replayedEvents: 0 };
    },
  };
  const completed: Array<{ reorgId: string; replayedEvents: number }> = [];
  let afterCalls = 0;
  let subject: CanonicalChainCoordinator;
  subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
    afterReorg: async (state) => {
      assert.equal(state, 'RECONCILING');
      const current = subject.currentStatus.lastReorg;
      assert.ok(current);
      const identity = `${current.oldTip.hash.toLowerCase()}:${current.newTip.hash.toLowerCase()}`;
      afterCalls += 1;
      if (afterCalls === 1) {
        await subject.reconcile({
          listenerKey: 'nested-pairs',
          startBlock: 107n,
          processChunk: async () => true,
        });
        completed.push({ reorgId: 'first', replayedEvents: 3 });
        return { identity, reorgId: 'first', replayedEvents: 3 };
      }
      completed.push({ reorgId: 'second', replayedEvents: 7 });
      return { identity, reorgId: 'second', replayedEvents: 7 };
    },
  });

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => true,
  });
  await subject.waitForIdle();

  assert.deepEqual(completed, [
    { reorgId: 'first', replayedEvents: 3 },
    { reorgId: 'second', replayedEvents: 7 },
  ]);
  assert.equal(subject.currentStatus.state, 'HEALTHY');
  assert.equal(subject.currentStatus.lastReorg?.status, 'RECOVERED');
  assert.equal(subject.currentStatus.lastReorg?.impact.replayedEvents, 7);
  assert.equal(subject.currentStatus.lastReorg?.newTip.hash, forkedBlock(110n, 106n, 20_000n).hash);
});

test('un second replay en échec laisse son audit runtime RECONCILING après la finalisation du premier', async () => {
  let salt = 10_000n;
  const reader = new MemoryBlockReader(115n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) =>
    number > 106n ? forkedBlock(number, 106n, salt) : originalGetBlock(number);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', { blockNumber: 110n, blockHash: block(110n).hash });
  const reorgHandler: CanonicalReorgHandler = {
    reconcileReorg: async (reorg) => {
      assert.ok(reorg.ancestor);
      for (let number = reorg.ancestor.number + 1n; number <= reorg.oldTip.number; number += 1n) {
        canonicalStore.blocks.set(number, forkedBlock(number, 106n, salt));
      }
      checkpoints.values.set('pairs', {
        blockNumber: reorg.ancestor.number,
        blockHash: reorg.ancestor.hash,
      });
      if (salt === 10_000n) salt = 20_000n;
      return { depth: reorg.depth, orphanedEvents: 1, replayedEvents: 0 };
    },
  };
  const completed: Array<{ reorgId: string; replayedEvents: number }> = [];
  let afterCalls = 0;
  let subject: CanonicalChainCoordinator;
  subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
    afterReorg: async () => {
      const current = subject.currentStatus.lastReorg;
      assert.ok(current);
      const identity = `${current.oldTip.hash.toLowerCase()}:${current.newTip.hash.toLowerCase()}`;
      afterCalls += 1;
      if (afterCalls === 1) {
        completed.push({ reorgId: 'first', replayedEvents: 3 });
        await subject.reconcile({
          listenerKey: 'nested-pairs',
          startBlock: 107n,
          processChunk: async () => true,
        });
        return { identity, reorgId: 'first', replayedEvents: 3 };
      }
      throw new Error('second replay failed');
    },
  });

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => true,
  });
  await subject.waitForIdle();

  assert.deepEqual(completed, [{ reorgId: 'first', replayedEvents: 3 }]);
  assert.equal(subject.currentStatus.state, 'RECONCILING');
  assert.equal(subject.currentStatus.lastReorg?.status, 'RECONCILING');
  assert.equal(subject.currentStatus.lastReorg?.newTip.hash, forkedBlock(110n, 106n, 20_000n).hash);
});

test('un échec post-reorg remet aussi le dernier audit runtime en RECONCILING', async () => {
  const reader = new MemoryBlockReader(115n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) =>
    number > 106n ? forkedBlock(number, 106n) : originalGetBlock(number);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 110n,
    blockHash: block(110n).hash,
  });
  const reorgHandler = new MemoryReorgHandler();
  const subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
    afterReorg: async () => { throw new Error('replay impossible'); },
  });

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => true,
  });
  await subject.waitForIdle();

  assert.equal(subject.currentStatus.state, 'RECONCILING');
  assert.equal(subject.currentStatus.lastReorg?.status, 'RECONCILING');
});

test('une reconcile externe relance sérialisée la finalisation échouée avant de traiter ses chunks', async () => {
  const retryStarted = deferred();
  const retryGate = deferred();
  const reader = new MemoryBlockReader(115n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) =>
    number > 106n ? forkedBlock(number, 106n) : originalGetBlock(number);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', { blockNumber: 110n, blockHash: block(110n).hash });
  let hookCalls = 0;
  const chunks: string[] = [];
  let subject: CanonicalChainCoordinator;
  subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler: {
      reconcileReorg: async (reorg) => {
        assert.ok(reorg.ancestor);
        for (
          let number = reorg.ancestor.number + 1n;
          number <= reorg.newTip.number;
          number += 1n
        ) {
          canonicalStore.blocks.set(number, forkedBlock(number, 106n));
        }
        checkpoints.values.set('pairs', {
          blockNumber: reorg.ancestor.number,
          blockHash: reorg.ancestor.hash,
        });
        return { depth: reorg.depth, orphanedEvents: 1, replayedEvents: 0 };
      },
    },
    afterReorg: async () => {
      hookCalls += 1;
      if (hookCalls === 1) throw new Error('complete RPC failed');
      retryStarted.resolve();
      await retryGate.promise;
      const current = subject.currentStatus.lastReorg;
      assert.ok(current);
      return {
        identity: `${current.oldTip.hash.toLowerCase()}:${current.newTip.hash.toLowerCase()}`,
        reorgId: 'recovered-after-retry',
        replayedEvents: 1,
      };
    },
  });

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => true,
  });
  await subject.waitForIdle();
  assert.equal(subject.currentStatus.state, 'RECONCILING');

  const first = subject.reconcile({
    listenerKey: 'retry-one',
    startBlock: 100n,
    processChunk: async () => { chunks.push('one'); return true; },
  });
  const second = subject.reconcile({
    listenerKey: 'retry-two',
    startBlock: 100n,
    processChunk: async () => { chunks.push('two'); return true; },
  });
  await retryStarted.promise;
  assert.deepEqual(chunks, []);
  assert.equal(hookCalls, 2);

  retryGate.resolve();
  await Promise.all([first, second]);

  assert.equal(subject.currentStatus.state, 'HEALTHY');
  assert.deepEqual(chunks, ['one', 'two']);
  assert.equal(hookCalls, 2);
});

test('hydrate un audit shallow RECONCILING puis le finalise avant le premier sync canonique', async () => {
  const reader = new MemoryBlockReader(115n);
  const canonicalStore = new MemoryCanonicalStore();
  const checkpoints = new MemoryCheckpoints();
  const events: string[] = [];
  let subject: CanonicalChainCoordinator;
  subject = coordinator(reader, canonicalStore, checkpoints, {
    afterReorg: async () => {
      events.push('finalize');
      const current = subject.currentStatus.lastReorg;
      assert.ok(current);
      return {
        identity: `${current.oldTip.hash.toLowerCase()}:${current.newTip.hash.toLowerCase()}`,
        reorgId: 'reorg:hydrated',
        replayedEvents: 4,
      };
    },
  });
  subject.hydratePendingReorg({
    reorgId: 'reorg:hydrated',
    detectedAtMs: 1_753_700_000_000,
    ancestor: { number: 10n, hash: block(10n).hash },
    oldTip: { number: 12n, hash: block(12n).hash },
    newTip: { number: 13n, hash: forkedBlock(13n, 10n).hash },
    impact: { depth: 2, orphanedEvents: 1, replayedEvents: 0 },
  });

  await subject.reconcile({
    listenerKey: 'canonical-startup-sync',
    startBlock: 100n,
    processChunk: async () => { events.push('chunk'); return true; },
  });

  assert.deepEqual(events, ['finalize', 'chunk']);
  assert.equal(subject.currentStatus.state, 'HEALTHY');
  assert.equal(subject.currentStatus.lastReorg?.status, 'RECOVERED');
  assert.equal(subject.currentStatus.lastReorg?.impact.replayedEvents, 4);
});

test('hydrate et finalise une cascade persistée dans l’ordre FIFO avant le sync canonique', async () => {
  const reader = new MemoryBlockReader(115n);
  const canonicalStore = new MemoryCanonicalStore();
  const checkpoints = new MemoryCheckpoints();
  const events: string[] = [];
  let subject: CanonicalChainCoordinator;
  subject = coordinator(reader, canonicalStore, checkpoints, {
    afterReorg: async () => {
      const current = subject.currentStatus.lastReorg;
      assert.ok(current);
      const identity = `${current.oldTip.hash.toLowerCase()}:${current.newTip.hash.toLowerCase()}`;
      events.push(`finalize:${identity}`);
      return { identity, reorgId: `reorg:${identity}`, replayedEvents: events.length };
    },
  });
  const first = {
    reorgId: `reorg:${block(11n).hash}:${forkedBlock(12n, 10n).hash}`,
    detectedAtMs: 1_753_700_000_000,
    ancestor: { number: 10n, hash: block(10n).hash },
    oldTip: { number: 11n, hash: block(11n).hash },
    newTip: { number: 12n, hash: forkedBlock(12n, 10n).hash },
    impact: { depth: 1, orphanedEvents: 1, replayedEvents: 0 },
  };
  const second = {
    reorgId: `reorg:${block(12n).hash}:${forkedBlock(13n, 10n).hash}`,
    detectedAtMs: 1_753_700_001_000,
    ancestor: { number: 10n, hash: block(10n).hash },
    oldTip: { number: 12n, hash: block(12n).hash },
    newTip: { number: 13n, hash: forkedBlock(13n, 10n).hash },
    impact: { depth: 2, orphanedEvents: 1, replayedEvents: 0 },
  };
  subject.hydratePendingReorgs([first, second]);

  await subject.reconcile({
    listenerKey: 'canonical-startup-sync',
    startBlock: 100n,
    processChunk: async () => { events.push('chunk'); return true; },
  });

  assert.deepEqual(events, [
    `finalize:${first.oldTip.hash}:${first.newTip.hash}`,
    `finalize:${second.oldTip.hash}:${second.newTip.hash}`,
    'chunk',
  ]);
  assert.equal(subject.currentStatus.state, 'HEALTHY');
  assert.equal(subject.currentStatus.lastReorg?.newTip.hash, second.newTip.hash);
  assert.equal(subject.currentStatus.lastReorg?.impact.replayedEvents, 2);
});

test('un audit wallet hydraté termine MANUAL_REVIEW sans exécuter le sync original', async () => {
  const reader = new MemoryBlockReader(115n);
  const canonicalStore = new MemoryCanonicalStore();
  const checkpoints = new MemoryCheckpoints();
  let processCalls = 0;
  let subject: CanonicalChainCoordinator;
  subject = coordinator(reader, canonicalStore, checkpoints, {
    afterReorg: async () => {
      const current = subject.currentStatus.lastReorg;
      assert.ok(current);
      const identity = `${current.oldTip.hash.toLowerCase()}:${current.newTip.hash.toLowerCase()}`;
      subject.requireManualReviewForPendingReorg(identity, 'reorg:wallet');
      return undefined;
    },
  });
  subject.hydratePendingReorg({
    reorgId: 'reorg:wallet',
    detectedAtMs: 1_753_700_000_000,
    ancestor: { number: 10n, hash: block(10n).hash },
    oldTip: { number: 12n, hash: block(12n).hash },
    newTip: { number: 13n, hash: forkedBlock(13n, 10n).hash },
    impact: {
      depth: 2,
      orphanedEvents: 1,
      replayedEvents: 0,
      requiresManualReview: true,
    },
  });

  await subject.reconcile({
    listenerKey: 'canonical-startup-sync',
    startBlock: 100n,
    processChunk: async () => { processCalls += 1; return true; },
  });

  assert.equal(processCalls, 0);
  assert.equal(subject.currentStatus.state, 'MANUAL_REVIEW');
  assert.equal(subject.currentStatus.lastReorg?.status, 'MANUAL_REVIEW');
});

test('hydrate directement un audit terminal profond en MANUAL_REVIEW et refuse toute ingestion', async () => {
  const subject = coordinator(new MemoryBlockReader(115n));
  const hydrateManualReview = (
    subject as unknown as {
      hydrateManualReviewReorg(value: unknown): void;
    }
  ).hydrateManualReviewReorg.bind(subject);
  hydrateManualReview({
    reorgId: `reorg:${block(12n).hash}:${forkedBlock(13n, 10n).hash}`,
    detectedAtMs: 1_753_700_000_000,
    ancestor: null,
    oldTip: { number: 12n, hash: block(12n).hash },
    newTip: { number: 13n, hash: forkedBlock(13n, 10n).hash },
    impact: {
      depth: null,
      orphanedEvents: 0,
      replayedEvents: 0,
      requiresManualReview: true,
    },
  });
  let processed = false;

  await subject.reconcile({
    listenerKey: 'blocked',
    startBlock: 0n,
    processChunk: async () => {
      processed = true;
      return true;
    },
  });

  assert.equal(processed, false);
  assert.equal(subject.currentStatus.state, 'MANUAL_REVIEW');
  assert.equal(subject.currentStatus.lastReorg?.status, 'MANUAL_REVIEW');
  assert.equal(subject.currentStatus.lastReorg?.ancestor, null);
});

test('refuse de promouvoir un résultat post-reorg associé à un autre fork', async () => {
  const reader = new MemoryBlockReader(115n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) =>
    number > 106n ? forkedBlock(number, 106n) : originalGetBlock(number);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', { blockNumber: 110n, blockHash: block(110n).hash });
  const subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler: new MemoryReorgHandler(),
    afterReorg: async () => ({
      identity: 'another-fork',
      reorgId: 'wrong',
      replayedEvents: 4,
    }),
  });

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => true,
  });
  await subject.waitForIdle();

  assert.equal(subject.currentStatus.state, 'RECONCILING');
  assert.equal(subject.currentStatus.lastReorg?.status, 'RECONCILING');
});

test('une conséquence wallet shallow reste MANUAL_REVIEW sans transition RECOVERED', async () => {
  const reader = new MemoryBlockReader(115n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) =>
    number > 106n ? forkedBlock(number, 106n) : originalGetBlock(number);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', { blockNumber: 110n, blockHash: block(110n).hash });
  const reorgHandler = new MemoryReorgHandler();
  reorgHandler.impact = {
    depth: 4,
    orphanedEvents: 1,
    replayedEvents: 0,
    requiresManualReview: true,
  };
  const subject = coordinator(reader, canonicalStore, checkpoints, { reorgHandler });

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => true,
  });

  assert.equal(subject.currentStatus.state, 'MANUAL_REVIEW');
  assert.equal(subject.currentStatus.lastReorg?.status, 'MANUAL_REVIEW');
});

test('une erreur RPC pendant le préflight ou la recherche d’ancêtre ne mute rien', async () => {
  for (const failure of [
    { name: 'tip', failAt: 110n, latest: 115n },
    { name: 'ancestor', failAt: 108n, latest: 115n },
    { name: 'new-tip', failAt: 112n, latest: 117n },
  ]) {
    const reader = new MemoryBlockReader(failure.latest);
    const originalGetBlock = reader.getBlock.bind(reader);
    reader.getBlock = async (number) => {
      if (number === failure.failAt) {
        throw new Error(`RPC ${failure.name}`);
      }
      return number > 106n
        ? forkedBlock(number, 106n)
        : originalGetBlock(number);
    };
    const initial = Array.from(
      { length: 11 },
      (_, index) => block(BigInt(100 + index)),
    );
    const canonicalStore = new MemoryCanonicalStore(initial);
    const checkpoints = new MemoryCheckpoints();
    checkpoints.values.set('pairs', {
      blockNumber: 110n,
      blockHash: block(110n).hash,
    });
    const beforeBlocks = [...canonicalStore.blocks.entries()];
    const beforeCheckpoints = [...checkpoints.values.entries()];
    const reorgHandler = new MemoryReorgHandler();
    const subject = coordinator(reader, canonicalStore, checkpoints, {
      reorgHandler,
    });

    await assert.rejects(
      subject.reconcile({
        listenerKey: 'pairs',
        startBlock: 100n,
        processChunk: async () => true,
      }),
      new RegExp(`RPC ${failure.name}`, 'u'),
    );

    assert.equal(reorgHandler.calls.length, 0, failure.name);
    assert.deepEqual([...canonicalStore.blocks.entries()], beforeBlocks);
    assert.deepEqual([...checkpoints.values.entries()], beforeCheckpoints);
    assert.deepEqual(canonicalStore.saves, []);
    assert.deepEqual(canonicalStore.pruneCalls, []);
    assert.deepEqual(checkpoints.writes, []);
  }
});

test('refuse des headers RPC provenant de forks différents pendant le scan', async () => {
  const reader = new MemoryBlockReader(117n);
  let headReads = 0;
  reader.getBlock = async (number) => {
    if (number === 112n) {
      headReads += 1;
      return forkedBlock(
        number,
        106n,
        headReads === 1 ? 20_000n : 30_000n,
      );
    }
    return forkedBlock(number, 106n, 10_000n);
  };
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 110n,
    blockHash: block(110n).hash,
  });
  const reorgHandler = new MemoryReorgHandler();
  const subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
  });

  await assert.rejects(
    subject.reconcile({
      listenerKey: 'pairs',
      startBlock: 100n,
      processChunk: async () => true,
    }),
    CanonicalChainContinuityError,
  );

  assert.equal(reorgHandler.calls.length, 0);
  assert.deepEqual(canonicalStore.saves, []);
  assert.deepEqual(canonicalStore.pruneCalls, []);
  assert.deepEqual(checkpoints.writes, []);
});

test('borne la recherche d’ancêtre même si le head est très éloigné du tip', async () => {
  const reader = new MemoryBlockReader(1_005n);
  reader.getBlock = async (number) => {
    reader.reads.push(number);
    return forkedBlock(number, 106n);
  };
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  const reorgHandler = new MemoryReorgHandler();
  const subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
  });

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 2_000n,
    processChunk: async () => true,
  });

  assert.ok(
    reader.reads.length <= DEFAULT_CANONICAL_RETENTION + 3,
    `lectures RPC non bornées: ${reader.reads.length}`,
  );
  assert.equal(reader.reads.includes(999n), false);
  assert.equal(reorgHandler.calls.length, 1);
  assert.equal(reorgHandler.calls[0]?.ancestor?.number, 106n);
  assert.equal(reorgHandler.calls[0]?.newTip.number, 1_000n);
});

test('isole le handler et les snapshots de status par clones défensifs', async () => {
  const reader = new MemoryBlockReader(115n);
  reader.getBlock = async (number) => forkedBlock(number, 106n);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  const returnedImpact: ReorgImpact = {
    depth: 4,
    orphanedEvents: 2,
    replayedEvents: 1,
  };
  const reorgHandler: CanonicalReorgHandler = {
    reconcileReorg: async (reorg) => {
      (reorg.oldTip as { hash: Hash }).hash = hash(90_001n);
      (reorg.ancestor as { hash: Hash }).hash = hash(90_002n);
      return returnedImpact;
    },
  };
  const subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
  });

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => true,
  });

  assert.equal(canonicalStore.blocks.get(106n)?.hash, block(106n).hash);
  (returnedImpact as { orphanedEvents: number }).orphanedEvents = 999;
  const exposed = subject.currentStatus;
  assert.ok(exposed.lastReorg);
  (exposed.lastReorg.oldTip as { hash: Hash }).hash = hash(90_003n);
  (exposed.lastReorg.impact as { replayedEvents: number }).replayedEvents = 999;

  const reread = subject.currentStatus.lastReorg;
  assert.equal(reread?.oldTip.hash, block(110n).hash);
  assert.equal(reread?.ancestor?.hash, block(106n).hash);
  assert.deepEqual(reread?.impact, {
    depth: 4,
    orphanedEvents: 2,
    replayedEvents: 1,
  });
});

test('bloque toute nouvelle passe si un rewind shallow échoue', async () => {
  const reader = new MemoryBlockReader(115n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) =>
    number > 106n
      ? forkedBlock(number, 106n)
      : originalGetBlock(number);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 110n,
    blockHash: block(110n).hash,
  });
  const reorgHandler = new MemoryReorgHandler();
  reorgHandler.onReconcile = async ({ ancestor }) => {
    for (const number of canonicalStore.blocks.keys()) {
      if (ancestor && number > ancestor.number) {
        canonicalStore.blocks.delete(number);
      }
    }
    throw new Error('rewind incomplet');
  };
  const subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
  });
  let processCalls = 0;
  const request = {
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => {
      processCalls += 1;
      return true;
    },
  };

  await assert.rejects(subject.reconcile(request), /rewind incomplet/u);
  assert.equal(subject.currentStatus.state, 'RECONCILING');
  const readsAfterFailure = reader.reads.length;
  const blockNumberReadsAfterFailure = reader.blockNumberReads;
  const writesAfterFailure = checkpoints.writes.length;

  await assert.rejects(
    subject.reconcile(request),
    /Rollback shallow incomplet/u,
  );

  assert.equal(reader.reads.length, readsAfterFailure);
  assert.equal(reader.blockNumberReads, blockNumberReadsAfterFailure);
  assert.equal(processCalls, 0);
  assert.equal(checkpoints.writes.length, writesAfterFailure);
  assert.equal(reorgHandler.calls.length, 1);
  assert.equal(subject.currentStatus.state, 'RECONCILING');
});

test('refuse une fenêtre canonique vide avant le handler', async () => {
  const reader = new MemoryBlockReader(115n);
  reader.getBlock = async (number) => forkedBlock(number, 106n);
  const canonicalStore = new MemoryCanonicalStore([block(110n)]);
  canonicalStore.listCanonicalDescending = async () => [];
  const checkpoints = new MemoryCheckpoints();
  const reorgHandler = new MemoryReorgHandler();
  const subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
  });

  await assert.rejects(
    subject.reconcile({
      listenerKey: 'pairs',
      startBlock: 100n,
      processChunk: async () => true,
    }),
    /fenêtre canonique.*vide/iu,
  );

  assert.equal(reorgHandler.calls.length, 0);
  assert.deepEqual(canonicalStore.saves, []);
  assert.deepEqual(canonicalStore.pruneCalls, []);
  assert.deepEqual(checkpoints.writes, []);
});

test('refuse une fenêtre canonique supérieure à 128 avant le handler', async () => {
  const reader = new MemoryBlockReader(133n);
  reader.getBlock = async (number) => ({
    number,
    hash: hash(20_000n + number),
    parentHash:
      number === 0n ? ZERO_HASH : hash(20_000n + number - 1n),
  });
  const persisted = Array.from(
    { length: 129 },
    (_, index) => block(BigInt(index)),
  );
  const canonicalStore = new MemoryCanonicalStore(persisted);
  canonicalStore.listCanonicalDescending = async () =>
    [...persisted].reverse();
  const checkpoints = new MemoryCheckpoints();
  const reorgHandler = new MemoryReorgHandler();
  const subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
  });

  await assert.rejects(
    subject.reconcile({
      listenerKey: 'pairs',
      startBlock: 0n,
      processChunk: async () => true,
    }),
    /fenêtre canonique.*128/iu,
  );

  assert.equal(reorgHandler.calls.length, 0);
  assert.deepEqual(canonicalStore.saves, []);
  assert.deepEqual(canonicalStore.pruneCalls, []);
  assert.deepEqual(checkpoints.writes, []);
});

test('passe en revue manuelle sans ancêtre et bloque les passes suivantes', async () => {
  const reader = new MemoryBlockReader(132n);
  reader.getBlock = async (number) => ({
    number,
    hash: hash(20_000n + number),
    parentHash:
      number === 0n ? ZERO_HASH : hash(20_000n + number - 1n),
  });
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 128 }, (_, index) => block(BigInt(index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 127n,
    blockHash: block(127n).hash,
  });
  const reorgHandler = new MemoryReorgHandler();
  const subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
  });
  let processCalls = 0;
  const request = {
    listenerKey: 'pairs',
    startBlock: 0n,
    processChunk: async () => {
      processCalls += 1;
      return true;
    },
  };

  await assert.rejects(subject.reconcile(request), DeepReorgError);

  assert.equal(reorgHandler.calls.length, 1);
  assert.equal(reorgHandler.calls[0]?.ancestor, null);
  assert.equal(reorgHandler.calls[0]?.depth, null);
  assert.equal(subject.currentStatus.state, 'MANUAL_REVIEW');
  const readsAfterDetection = reader.reads.length;

  await subject.reconcile(request);

  assert.equal(processCalls, 0);
  assert.equal(reader.reads.length, readsAfterDetection);
  assert.equal(reorgHandler.calls.length, 1);
});

test('un nouveau coordinator détecte un journal persistant divergent', async () => {
  const reader = new MemoryBlockReader(115n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) =>
    number > 106n
      ? forkedBlock(number, 106n)
      : originalGetBlock(number);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 110n,
    blockHash: block(110n).hash,
  });
  const reorgHandler = new MemoryReorgHandler();

  const restarted = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
  });
  await restarted.reconcile({
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => {
      assert.fail('aucun chunk avant le rewind au redémarrage');
    },
  });

  assert.equal(reorgHandler.calls.length, 1);
  assert.equal(reorgHandler.calls[0]?.ancestor?.number, 106n);
  assert.equal(reorgHandler.calls[0]?.ancestor?.hash, block(106n).hash);
  assert.equal(reorgHandler.calls[0]?.depth, 4);
});

test('attend la fin d’un listener actif avant de démarrer le rollback', async () => {
  const barrier = new RuntimeRecoveryBarrier();
  const listenerGate = deferred();
  const listenerStarted = deferred();
  const rollbackStarted = deferred();
  const rollbackGate = deferred();
  const reader = new MemoryBlockReader(115n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) =>
    number > 106n
      ? forkedBlock(number, 106n)
      : originalGetBlock(number);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 110n,
    blockHash: block(110n).hash,
  });
  let rollbackCalls = 0;
  const reorgHandler: CanonicalReorgHandler = {
    reconcileReorg: (reorg) =>
      barrier.runRecovery(async () => {
        rollbackCalls += 1;
        rollbackStarted.resolve();
        await rollbackGate.promise;
        return {
          depth: reorg.depth,
          orphanedEvents: 0,
          replayedEvents: 0,
        };
      }),
  };
  const subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
    runtimeBarrier: barrier,
  });
  const listenerRun = barrier.runListener(async () => {
    listenerStarted.resolve();
    await listenerGate.promise;
  });
  await listenerStarted.promise;

  const reconciliation = subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => true,
  });
  await flushPromises();

  assert.equal(rollbackCalls, 0);
  listenerGate.resolve();
  await rollbackStarted.promise;
  assert.equal(rollbackCalls, 1);
  rollbackGate.resolve();
  await Promise.all([listenerRun, reconciliation]);
});

test('un rollback ouvert bloque la passe listener suivante', async () => {
  const barrier = new RuntimeRecoveryBarrier();
  const rollbackStarted = deferred();
  const rollbackGate = deferred();
  const reader = new MemoryBlockReader(115n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) =>
    number > 106n
      ? forkedBlock(number, 106n)
      : originalGetBlock(number);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 110n,
    blockHash: block(110n).hash,
  });
  const reorgHandler: CanonicalReorgHandler = {
    reconcileReorg: (reorg) =>
      barrier.runRecovery(async () => {
        rollbackStarted.resolve();
        await rollbackGate.promise;
        if (!reorg.ancestor) assert.fail('ancêtre shallow attendu');
        for (const number of canonicalStore.blocks.keys()) {
          if (number > reorg.ancestor.number) {
            canonicalStore.blocks.delete(number);
          }
        }
        checkpoints.values.set('pairs', {
          blockNumber: reorg.ancestor.number,
          blockHash: reorg.ancestor.hash,
        });
        return {
          depth: reorg.depth,
          orphanedEvents: 0,
          replayedEvents: 0,
        };
      }),
  };
  const subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
    runtimeBarrier: barrier,
  });
  const first = subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => true,
  });
  await rollbackStarted.promise;
  let processCalls = 0;

  const second = subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => {
      processCalls += 1;
      return true;
    },
  });
  await flushPromises();

  assert.equal(processCalls, 0);
  rollbackGate.resolve();
  await Promise.all([first, second]);
  assert.equal(processCalls, 1);
});

test('fait passer processChunk par la barrière listener', async () => {
  const barrier = new RuntimeRecoveryBarrier();
  const recoveryStarted = deferred();
  const recoveryGate = deferred();
  const recovery = barrier.runRecovery(async () => {
    recoveryStarted.resolve();
    await recoveryGate.promise;
  });
  await recoveryStarted.promise;
  let processCalls = 0;
  const canonicalStore = new MemoryCanonicalStore();
  const journalSaveStarted = deferred();
  const journalSaveGate = deferred();
  const saveCanonicalBlocks =
    canonicalStore.saveCanonicalBlocks.bind(canonicalStore);
  canonicalStore.saveCanonicalBlocks = async (headers) => {
    journalSaveStarted.resolve();
    await journalSaveGate.promise;
    await saveCanonicalBlocks(headers);
  };
  const subject = coordinator(
    new MemoryBlockReader(20n),
    canonicalStore,
    new MemoryCheckpoints(),
    {
      runtimeBarrier: barrier,
      headerSpoolFactory: memoryHeaderSpoolFactory,
    },
  );

  const reconciliation = subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 10n,
    processChunk: async () => {
      processCalls += 1;
      return true;
    },
  });
  await journalSaveStarted.promise;
  journalSaveGate.resolve();
  await flushPromises();

  assert.equal(processCalls, 0);
  recoveryGate.resolve();
  await Promise.all([recovery, reconciliation]);
  assert.equal(processCalls, 1);
});

test('waitForIdle attend la fin d’un processChunk ouvert', async () => {
  const barrier = new RuntimeRecoveryBarrier();
  const chunkStarted = deferred();
  const chunkGate = deferred();
  const subject = coordinator(
    new MemoryBlockReader(20n),
    new MemoryCanonicalStore(),
    new MemoryCheckpoints(),
    { runtimeBarrier: barrier },
  );
  const reconciliation = subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 10n,
    processChunk: async () => {
      chunkStarted.resolve();
      await chunkGate.promise;
      return true;
    },
  });
  await chunkStarted.promise;
  let idle = false;
  const shutdown = subject.waitForIdle().then(() => {
    idle = true;
  });
  await flushPromises();

  assert.equal(idle, false);
  chunkGate.resolve();
  await Promise.all([reconciliation, shutdown]);
  assert.equal(idle, true);
});

test('autorise seulement les reconciles nested du post-reorg sans ouvrir la queue externe', async () => {
  const nestedGate = deferred();
  const hookGate = deferred();
  const afterReorgStarted = deferred();
  const nestedStarted = deferred();
  const nestedFinished = deferred();
  const escapedGate = deferred();
  let escapedRun: Promise<void> | null = null;
  let nestedCalls = 0;
  let externalCalls = 0;
  let escapedCalls = 0;
  const reader = new MemoryBlockReader(115n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) =>
    number > 106n
      ? forkedBlock(number, 106n)
      : originalGetBlock(number);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 110n,
    blockHash: block(110n).hash,
  });
  const reorgHandler: CanonicalReorgHandler = {
    reconcileReorg: async (reorg) => {
      if (!reorg.ancestor) assert.fail('ancêtre shallow attendu');
      for (const number of canonicalStore.blocks.keys()) {
        if (number > reorg.ancestor.number) {
          canonicalStore.blocks.delete(number);
        }
      }
      checkpoints.values.set('pairs', {
        blockNumber: reorg.ancestor.number,
        blockHash: reorg.ancestor.hash,
      });
      return {
        depth: reorg.depth,
        orphanedEvents: 0,
        replayedEvents: 0,
      };
    },
  };
  let subject: CanonicalChainCoordinator;
  subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
    headerSpoolFactory: memoryHeaderSpoolFactory,
    afterReorg: async () => {
      afterReorgStarted.resolve();
      escapedRun = (async () => {
        await escapedGate.promise;
        await subject.reconcile({
          listenerKey: 'escaped',
          startBlock: 107n,
          processChunk: async () => {
            escapedCalls += 1;
            return true;
          },
        });
      })();
      await subject.reconcile({
        listenerKey: 'nested-swap-listener',
        startBlock: 107n,
        processChunk: async () => {
          nestedCalls += 1;
          nestedStarted.resolve();
          await nestedGate.promise;
          return true;
        },
      });
      nestedFinished.resolve();
      await hookGate.promise;
      const current = subject.currentStatus.lastReorg;
      assert.ok(current);
      return {
        identity: `${current.oldTip.hash.toLowerCase()}:${current.newTip.hash.toLowerCase()}`,
        reorgId: 'nested',
        replayedEvents: 0,
      };
    },
  });

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => true,
  });
  await afterReorgStarted.promise;
  const external = subject.reconcile({
    listenerKey: 'external',
    startBlock: 107n,
    processChunk: async () => {
      externalCalls += 1;
      return true;
    },
  });
  let idle = false;
  const idleRun = subject.waitForIdle().then(() => {
    idle = true;
  });
  const nestedEntered = await Promise.race([
    nestedStarted.promise.then(() => true),
    (async () => {
      await flushPromises();
      await flushPromises();
      return false;
    })(),
  ]);

  assert.equal(nestedEntered, true);
  assert.equal(externalCalls, 0);
  assert.equal(idle, false);
  assert.equal(subject.currentStatus.running, true);
  assert.equal(subject.currentStatus.pendingRequests, 2);
  nestedGate.resolve();
  await nestedFinished.promise;
  await flushPromises();
  assert.equal(externalCalls, 0);
  assert.equal(idle, false);
  assert.equal(subject.currentStatus.running, false);
  assert.equal(subject.currentStatus.pendingRequests, 1);
  hookGate.resolve();
  await Promise.all([external, idleRun]);
  assert.equal(externalCalls, 1);
  assert.equal(idle, true);

  const blockerGate = deferred();
  const blockerStarted = deferred();
  const blocker = subject.reconcile({
    listenerKey: 'blocker',
    startBlock: 107n,
    processChunk: async () => {
      blockerStarted.resolve();
      await blockerGate.promise;
      return true;
    },
  });
  await blockerStarted.promise;
  escapedGate.resolve();
  await flushPromises();
  await flushPromises();
  assert.equal(escapedCalls, 0);
  assert.equal(subject.currentStatus.running, true);
  assert.equal(subject.currentStatus.pendingRequests, 2);
  blockerGate.resolve();
  await Promise.all([blocker, escapedRun]);
  assert.equal(escapedCalls, 1);
  await subject.waitForIdle();
  assert.equal(subject.currentStatus.running, false);
  assert.equal(subject.currentStatus.pendingRequests, 0);
});

test('afterReorg draine un reconcile inline non awaité avant waitForIdle', async () => {
  const chunkGate = deferred();
  const chunkStarted = deferred();
  const failureReached = deferred();
  const reader = new MemoryBlockReader(115n);
  const originalGetBlock = reader.getBlock.bind(reader);
  reader.getBlock = async (number) =>
    number > 106n
      ? forkedBlock(number, 106n)
      : originalGetBlock(number);
  const canonicalStore = new MemoryCanonicalStore(
    Array.from({ length: 11 }, (_, index) => block(BigInt(100 + index))),
  );
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 110n,
    blockHash: block(110n).hash,
  });
  let subject: CanonicalChainCoordinator;
  subject = coordinator(reader, canonicalStore, checkpoints, {
    headerSpoolFactory: memoryHeaderSpoolFactory,
    reorgHandler: {
      reconcileReorg: async (reorg) => {
        if (!reorg.ancestor) assert.fail('ancêtre shallow attendu');
        for (const number of canonicalStore.blocks.keys()) {
          if (number > reorg.ancestor.number) {
            canonicalStore.blocks.delete(number);
          }
        }
        checkpoints.values.set('pairs', {
          blockNumber: reorg.ancestor.number,
          blockHash: reorg.ancestor.hash,
        });
        return {
          depth: reorg.depth,
          orphanedEvents: 0,
          replayedEvents: 0,
        };
      },
    },
    afterReorg: async () => {
      void subject.reconcile({
        listenerKey: 'unawaited-swap',
        startBlock: 107n,
        processChunk: async () => {
          chunkStarted.resolve();
          await chunkGate.promise;
          failureReached.resolve();
          throw new Error('nested unawaited failed');
        },
      });
    },
  });

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 100n,
    processChunk: async () => true,
  });
  await chunkStarted.promise;
  let idle = false;
  const idleRun = subject.waitForIdle().then(() => {
    idle = true;
  });
  await flushPromises();
  const idleBeforeRelease = idle;
  chunkGate.resolve();
  await failureReached.promise;
  await idleRun;
  await flushPromises();

  assert.equal(idleBeforeRelease, false);
  assert.equal(subject.currentStatus.state, 'RECONCILING');
  assert.equal(subject.currentStatus.pendingRequests, 0);
  assert.equal(subject.currentStatus.running, false);
});

test('ne déduit aucun reorg lorsque le tip stocké dépasse le head confirmé', async () => {
  const reader = new MemoryBlockReader(110n);
  const canonicalStore = new MemoryCanonicalStore([block(110n)]);
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 100n,
    blockHash: block(100n).hash,
  });
  const reorgHandler = new MemoryReorgHandler();
  const subject = coordinator(reader, canonicalStore, checkpoints, {
    reorgHandler,
  });
  let processCalls = 0;

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 1n,
    processChunk: async () => {
      processCalls += 1;
      return true;
    },
  });

  assert.equal(processCalls, 0);
  assert.equal(reorgHandler.calls.length, 0);
  assert.deepEqual(reader.reads, []);
  assert.deepEqual(canonicalStore.saves, []);
  assert.deepEqual(canonicalStore.pruneCalls, []);
  assert.deepEqual(checkpoints.writes, []);
});
