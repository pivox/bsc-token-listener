import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import type {
  CanonicalBlock,
  ConfirmedRangeRequest,
} from '../src/chain/canonical-chain.types.js';
import { config } from '../src/config/env.js';
import { PairCreatedListener } from '../src/listeners/pair-created.listener.js';
import { SwapListener } from '../src/listeners/swap.listener.js';
import type {
  PairInfo,
  SwapEvent,
  TokenSession,
} from '../src/types/domain.js';

const ADDRESS_1 = `0x${'1'.repeat(40)}` as Address;
const ADDRESS_2 = `0x${'2'.repeat(40)}` as Address;
const ADDRESS_3 = `0x${'3'.repeat(40)}` as Address;
const HASH_1 = `0x${'1'.repeat(64)}` as Hash;
const HASH_2 = `0x${'2'.repeat(64)}` as Hash;
const HASH_3 = `0x${'3'.repeat(64)}` as Hash;

function canonicalHeaders(
  ...entries: readonly [bigint, Hash][]
): CanonicalBlock[] {
  return entries.map(([number, hash]) => ({
    number,
    hash,
    parentHash: hash,
  }));
}

interface WatchOptions {
  onLogs(logs: readonly unknown[]): void;
  onError(error: unknown): void;
}

class MemoryWatcher {
  options: WatchOptions | undefined;
  stopped = false;

  watchContractEvent(options: WatchOptions): () => void {
    this.options = options;
    return () => {
      this.stopped = true;
    };
  }
}

class MemoryCoordinator {
  readonly requests: ConfirmedRangeRequest[] = [];
  onReconcile: (
    request: ConfirmedRangeRequest,
  ) => Promise<void> = async () => {};

  async reconcile(request: ConfirmedRangeRequest): Promise<void> {
    this.requests.push(request);
    await this.onReconcile(request);
  }
}

function pairLog(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    args: {
      token0: config.wbnb,
      token1: ADDRESS_1,
      pair: ADDRESS_2,
    },
    blockNumber: 10n,
    blockHash: HASH_1,
    transactionHash: HASH_2,
    transactionIndex: 1,
    logIndex: 2,
    ...overrides,
  };
}

function pairInfo(): PairInfo {
  return {
    factory: config.factory,
    router: config.router,
    wbnb: config.wbnb,
    pair: ADDRESS_2,
    token: ADDRESS_1,
    token0: ADDRESS_1,
    token1: config.wbnb,
    createdBlock: 7n,
    blockHash: HASH_1,
    createdTransactionHash: HASH_2,
    createdLogIndex: 0,
    discoveredAtMs: 1,
  };
}

function tokenSession(): TokenSession {
  return {
    pair: pairInfo(),
    metadata: {
      address: ADDRESS_1,
      name: null,
      symbol: null,
      decimals: 18,
      totalSupply: 1n,
      codeSizeBytes: 1,
    },
    status: 'WAITING_FIRST_BUY',
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function swapLog(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    args: {
      sender: ADDRESS_1,
      to: ADDRESS_3,
      amount0In: 0n,
      amount1In: 10n,
      amount0Out: 100n,
      amount1Out: 0n,
    },
    blockNumber: 12n,
    blockHash: HASH_2,
    transactionHash: HASH_3,
    transactionIndex: 1,
    logIndex: 2,
    ...overrides,
  };
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('PairCreated délègue la plage confirmée et ne traite que les logs HTTP ordonnés', async () => {
  const watcher = new MemoryWatcher();
  const coordinator = new MemoryCoordinator();
  const reads: Array<{ fromBlock: bigint; toBlock: bigint }> = [];
  const discovered: PairInfo[] = [];
  const logReader = {
    getContractEvents: async (
      request: { fromBlock: bigint; toBlock: bigint },
    ) => {
      reads.push(request);
      return [
        pairLog({ blockNumber: 11n, blockHash: HASH_3, logIndex: 3 }),
        pairLog({ blockNumber: 10n, blockHash: HASH_1, logIndex: 4 }),
      ];
    },
  };
  coordinator.onReconcile = async (request) => {
    assert.equal(await request.processChunk(
      10n,
      11n,
      canonicalHeaders([10n, HASH_1], [11n, HASH_3]),
    ), true);
  };
  const subject = new PairCreatedListener(
    async (pair) => {
      discovered.push(pair);
    },
    {
      watcher,
      logReader,
      coordinator,
      reconcileIntervalMs: 60_000,
    },
  );

  await subject.start();
  subject.stop();

  assert.equal(coordinator.requests[0]?.listenerKey, 'pair-created');
  assert.equal(coordinator.requests[0]?.startBlock, 0n);
  assert.equal(coordinator.requests[0]?.bootstrap, 'confirmed-head');
  assert.deepEqual(
    reads.map(({ fromBlock, toBlock }) => ({ fromBlock, toBlock })),
    [{ fromBlock: 10n, toBlock: 11n }],
  );
  assert.deepEqual(
    discovered.map((pair) => [pair.createdBlock, pair.blockHash]),
    [[10n, HASH_1], [11n, HASH_3]],
  );
});

test('PairCreated peut rejouer au démarrage avant d’activer le watcher', async () => {
  const watcher = new MemoryWatcher();
  const coordinator = new MemoryCoordinator();
  const subject = new PairCreatedListener(
    async () => {},
    {
      watcher,
      logReader: { getContractEvents: async () => [] },
      coordinator,
      reconcileIntervalMs: 60_000,
    },
  );

  await subject.reconcileNow();

  assert.equal(coordinator.requests.length, 1);
  assert.equal(watcher.options, undefined);
  subject.stop();
});

test('Swap prépare le watcher muet pendant un replay hydraté puis ne l’active qu’après recovery', async () => {
  const watcher = new MemoryWatcher();
  const coordinator = new MemoryCoordinator();
  const signaled: string[] = [];
  const subject = new SwapListener(
    tokenSession(),
    {
      onSwap: async () => true,
      expireIfNeeded: async () => false,
      isTerminal: () => false,
    },
    () => {},
    {
      watcher,
      logReader: { getContractEvents: async () => [] },
      coordinator,
      requestReconcile: (pair) => signaled.push(pair),
      reconcileIntervalMs: 60_000,
    },
  );
  const replay = subject as unknown as {
    startForReplay(): Promise<void>;
    activateAfterReplay(): void;
  };

  await replay.startForReplay();
  assert.equal(coordinator.requests.length, 0);
  assert.equal(signaled.length, 1);
  watcher.options?.onLogs([]);
  await turn();
  assert.equal(signaled.length, 1);

  replay.activateAfterReplay();
  watcher.options?.onLogs([]);
  await turn();
  assert.equal(signaled.length, 3);
  assert.equal(coordinator.requests.length, 0);
  subject.stop();
});

test('PairCreated ignore le payload WebSocket et coalesce les demandes pendant un reconcile', async () => {
  const watcher = new MemoryWatcher();
  const coordinator = new MemoryCoordinator();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  coordinator.onReconcile = async () => {
    if (coordinator.requests.length === 1) await blocked;
  };
  const discovered: PairInfo[] = [];
  const subject = new PairCreatedListener(
    async (pair) => {
      discovered.push(pair);
    },
    {
      watcher,
      logReader: {
        getContractEvents: async () => {
          throw new Error('le lecteur HTTP ne doit pas être appelé ici');
        },
      },
      coordinator,
      reconcileIntervalMs: 60_000,
    },
  );

  const starting = subject.start();
  await turn();
  watcher.options?.onLogs([pairLog()]);
  watcher.options?.onLogs([pairLog()]);
  assert.equal(coordinator.requests.length, 1);
  assert.deepEqual(discovered, []);

  release();
  await starting;
  await turn();
  subject.stop();

  assert.equal(coordinator.requests.length, 2);
  assert.deepEqual(discovered, []);
});

test('PairCreated honore la demande coalescée même si le reconcile courant échoue', async () => {
  const watcher = new MemoryWatcher();
  const coordinator = new MemoryCoordinator();
  const rpcError = new Error('RPC indisponible');
  let rejectFirst!: (error: Error) => void;
  const blocked = new Promise<void>((_resolve, reject) => {
    rejectFirst = reject;
  });
  coordinator.onReconcile = async () => {
    if (coordinator.requests.length === 1) await blocked;
  };
  const subject = new PairCreatedListener(
    async () => {},
    {
      watcher,
      logReader: { getContractEvents: async () => [] },
      coordinator,
      reconcileIntervalMs: 60_000,
    },
  );

  const starting = subject.start();
  await turn();
  watcher.options?.onLogs([]);
  rejectFirst(rpcError);

  await assert.rejects(starting, (error) => error === rpcError);
  await turn();
  subject.stop();
  assert.equal(coordinator.requests.length, 2);
});

for (const [field, value] of [
  ['blockNumber', null],
  ['blockHash', null],
  ['transactionHash', null],
  ['transactionIndex', null],
  ['logIndex', null],
] as const) {
  test(`PairCreated refuse un log HTTP décodable sans ${field} et ne complète pas le chunk`, async () => {
    const coordinator = new MemoryCoordinator();
    let completed = false;
    let discovered = 0;
    coordinator.onReconcile = async (request) => {
      await request.processChunk(
        10n,
        10n,
        canonicalHeaders([10n, HASH_1]),
      );
      completed = true;
    };
    const subject = new PairCreatedListener(
      async () => {
        discovered += 1;
      },
      {
        watcher: new MemoryWatcher(),
        logReader: {
          getContractEvents: async () => [
            pairLog({ [field]: value }),
          ],
        },
        coordinator,
        reconcileIntervalMs: 60_000,
      },
    );

    try {
      await assert.rejects(subject.start(), new RegExp(field, 'u'));
    } finally {
      subject.stop();
    }
    assert.equal(completed, false);
    assert.equal(discovered, 0);
  });
}

test('PairCreated valide toute la plage avant le premier callback métier', async () => {
  const coordinator = new MemoryCoordinator();
  let completed = false;
  let discovered = 0;
  coordinator.onReconcile = async (request) => {
    await request.processChunk(
      10n,
      11n,
      canonicalHeaders([10n, HASH_1], [11n, HASH_1]),
    );
    completed = true;
  };
  const subject = new PairCreatedListener(
    async () => {
      discovered += 1;
    },
    {
      watcher: new MemoryWatcher(),
      logReader: {
        getContractEvents: async () => [
          pairLog({ blockNumber: 10n, logIndex: 1 }),
          pairLog({ blockNumber: 11n, logIndex: null }),
        ],
      },
      coordinator,
      reconcileIntervalMs: 60_000,
    },
  );

  try {
    await assert.rejects(subject.start(), /logIndex/u);
  } finally {
    subject.stop();
  }
  assert.equal(completed, false);
  assert.equal(discovered, 0);
});

test('PairCreated refuse avant tout callback un log hors plage ou rattaché à un autre header canonique', async () => {
  for (const log of [
    pairLog({ blockNumber: 9n }),
    pairLog({ blockNumber: 10n, blockHash: HASH_3 }),
  ]) {
    const coordinator = new MemoryCoordinator();
    let discovered = 0;
    coordinator.onReconcile = async (request) => {
      const processChunk = request.processChunk as unknown as (
        fromBlock: bigint,
        toBlock: bigint,
        headers: readonly { number: bigint; hash: Hash }[],
      ) => Promise<boolean>;
      await processChunk(10n, 10n, [{ number: 10n, hash: HASH_1 }]);
    };
    const subject = new PairCreatedListener(
      async () => {
        discovered += 1;
      },
      {
        watcher: new MemoryWatcher(),
        logReader: { getContractEvents: async () => [log] },
        coordinator,
      },
    );

    await assert.rejects(subject.start(), /canonique|plage/u);
    subject.stop();
    assert.equal(discovered, 0);
  }
});

test('un échec du lecteur PairCreated fait échouer le chunk', async () => {
  const rpcError = new Error('RPC secrète https://user:password@example.test');
  const coordinator = new MemoryCoordinator();
  coordinator.onReconcile = async (request) => {
    await request.processChunk(
      10n,
      10n,
      canonicalHeaders([10n, HASH_1]),
    );
  };
  const subject = new PairCreatedListener(
    async () => {},
    {
      watcher: new MemoryWatcher(),
      logReader: {
        getContractEvents: async () => {
          throw rpcError;
        },
      },
      coordinator,
      reconcileIntervalMs: 60_000,
    },
  );

  await assert.rejects(subject.start(), (error) => error === rpcError);
  subject.stop();
});

test('Swap délègue la plage confirmée, ordonne les logs HTTP et conserve blockHash', async () => {
  const coordinator = new MemoryCoordinator();
  const events: SwapEvent[] = [];
  const engine = {
    onSwap: async (_session: TokenSession, event: SwapEvent) => {
      events.push(event);
      return true;
    },
    expireIfNeeded: async () => false,
    isTerminal: () => false,
    claim: () => {
      throw new Error('le listener ne doit pas claim');
    },
    markProcessed: () => {
      throw new Error('le listener ne doit pas marquer processed');
    },
    markFailed: () => {
      throw new Error('le listener ne doit pas marquer failed');
    },
  };
  coordinator.onReconcile = async (request) => {
    assert.equal(await request.processChunk(
      12n,
      13n,
      canonicalHeaders([12n, HASH_2], [13n, HASH_3]),
    ), true);
  };
  const subject = new SwapListener(
    tokenSession(),
    engine,
    () => {},
    {
      watcher: new MemoryWatcher(),
      logReader: {
        getContractEvents: async () => [
          swapLog({
            blockNumber: 13n,
            blockHash: HASH_3,
            transactionIndex: 0,
            logIndex: 1,
          }),
          swapLog({
            blockNumber: 12n,
            blockHash: HASH_2,
            transactionIndex: 2,
            logIndex: 3,
          }),
        ],
      },
      coordinator,
      reconcileIntervalMs: 60_000,
    },
  );

  await subject.start();
  subject.stop();

  assert.equal(
    coordinator.requests[0]?.listenerKey,
    `swap:${ADDRESS_2.toLowerCase()}`,
  );
  assert.equal(coordinator.requests[0]?.startBlock, 7n);
  assert.deepEqual(
    events.map((event) => [event.cursor.blockNumber, event.blockHash]),
    [[12n, HASH_2], [13n, HASH_3]],
  );
});

for (const [field, value] of [
  ['blockNumber', null],
  ['blockHash', null],
  ['transactionHash', null],
  ['transactionIndex', null],
  ['logIndex', null],
] as const) {
  test(`Swap refuse un log HTTP décodable sans ${field} et ne complète pas le chunk`, async () => {
    const coordinator = new MemoryCoordinator();
    let completed = false;
    let processed = 0;
    coordinator.onReconcile = async (request) => {
      await request.processChunk(
        12n,
        12n,
        canonicalHeaders([12n, HASH_2]),
      );
      completed = true;
    };
    const subject = new SwapListener(
      tokenSession(),
      {
        onSwap: async () => {
          processed += 1;
          return true;
        },
        expireIfNeeded: async () => false,
        isTerminal: () => false,
      },
      () => {},
      {
        watcher: new MemoryWatcher(),
        logReader: {
          getContractEvents: async () => [swapLog({ [field]: value })],
        },
        coordinator,
        reconcileIntervalMs: 60_000,
      },
    );

    try {
      await assert.rejects(subject.start(), new RegExp(field, 'u'));
    } finally {
      subject.stop();
    }
    assert.equal(completed, false);
    assert.equal(processed, 0);
  });
}

test('Swap valide toute la plage avant le premier appel moteur', async () => {
  const coordinator = new MemoryCoordinator();
  let completed = false;
  let processed = 0;
  coordinator.onReconcile = async (request) => {
    await request.processChunk(
      12n,
      13n,
      canonicalHeaders([12n, HASH_2], [13n, HASH_2]),
    );
    completed = true;
  };
  const subject = new SwapListener(
    tokenSession(),
    {
      onSwap: async () => {
        processed += 1;
        return true;
      },
      expireIfNeeded: async () => false,
      isTerminal: () => false,
    },
    () => {},
    {
      watcher: new MemoryWatcher(),
      logReader: {
        getContractEvents: async () => [
          swapLog({ blockNumber: 12n, transactionIndex: 1 }),
          swapLog({ blockNumber: 13n, transactionIndex: null }),
        ],
      },
      coordinator,
      reconcileIntervalMs: 60_000,
    },
  );

  try {
    await assert.rejects(subject.start(), /transactionIndex/u);
  } finally {
    subject.stop();
  }
  assert.equal(completed, false);
  assert.equal(processed, 0);
});

test('Swap refuse avant tout appel moteur un log hors plage ou rattaché à un autre header canonique', async () => {
  for (const log of [
    swapLog({ blockNumber: 11n }),
    swapLog({ blockNumber: 12n, blockHash: HASH_3 }),
  ]) {
    const coordinator = new MemoryCoordinator();
    let processed = 0;
    coordinator.onReconcile = async (request) => {
      const processChunk = request.processChunk as unknown as (
        fromBlock: bigint,
        toBlock: bigint,
        headers: readonly { number: bigint; hash: Hash }[],
      ) => Promise<boolean>;
      await processChunk(12n, 12n, [{ number: 12n, hash: HASH_2 }]);
    };
    const subject = new SwapListener(
      tokenSession(),
      {
        onSwap: async () => {
          processed += 1;
          return true;
        },
        expireIfNeeded: async () => false,
        isTerminal: () => false,
      },
      () => {},
      {
        watcher: new MemoryWatcher(),
        logReader: { getContractEvents: async () => [log] },
        coordinator,
      },
    );

    await assert.rejects(subject.start(), /canonique|plage/u);
    subject.stop();
    assert.equal(processed, 0);
  }
});

test('Swap retourne false et notifie le terminal quand le moteur refuse un événement', async () => {
  const watcher = new MemoryWatcher();
  const coordinator = new MemoryCoordinator();
  const terminal: Address[] = [];
  let processed: boolean | undefined;
  coordinator.onReconcile = async (request) => {
    processed = await request.processChunk(
      12n,
      12n,
      canonicalHeaders([12n, HASH_2]),
    );
  };
  const subject = new SwapListener(
    tokenSession(),
    {
      onSwap: async () => false,
      expireIfNeeded: async () => false,
      isTerminal: () => false,
    },
    (pair) => {
      terminal.push(pair);
    },
    {
      watcher,
      logReader: {
        getContractEvents: async () => [swapLog()],
      },
      coordinator,
      reconcileIntervalMs: 60_000,
    },
  );

  await subject.start();

  assert.equal(processed, false);
  assert.deepEqual(terminal, [ADDRESS_2]);
  assert.equal(watcher.stopped, true);
});

test('stopAndDrain attend le traitement HTTP en vol déclenché par WebSocket', async () => {
  const watcher = new MemoryWatcher();
  const coordinator = new MemoryCoordinator();
  let release!: () => void;
  let entered!: () => void;
  const processing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  coordinator.onReconcile = async (request) => {
    if (coordinator.requests.length > 1) {
      await request.processChunk(
        12n,
        12n,
        canonicalHeaders([12n, HASH_2]),
      );
    }
  };
  const subject = new SwapListener(
    tokenSession(),
    {
      onSwap: async () => {
        entered();
        await blocked;
        return true;
      },
      expireIfNeeded: async () => false,
      isTerminal: () => false,
    },
    () => {},
    {
      watcher,
      logReader: {
        getContractEvents: async () => [swapLog()],
      },
      coordinator,
      reconcileIntervalMs: 60_000,
    },
  );
  await subject.start();

  watcher.options?.onLogs([swapLog()]);
  await processing;
  let drained = false;
  const drain = subject.stopAndDrain().then(() => {
    drained = true;
  });
  await turn();
  assert.equal(drained, false);

  release();
  await drain;
  assert.equal(drained, true);
});

test('callback WebSocket centralisé ne lance pas de réconciliation locale', async () => {
  const watcher = new MemoryWatcher();
  const coordinator = new MemoryCoordinator();
  const signaled: string[] = [];
  const subject = new SwapListener(
    tokenSession(),
    {
      onSwap: async () => true,
      expireIfNeeded: async () => false,
      isTerminal: () => false,
    },
    () => {},
    {
      watcher,
      logReader: {
        getContractEvents: async () => {
          throw new Error('le listener ne doit pas lire de logs HTTP');
        },
      },
      coordinator,
      requestReconcile: (pair) => signaled.push(pair),
      reconcileIntervalMs: 60_000,
    },
  );

  await subject.start();
  watcher.options?.onLogs([swapLog()]);
  watcher.options?.onLogs([swapLog()]);
  await turn();

  assert.equal(signaled.length, 3);
  assert.equal(coordinator.requests.length, 0);
  await subject.stopAndDrain();
});
