import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import type {
  AnchoredListenerCheckpoint,
  CanonicalBlock,
  ConfirmedRangeRequest,
  ListenerCheckpoint,
} from '../src/chain/canonical-chain.types.js';
import {
  SwapLogBatchReconciler,
  type SwapLogBatchTarget,
} from '../src/monitoring/swap-log-batch-reconciler.js';

function address(index: number): Address {
  return `0x${index.toString(16).padStart(40, '0')}` as Address;
}

function hash(index: bigint): Hash {
  return `0x${index.toString(16).padStart(64, '0')}` as Hash;
}

function headers(fromBlock: bigint, toBlock: bigint): CanonicalBlock[] {
  const result: CanonicalBlock[] = [];
  for (let blockNumber = fromBlock; blockNumber <= toBlock; blockNumber += 1n) {
    result.push({
      number: blockNumber,
      hash: hash(blockNumber),
      parentHash: hash(blockNumber === 0n ? 0n : blockNumber - 1n),
    });
  }
  return result;
}

function swapLog(input: {
  pair: Address;
  blockNumber: bigint;
  transactionIndex?: number;
  logIndex?: number;
  transactionHash?: Hash;
  blockHash?: Hash;
}): Record<string, unknown> {
  return {
    address: input.pair,
    args: {
      sender: address(9_001),
      to: address(9_002),
      amount0In: 0n,
      amount1In: 1n,
      amount0Out: 2n,
      amount1Out: 0n,
    },
    blockNumber: input.blockNumber,
    blockHash: input.blockHash ?? hash(input.blockNumber),
    transactionHash: input.transactionHash ?? hash(input.blockNumber * 1_000n + BigInt(input.logIndex ?? 0)),
    transactionIndex: input.transactionIndex ?? 0,
    logIndex: input.logIndex ?? 0,
  };
}

class MemoryCoordinator {
  readonly requests: ConfirmedRangeRequest[] = [];

  constructor(
    private readonly head: bigint,
    private readonly chunkSize: bigint,
  ) {}

  async reconcile(request: ConfirmedRangeRequest): Promise<void> {
    this.requests.push(request);
    let fromBlock = request.checkpoint
      ? request.checkpoint.blockNumber + 1n
      : request.startBlock;
    while (fromBlock <= this.head) {
      const toBlock = fromBlock + this.chunkSize - 1n < this.head
        ? fromBlock + this.chunkSize - 1n
        : this.head;
      const processed = await request.processChunk(
        fromBlock,
        toBlock,
        headers(fromBlock, toBlock),
      );
      if (!processed) return;
      fromBlock = toBlock + 1n;
    }
  }
}

interface CheckpointWrite {
  key: string;
  checkpoint: AnchoredListenerCheckpoint;
}

class MemoryCheckpoints {
  readonly values = new Map<string, ListenerCheckpoint>();
  readonly commits: CheckpointWrite[][] = [];
  failWrites = false;

  async getMany(keys: readonly string[]): Promise<Map<string, ListenerCheckpoint>> {
    return new Map(
      keys.flatMap((key) => {
        const checkpoint = this.values.get(key);
        return checkpoint ? [[key, structuredClone(checkpoint)] as const] : [];
      }),
    );
  }

  async setManyAtomically(writes: readonly CheckpointWrite[]): Promise<void> {
    if (this.failWrites) throw new Error('checkpoint transaction failed');
    const committed = writes.map((write) => structuredClone(write));
    for (const write of committed) this.values.set(write.key, write.checkpoint);
    this.commits.push(committed);
  }
}

interface LogRead {
  address: readonly Address[];
  fromBlock: bigint;
  toBlock: bigint;
}

class MemoryLogReader {
  readonly calls: LogRead[] = [];
  onRead: (request: LogRead, callIndex: number) => Promise<readonly unknown[]> =
    async () => [];

  async getContractEvents(request: LogRead): Promise<readonly unknown[]> {
    const copy = {
      address: [...request.address],
      fromBlock: request.fromBlock,
      toBlock: request.toBlock,
    };
    this.calls.push(copy);
    return this.onRead(copy, this.calls.length - 1);
  }
}

class MemoryTarget implements SwapLogBatchTarget {
  readonly pairKey: string;
  active = true;
  calls = 0;
  readonly processed: Array<{ blockNumber: bigint; logIndex: number }> = [];
  onProcess: ((log: Record<string, unknown>) => Promise<boolean>) | undefined;

  constructor(
    readonly pair: Address,
    readonly createdBlock: bigint = 1n,
  ) {
    this.pairKey = `swap:${pair.toLowerCase()}`;
  }

  isReconcileCapable(): boolean {
    return this.active;
  }

  async reconcileChunk(
    _fromBlock: bigint,
    _toBlock: bigint,
    _canonicalHeaders: readonly CanonicalBlock[],
    logs: readonly unknown[],
  ): Promise<boolean> {
    this.calls += 1;
    const log = logs[0] as Record<string, unknown>;
    this.processed.push({
      blockNumber: log.blockNumber as bigint,
      logIndex: log.logIndex as number,
    });
    return this.onProcess ? this.onProcess(log) : true;
  }
}

function createSubject(input: {
  targets: readonly MemoryTarget[];
  head?: bigint;
  chunkSize?: bigint;
  batchSize?: number;
  checkpoints?: MemoryCheckpoints;
  reader?: MemoryLogReader;
}) {
  const checkpoints = input.checkpoints ?? new MemoryCheckpoints();
  const reader = input.reader ?? new MemoryLogReader();
  const coordinator = new MemoryCoordinator(
    input.head ?? 1n,
    input.chunkSize ?? 100n,
  );
  const subject = new SwapLogBatchReconciler({
    coordinator,
    checkpoints,
    logReader: reader,
    maxAddressesPerBatch: input.batchSize ?? 20,
  });
  return { subject, coordinator, checkpoints, reader };
}

for (const fixture of [
  { pairs: 0, batchSize: 20, expectedCalls: 0 },
  { pairs: 1, batchSize: 20, expectedCalls: 1 },
  { pairs: 10, batchSize: 20, expectedCalls: 1 },
  { pairs: 50, batchSize: 20, expectedCalls: 3 },
  { pairs: 50, batchSize: 10, expectedCalls: 5 },
]) {
  test(`${fixture.pairs} paires avec lot ${fixture.batchSize} produit ${fixture.expectedCalls} eth_getLogs par chunk`, async () => {
    const targets = Array.from(
      { length: fixture.pairs },
      (_, index) => new MemoryTarget(address(index + 1)),
    );
    const { subject, reader, coordinator } = createSubject({
      targets,
      batchSize: fixture.batchSize,
    });

    await subject.reconcile(targets);

    assert.equal(reader.calls.length, fixture.expectedCalls);
    assert.equal(coordinator.requests.length, fixture.pairs === 0 ? 0 : 1);
  });
}

test('50 paires sur trois chunks respectent explicitement appels = chunks x lots', async () => {
  const targets = Array.from({ length: 50 }, (_, index) =>
    new MemoryTarget(address(index + 1)));
  const { subject, reader } = createSubject({
    targets,
    head: 250n,
    chunkSize: 100n,
    batchSize: 20,
  });

  await subject.reconcile(targets);

  assert.equal(reader.calls.length, 3 * 3);
  assert.deepEqual(
    [...new Set(reader.calls.map(({ fromBlock, toBlock }) => `${fromBlock}-${toBlock}`))],
    ['1-100', '101-200', '201-250'],
  );
  assert.equal(
    reader.calls.every(({ fromBlock, toBlock }) => toBlock - fromBlock + 1n <= 100n),
    true,
  );
});

test('filtre chaque paire depuis son checkpoint ou son createdBlock', async () => {
  const pairA = new MemoryTarget(address(1), 1n);
  const pairB = new MemoryTarget(address(2), 1n);
  const pairC = new MemoryTarget(address(3), 120n);
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set(pairA.pairKey, { blockNumber: 100n, blockHash: hash(100n) });
  checkpoints.values.set(pairB.pairKey, { blockNumber: 140n, blockHash: hash(140n) });
  const reader = new MemoryLogReader();
  const logs = [
    swapLog({ pair: pairA.pair, blockNumber: 100n, logIndex: 0 }),
    swapLog({ pair: pairA.pair, blockNumber: 101n, logIndex: 1 }),
    swapLog({ pair: pairB.pair, blockNumber: 140n, logIndex: 2 }),
    swapLog({ pair: pairB.pair, blockNumber: 141n, logIndex: 3 }),
    swapLog({ pair: pairC.pair, blockNumber: 119n, logIndex: 4 }),
    swapLog({ pair: pairC.pair, blockNumber: 120n, logIndex: 5 }),
  ];
  reader.onRead = async (request) => logs.filter((entry) => {
    const log = entry as { address: Address; blockNumber: bigint };
    return request.address.includes(log.address)
      && log.blockNumber >= request.fromBlock
      && log.blockNumber <= request.toBlock;
  });
  const { subject } = createSubject({
    targets: [pairA, pairB, pairC],
    head: 150n,
    checkpoints,
    reader,
  });

  await subject.reconcile([pairA, pairB, pairC]);

  assert.deepEqual(pairA.processed.map(({ blockNumber }) => blockNumber), [101n]);
  assert.deepEqual(pairB.processed.map(({ blockNumber }) => blockNumber), [141n]);
  assert.deepEqual(pairC.processed.map(({ blockNumber }) => blockNumber), [120n]);
  assert.equal(checkpoints.values.get(pairA.pairKey)?.blockNumber, 150n);
  assert.equal(checkpoints.values.get(pairB.pairKey)?.blockNumber, 150n);
  assert.equal(checkpoints.values.get(pairC.pairKey)?.blockNumber, 150n);
});

test('valide tous les lots puis trie globalement plusieurs paires dans une transaction', async () => {
  const pairA = new MemoryTarget(address(1));
  const pairB = new MemoryTarget(address(2));
  const order: string[] = [];
  pairA.onProcess = async (log) => { order.push(`A:${String(log.logIndex)}`); return true; };
  pairB.onProcess = async (log) => { order.push(`B:${String(log.logIndex)}`); return true; };
  const reader = new MemoryLogReader();
  const transactionHash = hash(777n);
  reader.onRead = async (request) => request.address.includes(pairA.pair)
    ? [swapLog({ pair: pairA.pair, blockNumber: 1n, transactionIndex: 2, logIndex: 3 })]
    : [
        swapLog({ pair: pairB.pair, blockNumber: 1n, transactionHash, transactionIndex: 1, logIndex: 2 }),
        swapLog({ pair: pairB.pair, blockNumber: 1n, transactionHash, transactionIndex: 1, logIndex: 0 }),
      ];
  const { subject } = createSubject({
    targets: [pairA, pairB],
    batchSize: 1,
    reader,
  });

  await subject.reconcile([pairA, pairB]);

  assert.deepEqual(order, ['B:0', 'B:2', 'A:3']);
});

test('un log dupliqué identique ne produit qu’une décision métier', async () => {
  const target = new MemoryTarget(address(1));
  const reader = new MemoryLogReader();
  const log = swapLog({ pair: target.pair, blockNumber: 1n, logIndex: 4 });
  reader.onRead = async () => [log, structuredClone(log)];
  const { subject } = createSubject({ targets: [target], reader });

  await subject.reconcile([target]);

  assert.equal(target.calls, 1);
});

for (const fixture of [
  {
    name: 'adresse inconnue',
    mutate: (log: Record<string, unknown>) => ({ ...log, address: address(999) }),
    pattern: /adresse inconnue/u,
  },
  {
    name: 'blockHash incohérent',
    mutate: (log: Record<string, unknown>) => ({ ...log, blockHash: hash(999n) }),
    pattern: /header canonique/u,
  },
  {
    name: 'réponse partielle sans logIndex',
    mutate: (log: Record<string, unknown>) => ({ ...log, logIndex: null }),
    pattern: /logIndex/u,
  },
]) {
  test(`${fixture.name} échoue sans avancer le checkpoint`, async () => {
    const target = new MemoryTarget(address(1));
    const reader = new MemoryLogReader();
    reader.onRead = async () => [
      fixture.mutate(swapLog({ pair: target.pair, blockNumber: 1n })),
    ];
    const { subject, checkpoints } = createSubject({ targets: [target], reader });

    await assert.rejects(subject.reconcile([target]), fixture.pattern);

    assert.equal(checkpoints.values.size, 0);
    assert.equal(target.calls, 0);
  });
}

for (const fixture of [
  { name: 'erreur du deuxième lot', failingCall: 1, error: new Error('lot 2 failed') },
  { name: 'timeout du dernier lot', failingCall: 2, error: new Error('timeout lot 3') },
]) {
  test(`${fixture.name} attend tous les lots et ne commit aucun checkpoint`, async () => {
    const targets = [new MemoryTarget(address(1)), new MemoryTarget(address(2)), new MemoryTarget(address(3))];
    const reader = new MemoryLogReader();
    reader.onRead = async (_request, callIndex) => {
      if (callIndex === fixture.failingCall) throw fixture.error;
      return [];
    };
    const { subject, checkpoints } = createSubject({
      targets,
      batchSize: 1,
      reader,
    });

    await assert.rejects(subject.reconcile(targets), (error) => error === fixture.error);

    assert.equal(reader.calls.length, 3);
    assert.equal(checkpoints.values.size, 0);
  });
}

test('un échec métier d’une paire empêche tous les checkpoints du chunk', async () => {
  const pairA = new MemoryTarget(address(1));
  const pairB = new MemoryTarget(address(2));
  pairB.onProcess = async () => { throw new Error('business failed'); };
  const reader = new MemoryLogReader();
  reader.onRead = async (request) => request.address.map((pair, index) =>
    swapLog({ pair, blockNumber: 1n, logIndex: index }));
  const { subject, checkpoints } = createSubject({
    targets: [pairA, pairB],
    reader,
  });

  await assert.rejects(subject.reconcile([pairA, pairB]), /business failed/u);

  assert.equal(checkpoints.values.size, 0);
});

test('un retrait pendant le traitement bloque le listener retiré et tous les checkpoints', async () => {
  const pairA = new MemoryTarget(address(1));
  const pairB = new MemoryTarget(address(2));
  pairA.onProcess = async () => { pairB.active = false; return true; };
  const reader = new MemoryLogReader();
  reader.onRead = async () => [
    swapLog({ pair: pairA.pair, blockNumber: 1n, logIndex: 0 }),
    swapLog({ pair: pairB.pair, blockNumber: 1n, logIndex: 1 }),
  ];
  const { subject, checkpoints } = createSubject({ targets: [pairA, pairB], reader });

  await assert.rejects(subject.reconcile([pairA, pairB]), /retirée|arrêtée/u);

  assert.equal(pairB.calls, 0);
  assert.equal(checkpoints.values.size, 0);
});

test('une paire ajoutée pendant le scan rejoint seulement la passe suivante', async () => {
  const pairA = new MemoryTarget(address(1));
  const pairB = new MemoryTarget(address(2));
  const activeTargets: MemoryTarget[] = [pairA];
  pairA.onProcess = async () => { activeTargets.push(pairB); return true; };
  const reader = new MemoryLogReader();
  reader.onRead = async (request) => request.address.map((pair, index) =>
    swapLog({ pair, blockNumber: 1n, logIndex: index }));
  const { subject } = createSubject({ targets: activeTargets, reader });

  await subject.reconcile(activeTargets);
  assert.equal(pairA.calls, 1);
  assert.equal(pairB.calls, 0);
  assert.deepEqual(reader.calls[0]?.address, [pairA.pair]);

  await subject.reconcile(activeTargets);
  assert.equal(pairB.calls, 1);
});

test('un succès commit tous les checkpoints en une seule opération atomique', async () => {
  const targets = [new MemoryTarget(address(1)), new MemoryTarget(address(2)), new MemoryTarget(address(3))];
  const { subject, checkpoints } = createSubject({ targets, head: 50n });

  await subject.reconcile(targets);

  assert.equal(checkpoints.commits.length, 1);
  assert.deepEqual(
    checkpoints.commits[0]?.map(({ key, checkpoint }) => [key, checkpoint.blockNumber]),
    targets.map((target) => [target.pairKey, 50n]),
  );
});

test('un échec de transaction ne laisse aucun checkpoint partiellement avancé', async () => {
  const targets = [new MemoryTarget(address(1)), new MemoryTarget(address(2))];
  const checkpoints = new MemoryCheckpoints();
  checkpoints.failWrites = true;
  const { subject } = createSubject({ targets, checkpoints });

  await assert.rejects(subject.reconcile(targets), /checkpoint transaction failed/u);

  assert.equal(checkpoints.values.size, 0);
});

test('le retry repart exactement du premier bloc non validé', async () => {
  const targets = [new MemoryTarget(address(1)), new MemoryTarget(address(2))];
  const reader = new MemoryLogReader();
  let fail = true;
  reader.onRead = async (_request, callIndex) => {
    if (fail && callIndex % 2 === 1) throw new Error('lot failed');
    return [];
  };
  const { subject, checkpoints } = createSubject({
    targets,
    head: 150n,
    chunkSize: 100n,
    batchSize: 1,
    reader,
  });

  await assert.rejects(subject.reconcile(targets), /lot failed/u);
  assert.equal(checkpoints.values.size, 0);
  fail = false;
  const retryStart = reader.calls.length;

  await subject.reconcile(targets);

  assert.equal(reader.calls[retryStart]?.fromBlock, 1n);
  assert.equal(checkpoints.values.get(targets[0]!.pairKey)?.blockNumber, 150n);
  assert.equal(checkpoints.values.get(targets[1]!.pairKey)?.blockNumber, 150n);
});

test('les frontières de chunks ne perdent ni ne doublent les événements', async () => {
  const target = new MemoryTarget(address(1));
  const allLogs = [
    swapLog({ pair: target.pair, blockNumber: 100n, logIndex: 0 }),
    swapLog({ pair: target.pair, blockNumber: 101n, logIndex: 1 }),
    swapLog({ pair: target.pair, blockNumber: 200n, logIndex: 2 }),
    swapLog({ pair: target.pair, blockNumber: 201n, logIndex: 3 }),
    swapLog({ pair: target.pair, blockNumber: 250n, logIndex: 4 }),
  ];
  const reader = new MemoryLogReader();
  reader.onRead = async (request) => allLogs.filter((entry) => {
    const blockNumber = (entry as { blockNumber: bigint }).blockNumber;
    return blockNumber >= request.fromBlock && blockNumber <= request.toBlock;
  });
  const { subject } = createSubject({
    targets: [target],
    head: 250n,
    chunkSize: 100n,
    reader,
  });

  await subject.reconcile([target]);

  assert.deepEqual(
    target.processed.map(({ blockNumber }) => blockNumber),
    [100n, 101n, 200n, 201n, 250n],
  );
});
