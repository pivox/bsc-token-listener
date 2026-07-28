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
  failAt: bigint | null = null;

  constructor(readonly latest: bigint) {}

  async getBlockNumber(): Promise<bigint> {
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
    reorgHandler?: CanonicalReorgHandler;
  } = {},
): CanonicalChainCoordinator {
  return new CanonicalChainCoordinator({
    blockReader: reader,
    canonicalStore,
    checkpoints,
    reorgHandler: options.reorgHandler ?? new MemoryReorgHandler(),
    confirmations: options.confirmations ?? 5,
    ...(options.chunkSize === undefined
      ? {}
      : { chunkSize: options.chunkSize }),
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

  assert.deepEqual(ranges, [[10n, 15n]]);
  assert.deepEqual(checkpoints.values.get('pairs'), {
    blockNumber: 15n,
    blockHash: hash(16n),
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
  reader.getBlock = async (number) =>
    number <= 110n
      ? forkedBlock(number, 106n, 10_000n)
      : forkedBlock(number, 106n, 20_000n);
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
  assert.equal(reorgHandler.calls[0]?.depth, 4);
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
