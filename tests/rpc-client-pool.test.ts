import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, type Hash, type PublicClient } from 'viem';
import {
  createRpcClientPoolForTest,
  type RpcProviderDefinition,
} from '../src/rpc/clients.js';
import { sanitizeRpcText } from '../src/utils/sanitize.js';
import { RpcUsageTracker } from '../src/monitoring/rpc-usage.js';

interface ContractEventsInput {
  address: `0x${string}`;
  eventName: string;
  fromBlock: bigint;
  toBlock: bigint;
}

type MethodResponse<T> = T | Error;

class MockPublicClient {
  private readonly blockNumberSequence: Array<MethodResponse<bigint>>;
  private readonly contractEventsSequence: Array<
    (input: ContractEventsInput) => MethodResponse<readonly unknown[]>
  >;
  private readonly sendSequence: Array<(transaction: string) => MethodResponse<Hash>>;

  readonly blockNumberCalls: bigint[];
  readonly contractEventsCalls: ContractEventsInput[];
  readonly sendCalls: string[];
  closeCalls: number;

  constructor(
    options: {
      blockNumberSequence?: Array<MethodResponse<bigint>>;
      contractEventsSequence?: Array<(input: ContractEventsInput) => MethodResponse<readonly unknown[]>>;
      sendSequence?: Array<(transaction: string) => MethodResponse<Hash>>;
      wsWatch?: boolean;
    } = {},
  ) {
    this.blockNumberSequence = options.blockNumberSequence ?? [];
    this.contractEventsSequence = options.contractEventsSequence ?? [];
    this.sendSequence = options.sendSequence ?? [];
    this.blockNumberCalls = [];
    this.contractEventsCalls = [];
    this.sendCalls = [];
    this.closeCalls = 0;
    this.watchContractEvent = options.wsWatch
      ? () => () => {
      }
      : undefined;
  }

  private nextBlockNumber(): MethodResponse<bigint> {
    const first = this.blockNumberSequence.shift();
    return first ?? 1n;
  }

  private nextContractEvents(input: ContractEventsInput): MethodResponse<readonly unknown[]> {
    const first = this.contractEventsSequence.shift();
    if (first) return first(input);
    return [];
  }

  private nextSend(transaction: string): MethodResponse<Hash> {
    const first = this.sendSequence.shift();
    if (first) return first(transaction);
    return keccak256(transaction as `0x${string}`);
  }

  readonly watchContractEvent: ((input: {
    onLogs(logs: readonly unknown[]): void;
    onError(error: unknown): void;
  }) => () => void) | undefined;

  close = async (): Promise<void> => {
    this.closeCalls += 1;
  };

  getChainId = async (): Promise<number> => 56;

  getBlockNumber = async (): Promise<bigint> => {
    this.blockNumberCalls.push(Date.now() as unknown as bigint);
    const response = this.nextBlockNumber();
    if (response instanceof Error) throw response;
    return response;
  };

  getContractEvents = async (
    input: ContractEventsInput,
  ): Promise<readonly unknown[]> => {
    this.contractEventsCalls.push(input);
    const response = this.nextContractEvents(input);
    if (response instanceof Error) throw response;
    return response;
  };

  sendRawTransaction = async (input: {
    serializedTransaction: `0x${string}`;
  }): Promise<Hash> => {
    this.sendCalls.push(input.serializedTransaction);
    const response = this.nextSend(input.serializedTransaction);
    if (response instanceof Error) throw response;
    return response;
  };
}

function providerDefinition(
  id: string,
  kind: 'HTTP' | 'WEBSOCKET' | 'TX',
  client: PublicClient,
  maxLogBlockRange = 4,
): RpcProviderDefinition {
  return {
    id,
    kind,
    url: `${kind.toLowerCase()}://${id}.example`,
    client,
    maxLogBlockRange,
  };
}

const ADDRESS = `0x${'a'.repeat(40)}` as const;
const PROVIDER_HTTP_MAIN = 'http-main';
const PROVIDER_HTTP_FALLBACK = 'http-fallback';
const PROVIDER_WS_MAIN = 'ws-main';
const PROVIDER_TX_MAIN = 'tx-main';

function withCodeError(code: number, message: string): Error {
  const error = new Error(message);
  (error as { code?: number }).code = code;
  return error;
}

test('lit depuis le provider principal quand il est sain', async () => {
  const events = [{ id: 'a' }, { id: 'b' }];
  const primary = new MockPublicClient({
    contractEventsSequence: [() => events],
  });
  const fallback = new MockPublicClient({
    contractEventsSequence: [() => [{ id: 'z' }]],
  });
  const ws = new MockPublicClient();
  const tx = new MockPublicClient();
  const pool = createRpcClientPoolForTest({
    readProviders: [
      providerDefinition(PROVIDER_HTTP_MAIN, 'HTTP', primary as unknown as PublicClient),
      providerDefinition(PROVIDER_HTTP_FALLBACK, 'HTTP', fallback as unknown as PublicClient),
    ],
    wsProviders: [
      providerDefinition(PROVIDER_WS_MAIN, 'WEBSOCKET', ws as unknown as PublicClient),
    ],
    txProviders: [
      providerDefinition(PROVIDER_TX_MAIN, 'TX', tx as unknown as PublicClient),
    ],
  });

  const logs = await pool.getPublicClient().getContractEvents({
    address: ADDRESS,
    abi: [],
    eventName: 'PairCreated',
    fromBlock: 1n,
    toBlock: 2n,
  });

  assert.deepEqual(logs, events);
  assert.equal(primary.contractEventsCalls.length, 1);
  assert.equal(fallback.contractEventsCalls.length, 0);
});

test('passe au provider secondaire quand le principal a un timeout', async () => {
  const fallbackLogs = [{ id: 'b' }];
  const primary = new MockPublicClient({
    contractEventsSequence: [() => new Error('timeoutexceeded:8000')],
  });
  const fallback = new MockPublicClient({
    contractEventsSequence: [() => fallbackLogs],
  });
  const ws = new MockPublicClient();
  const tx = new MockPublicClient();
  const pool = createRpcClientPoolForTest({
    readProviders: [
      providerDefinition(PROVIDER_HTTP_MAIN, 'HTTP', primary as unknown as PublicClient),
      providerDefinition(PROVIDER_HTTP_FALLBACK, 'HTTP', fallback as unknown as PublicClient),
    ],
    wsProviders: [
      providerDefinition(PROVIDER_WS_MAIN, 'WEBSOCKET', ws as unknown as PublicClient),
    ],
    txProviders: [
      providerDefinition(PROVIDER_TX_MAIN, 'TX', tx as unknown as PublicClient),
    ],
  });

  const logs = await pool.getPublicClient().getContractEvents({
    address: ADDRESS,
    abi: [],
    eventName: 'PairCreated',
    fromBlock: 1n,
    toBlock: 2n,
  });

  assert.deepEqual(logs, fallbackLogs);
  assert.equal(primary.contractEventsCalls.length, 1);
  assert.equal(fallback.contractEventsCalls.length, 1);
});

test('passe au provider secondaire sur erreur HTTP 429', async () => {
  const fallbackLogs = [{ id: 'b' }];
  const primary = new MockPublicClient({
    contractEventsSequence: [() => withCodeError(429, 'too many requests')],
  });
  const fallback = new MockPublicClient({
    contractEventsSequence: [() => fallbackLogs],
  });
  const ws = new MockPublicClient();
  const tx = new MockPublicClient();
  const pool = createRpcClientPoolForTest({
    readProviders: [
      providerDefinition(PROVIDER_HTTP_MAIN, 'HTTP', primary as unknown as PublicClient),
      providerDefinition(PROVIDER_HTTP_FALLBACK, 'HTTP', fallback as unknown as PublicClient),
    ],
    wsProviders: [
      providerDefinition(PROVIDER_WS_MAIN, 'WEBSOCKET', ws as unknown as PublicClient),
    ],
    txProviders: [
      providerDefinition(PROVIDER_TX_MAIN, 'TX', tx as unknown as PublicClient),
    ],
  });

  const logs = await pool.getPublicClient().getContractEvents({
    address: ADDRESS,
    abi: [],
    eventName: 'PairCreated',
    fromBlock: 1n,
    toBlock: 2n,
  });

  assert.deepEqual(logs, fallbackLogs);
  assert.equal(primary.contractEventsCalls.length, 1);
  assert.equal(fallback.contractEventsCalls.length, 1);
});

test('un WebSocket sans événement métier reste sain si le contrôle technique répond', async () => {
  const ws = new MockPublicClient();
  const primaryRead = new MockPublicClient({
    blockNumberSequence: [1n],
  });
  const tx = new MockPublicClient();
  const pool = createRpcClientPoolForTest({
    readProviders: [
      providerDefinition(PROVIDER_HTTP_MAIN, 'HTTP', primaryRead as unknown as PublicClient),
    ],
    wsProviders: [
      providerDefinition(PROVIDER_WS_MAIN, 'WEBSOCKET', ws as unknown as PublicClient),
    ],
    txProviders: [
      providerDefinition(PROVIDER_TX_MAIN, 'TX', tx as unknown as PublicClient),
    ],
  });

  const now = Date.now();
  const updated = await pool.forTestSetProviderWsMessageAge(PROVIDER_WS_MAIN, now - 120_000);
  assert.equal(updated, true);

  const snapshots = await pool.getProviderSnapshots();
  const snapshot = snapshots.find((entry) => entry.id === PROVIDER_WS_MAIN);
  assert.deepEqual(snapshot?.status, 'up');
  assert.equal(snapshot?.lastError, null);
  assert.ok((snapshot?.lastWsMessageAgeMs ?? Number.MAX_SAFE_INTEGER) < 1_000);
});

test('refuse un provider en retard et continue avec le provider principal sain', async () => {
  const healthy = new MockPublicClient({ blockNumberSequence: [100n] });
  const lagging = new MockPublicClient({ blockNumberSequence: [60n] });
  const ws = new MockPublicClient();
  const tx = new MockPublicClient();
  const pool = createRpcClientPoolForTest({
    readProviders: [
      providerDefinition(PROVIDER_HTTP_MAIN, 'HTTP', healthy as unknown as PublicClient),
      providerDefinition('http-late', 'HTTP', lagging as unknown as PublicClient),
    ],
    wsProviders: [
      providerDefinition(PROVIDER_WS_MAIN, 'WEBSOCKET', ws as unknown as PublicClient),
    ],
    txProviders: [
      providerDefinition(PROVIDER_TX_MAIN, 'TX', tx as unknown as PublicClient),
    ],
  });

  const snapshots = await pool.getProviderSnapshots();
  const mainSnapshot = snapshots.find((snapshot) => snapshot.id === PROVIDER_HTTP_MAIN);
  const lateSnapshot = snapshots.find((snapshot) => snapshot.id === 'http-late');
  assert.equal(mainSnapshot?.status, 'up');
  assert.equal(mainSnapshot?.lagging, false);
  assert.equal(lateSnapshot?.status, 'down');
  assert.equal(lateSnapshot?.lagging, true);
});

test('continues la lecture quand le principal est en panne et le secours reste sain', async () => {
  const fallback = new MockPublicClient({
    contractEventsSequence: [() => [{ id: 'backup' }]],
  });
  const primary = new MockPublicClient({
    contractEventsSequence: [() => new Error('provider down')],
  });
  const ws = new MockPublicClient();
  const tx = new MockPublicClient();
  const pool = createRpcClientPoolForTest({
    readProviders: [
      providerDefinition(PROVIDER_HTTP_MAIN, 'HTTP', primary as unknown as PublicClient),
      providerDefinition(PROVIDER_HTTP_FALLBACK, 'HTTP', fallback as unknown as PublicClient),
    ],
    wsProviders: [
      providerDefinition(PROVIDER_WS_MAIN, 'WEBSOCKET', ws as unknown as PublicClient),
    ],
    txProviders: [
      providerDefinition(PROVIDER_TX_MAIN, 'TX', tx as unknown as PublicClient),
    ],
  });

  const logs = await pool.getPublicClient().getContractEvents({
    address: ADDRESS,
    abi: [],
    eventName: 'PairCreated',
    fromBlock: 1n,
    toBlock: 2n,
  });

  assert.deepEqual(logs, [{ id: 'backup' }]);
  assert.equal(primary.contractEventsCalls.length, 1);
  assert.equal(fallback.contractEventsCalls.length, 1);
});

test('repart d’un statut cooldown vers up après réparation', async () => {
  const originalNow = Date.now;
  let now = 0;
  (Date as unknown as { now: () => number }).now = () => now;

  try {
    const source = new MockPublicClient({
      blockNumberSequence: [new Error('timeout'), new Error('timeout'), 200n],
    });
    const ws = new MockPublicClient();
    const tx = new MockPublicClient();
    const pool = createRpcClientPoolForTest({
      readProviders: [
        providerDefinition(PROVIDER_HTTP_MAIN, 'HTTP', source as unknown as PublicClient),
      ],
      wsProviders: [
        providerDefinition(PROVIDER_WS_MAIN, 'WEBSOCKET', ws as unknown as PublicClient),
      ],
      txProviders: [
        providerDefinition(PROVIDER_TX_MAIN, 'TX', tx as unknown as PublicClient),
      ],
    });

    now = 0;
    const first = await pool.getProviderSnapshots();
    assert.equal(first[0]?.status ?? 'down', 'up');

    now = 6_000;
    const second = await pool.getProviderSnapshots();
    assert.equal(second[0]?.status ?? 'up', 'down');

    now = 25_000;
    const third = await pool.getProviderSnapshots();
    assert.equal(third[0]?.status ?? 'down', 'up');
  } finally {
    (Date as unknown as { now: () => number }).now = originalNow;
  }
});

test('bascule vers le secours en cours de chunk et recommence le chunk', async () => {
  const primary = new MockPublicClient({
    contractEventsSequence: [
      () => [{ id: 'p-1' }, { id: 'p-2' }],
      () => new Error('network in chunk'),
    ],
  });
  const secondary = new MockPublicClient({
    contractEventsSequence: [
      () => [{ id: 's-1' }, { id: 's-2' }],
      () => [{ id: 's-3' }, { id: 's-4' }],
    ],
  });
  const ws = new MockPublicClient();
  const tx = new MockPublicClient();
  const pool = createRpcClientPoolForTest({
    readProviders: [
      providerDefinition(PROVIDER_HTTP_MAIN, 'HTTP', primary as unknown as PublicClient, 2),
      providerDefinition(PROVIDER_HTTP_FALLBACK, 'HTTP', secondary as unknown as PublicClient, 2),
    ],
    wsProviders: [
      providerDefinition(PROVIDER_WS_MAIN, 'WEBSOCKET', ws as unknown as PublicClient),
    ],
    txProviders: [
      providerDefinition(PROVIDER_TX_MAIN, 'TX', tx as unknown as PublicClient),
    ],
  });

  const logs = await pool.getPublicClient().getContractEvents({
    address: ADDRESS,
    abi: [],
    eventName: 'PairCreated',
    fromBlock: 1n,
    toBlock: 4n,
  });

  assert.deepEqual(logs, [{ id: 's-1' }, { id: 's-2' }, { id: 's-3' }, { id: 's-4' }]);
  assert.deepEqual(
    primary.contractEventsCalls.map((call) => `${call.fromBlock}-${call.toBlock}`),
    ['1-2', '3-4'],
  );
  assert.deepEqual(
    secondary.contractEventsCalls.map((call) => `${call.fromBlock}-${call.toBlock}`),
    ['1-2', '3-4'],
  );
});

test('ne modifie pas le checkpoint tant qu’un chunk n’est pas complètement lu', async () => {
  let secondaryChunkOneAttempts = 0;
  const primary = new MockPublicClient({
    contractEventsSequence: [
      () => [{ id: 'p-1' }],
      () => new Error('network failure in chunk'),
    ],
  });
  const secondary = new MockPublicClient({
    contractEventsSequence: [
      () => {
        secondaryChunkOneAttempts += 1;
        if (secondaryChunkOneAttempts === 1) return new Error('secondary temporarily unavailable');
        return [{ id: 's-1' }, { id: 's-2' }];
      },
      () => [{ id: 's-3' }, { id: 's-4' }],
    ],
  });
  const ws = new MockPublicClient();
  const tx = new MockPublicClient();
  const pool = createRpcClientPoolForTest({
    maxHttpRetries: 1,
    readProviders: [
      providerDefinition(PROVIDER_HTTP_MAIN, 'HTTP', primary as unknown as PublicClient, 2),
      providerDefinition(PROVIDER_HTTP_FALLBACK, 'HTTP', secondary as unknown as PublicClient, 2),
    ],
    wsProviders: [
      providerDefinition(PROVIDER_WS_MAIN, 'WEBSOCKET', ws as unknown as PublicClient),
    ],
    txProviders: [
      providerDefinition(PROVIDER_TX_MAIN, 'TX', tx as unknown as PublicClient),
    ],
  });

  let checkpoint = 1n;

  const readChunk = async () => {
    try {
      await pool.getPublicClient().getContractEvents({
        address: ADDRESS,
        abi: [],
        eventName: 'PairCreated',
        fromBlock: checkpoint,
        toBlock: 4n,
      });
      checkpoint = 5n;
      return true;
    } catch {
      return false;
    }
  };

  const firstAttempt = await readChunk();
  assert.equal(firstAttempt, false);
  assert.equal(checkpoint, 1n);
  assert.deepEqual(
    secondary.contractEventsCalls.map((call) => `${call.fromBlock}-${call.toBlock}`),
    ['1-2'],
  );

  const secondAttempt = await readChunk();
  assert.equal(secondAttempt, true);
  assert.equal(checkpoint, 5n);
  assert.deepEqual(
    secondary.contractEventsCalls.map((call) => `${call.fromBlock}-${call.toBlock}`),
    ['1-2', '1-2', '3-4'],
  );
});

test('échoue lorsque tous les providers HTTP sont indisponibles', async () => {
  const primary = new MockPublicClient({
    contractEventsSequence: [
      () => new Error('provider one down'),
      () => new Error('provider one down'),
    ],
  });
  const secondary = new MockPublicClient({
    contractEventsSequence: [
      () => new Error('provider two down'),
      () => new Error('provider two down'),
    ],
  });
  const ws = new MockPublicClient();
  const tx = new MockPublicClient();
  const pool = createRpcClientPoolForTest({
    readProviders: [
      providerDefinition(PROVIDER_HTTP_MAIN, 'HTTP', primary as unknown as PublicClient),
      providerDefinition(PROVIDER_HTTP_FALLBACK, 'HTTP', secondary as unknown as PublicClient),
    ],
    wsProviders: [
      providerDefinition(PROVIDER_WS_MAIN, 'WEBSOCKET', ws as unknown as PublicClient),
    ],
    txProviders: [
      providerDefinition(PROVIDER_TX_MAIN, 'TX', tx as unknown as PublicClient),
    ],
  });

  await assert.rejects(
    () => pool.getPublicClient().getContractEvents({
      address: ADDRESS,
      abi: [],
      eventName: 'PairCreated',
      fromBlock: 1n,
      toBlock: 2n,
    }),
    /Aucun provider HTTP disponible pour eth_getLogs\./u,
  );
  assert.equal(primary.contractEventsCalls.length, 2);
  assert.equal(secondary.contractEventsCalls.length, 2);
});

test('produit status UNKNOWN quand une diffusion est perdue', async () => {
  const tx = new MockPublicClient({
    sendSequence: [() => new Error('timeoutexceeded:8000')],
  });
  const ws = new MockPublicClient();
  const primary = new MockPublicClient({
    blockNumberSequence: [1n],
  });
  const pool = createRpcClientPoolForTest({
    readProviders: [
      providerDefinition(PROVIDER_HTTP_MAIN, 'HTTP', primary as unknown as PublicClient),
    ],
    wsProviders: [
      providerDefinition(PROVIDER_WS_MAIN, 'WEBSOCKET', ws as unknown as PublicClient),
    ],
    txProviders: [
      providerDefinition(PROVIDER_TX_MAIN, 'TX', tx as unknown as PublicClient),
    ],
  });

  await assert.rejects(
    () => pool.getTxClient().sendRawTransaction({ serializedTransaction: '0x1234' }),
    /status UNKNOWN/u,
  );
  assert.equal(tx.sendCalls.length, 1);
});

test('interprète une erreur "already known" en hash confirmé', async () => {
  const knownHash = keccak256('0x9999');
  const tx = new MockPublicClient({
    sendSequence: [() => {
      const error = new Error(`already known: ${knownHash}`);
      return error;
    }],
  });
  const ws = new MockPublicClient();
  const primary = new MockPublicClient({
    blockNumberSequence: [1n],
  });
  const pool = createRpcClientPoolForTest({
    readProviders: [
      providerDefinition(PROVIDER_HTTP_MAIN, 'HTTP', primary as unknown as PublicClient),
    ],
    wsProviders: [
      providerDefinition(PROVIDER_WS_MAIN, 'WEBSOCKET', ws as unknown as PublicClient),
    ],
    txProviders: [
      providerDefinition(PROVIDER_TX_MAIN, 'TX', tx as unknown as PublicClient),
    ],
  });

  const returned = await pool.getTxClient().sendRawTransaction({ serializedTransaction: '0x9999' });
  assert.equal(returned, knownHash);
  assert.equal(tx.sendCalls.length, 1);
});

test('le vrai proxy WebSocket expose getChainId', async () => {
  const ws = new MockPublicClient();
  const read = new MockPublicClient();
  const tx = new MockPublicClient();
  const pool = createRpcClientPoolForTest({
    maxHttpRetries: 0,
    readProviders: [providerDefinition('http-chain', 'HTTP', read as unknown as PublicClient)],
    wsProviders: [providerDefinition('ws-chain', 'WEBSOCKET', ws as unknown as PublicClient)],
    txProviders: [providerDefinition('tx-chain', 'TX', tx as unknown as PublicClient)],
  });

  assert.equal(await pool.getWsClient().getChainId(), 56);
});

test('applique une limite globale à une requête HTTP par seconde', async () => {
  let now = 0;
  const callTimes: number[] = [];
  const read = {
    getBlockNumber: async () => {
      callTimes.push(now);
      return 1n;
    },
  } as unknown as PublicClient;
  const pool = createRpcClientPoolForTest({
    now: () => now,
    sleep: async (ms) => { now += ms; },
    maxHttpRps: 1,
    maxHttpRetries: 0,
    readProviders: [providerDefinition('http-rate-1', 'HTTP', read)],
    wsProviders: [],
    txProviders: [],
  });

  await Promise.all([
    pool.getPublicClient().getBlockNumber(),
    pool.getPublicClient().getBlockNumber(),
    pool.getPublicClient().getBlockNumber(),
  ]);
  assert.deepEqual(callTimes, [0, 1_000, 2_000]);
});

test('applique une limite globale à vingt requêtes HTTP par seconde', async () => {
  let now = 0;
  const callTimes: number[] = [];
  const read = {
    getBlockNumber: async () => {
      callTimes.push(now);
      return 1n;
    },
  } as unknown as PublicClient;
  const pool = createRpcClientPoolForTest({
    now: () => now,
    sleep: async (ms) => { now += ms; },
    maxHttpRps: 20,
    maxHttpRetries: 0,
    readProviders: [providerDefinition('http-rate-20', 'HTTP', read)],
    wsProviders: [],
    txProviders: [],
  });

  await Promise.all([
    pool.getPublicClient().getBlockNumber(),
    pool.getPublicClient().getBlockNumber(),
    pool.getPublicClient().getBlockNumber(),
  ]);
  assert.deepEqual(callTimes, [0, 50, 100]);
});

test('respecte Retry-After en secondes puis réussit', async () => {
  let now = 0;
  const sleeps: number[] = [];
  let calls = 0;
  const read = {
    getBlockNumber: async () => {
      calls += 1;
      if (calls === 1) {
        const error = withCodeError(429, 'too many requests');
        (error as Error & { headers: Record<string, string> }).headers = {
          'retry-after': '2',
        };
        throw error;
      }
      return 10n;
    },
  } as unknown as PublicClient;
  const pool = createRpcClientPoolForTest({
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    maxHttpRps: 25,
    maxHttpRetries: 1,
    retryJitter: (delay) => delay,
    readProviders: [providerDefinition('http-429-seconds', 'HTTP', read)],
    wsProviders: [],
    txProviders: [],
  });

  assert.equal(await pool.getPublicClient().getBlockNumber(), 10n);
  assert.deepEqual(sleeps, [2_000]);
  assert.equal(calls, 2);
});

test('respecte Retry-After sous forme de date HTTP', async () => {
  let now = Date.parse('2030-01-01T00:00:00.000Z');
  const sleeps: number[] = [];
  let calls = 0;
  const read = {
    getBlockNumber: async () => {
      calls += 1;
      if (calls === 1) {
        const error = withCodeError(429, '429');
        (error as Error & { headers: Record<string, string> }).headers = {
          'Retry-After': new Date(now + 3_000).toUTCString(),
        };
        throw error;
      }
      return 11n;
    },
  } as unknown as PublicClient;
  const pool = createRpcClientPoolForTest({
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    maxHttpRetries: 1,
    maxHttpRps: 25,
    retryJitter: (delay) => delay,
    readProviders: [providerDefinition('http-429-date', 'HTTP', read)],
    wsProviders: [],
    txProviders: [],
  });

  assert.equal(await pool.getPublicClient().getBlockNumber(), 11n);
  assert.deepEqual(sleeps, [3_000]);
});

test('un 429 sans Retry-After utilise le backoff exponentiel', async () => {
  let now = 0;
  const sleeps: number[] = [];
  let calls = 0;
  const read = {
    getBlockNumber: async () => {
      calls += 1;
      if (calls === 1) throw withCodeError(429, 'too many requests');
      return 12n;
    },
  } as unknown as PublicClient;
  const pool = createRpcClientPoolForTest({
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    maxHttpRetries: 1,
    maxHttpRps: 25,
    retryBaseDelayMs: 125,
    retryJitter: (delay) => delay,
    readProviders: [providerDefinition('http-429-default', 'HTTP', read)],
    wsProviders: [],
    txProviders: [],
  });

  assert.equal(await pool.getPublicClient().getBlockNumber(), 12n);
  assert.deepEqual(sleeps, [125]);
});

test('utilise un backoff exponentiel borné et le nombre exact de retries', async () => {
  let now = 0;
  const sleeps: number[] = [];
  let calls = 0;
  const read = {
    getBlockNumber: async () => {
      calls += 1;
      throw new Error('timeout transport');
    },
  } as unknown as PublicClient;
  const pool = createRpcClientPoolForTest({
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    maxHttpRetries: 3,
    maxHttpRps: 25,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 250,
    retryJitter: (delay) => delay,
    readProviders: [providerDefinition('http-backoff', 'HTTP', read)],
    wsProviders: [],
    txProviders: [],
  });

  await assert.rejects(() => pool.getPublicClient().getBlockNumber(), /timeout/u);
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [100, 200, 250]);
});

test('un revert eth_call ne dégrade pas le provider', async () => {
  const read = {
    readContract: async () => {
      throw new Error('execution reverted: insufficient output amount');
    },
    getBlockNumber: async () => 88n,
  } as unknown as PublicClient;
  const pool = createRpcClientPoolForTest({
    maxHttpRetries: 0,
    readProviders: [providerDefinition('http-business', 'HTTP', read)],
    wsProviders: [],
    txProviders: [],
  });

  await assert.rejects(
    () => pool.getPublicClient().readContract({
      address: ADDRESS,
      abi: [],
      functionName: 'quote',
    }),
    /execution reverted/u,
  );
  assert.equal(await pool.getPublicClient().getBlockNumber(), 88n);
  assert.equal(pool.forTestGetProviderSnapshotById('http-business')?.status, 'up');
});

test('conserve une limite eth_getLogs propre à chaque provider et la remonte lentement', async () => {
  const primary = new MockPublicClient({
    contractEventsSequence: [() => withCodeError(-32005, 'max block range exceeded')],
  });
  const secondary = new MockPublicClient();
  const pool = createRpcClientPoolForTest({
    maxHttpRetries: 0,
    readProviders: [
      providerDefinition('http-range-primary', 'HTTP', primary as unknown as PublicClient, 8),
      providerDefinition('http-range-secondary', 'HTTP', secondary as unknown as PublicClient, 16),
    ],
    wsProviders: [],
    txProviders: [],
  });
  const read = () => pool.getPublicClient().getContractEvents({
    address: ADDRESS,
    abi: [],
    eventName: 'Swap',
    fromBlock: 1n,
    toBlock: 1n,
  });

  await read();
  assert.equal(pool.forTestGetProviderSnapshotById('http-range-primary')?.maxLogBlockRange, 4);
  assert.equal(pool.forTestGetProviderSnapshotById('http-range-secondary')?.maxLogBlockRange, 16);
  await pool.getProviderSnapshots();
  assert.equal(pool.forTestGetProviderSnapshotById('http-range-primary')?.maxLogBlockRange, 4);
  await read();
  await read();
  await read();
  await read();
  assert.equal(pool.forTestGetProviderSnapshotById('http-range-primary')?.maxLogBlockRange, 5);
  assert.equal(pool.forTestGetProviderSnapshotById('http-range-primary')?.configuredMaxLogBlockRange, 8);
});

test('un timeout TX reste UNKNOWN et ne provoque aucune rediffusion', async () => {
  const tx = new MockPublicClient({
    sendSequence: [() => new Error('timeout réponse perdue')],
  });
  const pool = createRpcClientPoolForTest({
    maxHttpRetries: 5,
    readProviders: [],
    wsProviders: [],
    txProviders: [providerDefinition('tx-unknown', 'TX', tx as unknown as PublicClient)],
  });
  const serializedTransaction = '0xabcd' as const;
  const hash = keccak256(serializedTransaction);

  await assert.rejects(
    () => pool.getTxClient().sendRawTransaction({ serializedTransaction }),
    /UNKNOWN/u,
  );
  await assert.rejects(
    () => pool.getTxClient().sendRawTransaction({ serializedTransaction }),
    /UNKNOWN/u,
  );
  assert.equal(tx.sendCalls.length, 1);
  assert.equal(pool.forTestGetTransactionState(hash), 'UNKNOWN');
});

test('un rejet TX définitif est REJECTED et non un faux succès', async () => {
  const tx = new MockPublicClient({
    sendSequence: [() => new Error('invalid sender')],
  });
  const pool = createRpcClientPoolForTest({
    readProviders: [],
    wsProviders: [],
    txProviders: [providerDefinition('tx-rejected', 'TX', tx as unknown as PublicClient)],
  });
  const serializedTransaction = '0xbeef' as const;
  const hash = keccak256(serializedTransaction);

  await assert.rejects(
    () => pool.getTxClient().sendRawTransaction({ serializedTransaction }),
    /rejetée avant diffusion/u,
  );
  assert.equal(tx.sendCalls.length, 1);
  assert.equal(pool.forTestGetTransactionState(hash), 'REJECTED');
});

test('bascule réellement un watcher WebSocket et arrête chaque souscription une fois', async () => {
  type WatchInput = {
    onLogs(logs: readonly unknown[]): void;
    onError?(error: unknown): void;
  };
  let mainInput: WatchInput | null = null;
  let backupInput: WatchInput | null = null;
  let mainStops = 0;
  let backupStops = 0;
  let mainWatches = 0;
  let backupWatches = 0;
  const main = {
    getBlockNumber: async () => 100n,
    watchContractEvent: (input: WatchInput) => {
      mainWatches += 1;
      mainInput = input;
      return () => { mainStops += 1; };
    },
  } as unknown as PublicClient;
  const backup = {
    getBlockNumber: async () => 100n,
    watchContractEvent: (input: WatchInput) => {
      backupWatches += 1;
      backupInput = input;
      return () => { backupStops += 1; };
    },
  } as unknown as PublicClient;
  const pool = createRpcClientPoolForTest({
    sleep: async () => {},
    retryJitter: () => 0,
    readProviders: [],
    wsProviders: [
      providerDefinition('ws-watch-main', 'WEBSOCKET', main),
      providerDefinition('ws-watch-backup', 'WEBSOCKET', backup),
    ],
    txProviders: [],
  });

  const stop = pool.getWsClient().watchContractEvent({
    address: ADDRESS,
    abi: [],
    eventName: 'Swap',
    onLogs: () => {},
    onError: () => {},
  });
  assert.equal(mainWatches, 1);
  (mainInput as WatchInput | null)?.onError?.(new Error('WebSocket closed'));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(mainStops, 1);
  assert.equal(backupWatches, 1);

  await pool.getProviderSnapshots();
  assert.equal(mainWatches + backupWatches, 2);
  assert.ok(backupInput);
  stop();
  assert.equal(backupStops, 1);
});

test('un arrêt pendant le backoff WebSocket interdit toute nouvelle souscription', async () => {
  type WatchInput = { onLogs(logs: readonly unknown[]): void; onError?(error: unknown): void };
  let mainInput: WatchInput | null = null;
  let releaseSleep: (() => void) | null = null;
  let backupWatches = 0;
  const main = {
    watchContractEvent: (input: WatchInput) => {
      mainInput = input;
      return () => {};
    },
  } as unknown as PublicClient;
  const backup = {
    watchContractEvent: (_input: WatchInput) => {
      backupWatches += 1;
      return () => {};
    },
  } as unknown as PublicClient;
  const pool = createRpcClientPoolForTest({
    sleep: () => new Promise<void>((resolve) => { releaseSleep = resolve; }),
    retryJitter: (delay) => delay,
    readProviders: [],
    wsProviders: [
      providerDefinition('ws-stop-main', 'WEBSOCKET', main),
      providerDefinition('ws-stop-backup', 'WEBSOCKET', backup),
    ],
    txProviders: [],
  });
  const stop = pool.getWsClient().watchContractEvent({
    address: ADDRESS,
    abi: [],
    eventName: 'Swap',
    onLogs: () => {},
    onError: () => {},
  });
  (mainInput as WatchInput | null)?.onError?.(new Error('connection closed'));
  stop();
  (releaseSleep as (() => void) | null)?.();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(backupWatches, 0);
});

test('dégrade un WebSocket dont la tête technique est en retard', async () => {
  const read = new MockPublicClient({ blockNumberSequence: [100n] });
  const ws = new MockPublicClient({ blockNumberSequence: [1n] });
  const pool = createRpcClientPoolForTest({
    readProviders: [providerDefinition('http-head', 'HTTP', read as unknown as PublicClient)],
    wsProviders: [providerDefinition('ws-late', 'WEBSOCKET', ws as unknown as PublicClient)],
    txProviders: [],
  });
  const snapshots = await pool.getProviderSnapshots();
  assert.equal(snapshots.find((snapshot) => snapshot.id === 'ws-late')?.status, 'down');
});

test('branche les métriques sur les tentatives réseau, retries, 429 et bascules', async () => {
  let now = 0;
  const usage = new RpcUsageTracker({ now: () => now, minimumObservationMs: 1 });
  const primary = new MockPublicClient({
    blockNumberSequence: [withCodeError(429, 'too many requests')],
  });
  const backup = new MockPublicClient({ blockNumberSequence: [10n] });
  const pool = createRpcClientPoolForTest({
    now: () => now,
    sleep: async (ms) => { now += ms; },
    retryJitter: (delay) => delay,
    maxHttpRetries: 1,
    usage,
    readProviders: [
      providerDefinition('metrics-primary', 'HTTP', primary as unknown as PublicClient),
      providerDefinition('metrics-backup', 'HTTP', backup as unknown as PublicClient),
    ],
    wsProviders: [],
    txProviders: [],
  });
  assert.equal(await pool.getPublicClient().getBlockNumber(), 10n);
  const method = usage.getSnapshot().methods.eth_blocknumber;
  assert.equal(method?.calls, 2);
  assert.equal(method?.errors, 1);
  assert.equal(method?.errors429, 1);
  assert.equal(method?.retries, 1);
  assert.equal(method?.failovers, 1);
});

test('évite la double diffusion : la transaction déjà connue reste mémorisée', async () => {
  const tx = new MockPublicClient({
    sendSequence: [() => keccak256('0x1234'), () => keccak256('0x1234')],
  });
  const ws = new MockPublicClient();
  const primary = new MockPublicClient({ blockNumberSequence: [1n] });
  const pool = createRpcClientPoolForTest({
    readProviders: [
      providerDefinition(PROVIDER_HTTP_MAIN, 'HTTP', primary as unknown as PublicClient),
    ],
    wsProviders: [
      providerDefinition(PROVIDER_WS_MAIN, 'WEBSOCKET', ws as unknown as PublicClient),
    ],
    txProviders: [
      providerDefinition(PROVIDER_TX_MAIN, 'TX', tx as unknown as PublicClient),
    ],
  });

  const expected = keccak256('0x1234');
  const first = await pool.getTxClient().sendRawTransaction({ serializedTransaction: '0x1234' });
  const second = await pool.getTxClient().sendRawTransaction({ serializedTransaction: '0x1234' });
  assert.equal(first, expected);
  assert.equal(second, expected);
  assert.equal(tx.sendCalls.length, 1);
});

test('masque les secrets présents dans les erreurs de provider', async () => {
  const rawRpcUrl = 'https://token:secret123@rpc.example.com/v1/alpha';
  const http = new MockPublicClient({
    blockNumberSequence: [new Error(`erreur sur ${rawRpcUrl}`)],
  });
  const ws = new MockPublicClient();
  const tx = new MockPublicClient();
  const pool = createRpcClientPoolForTest({
    readProviders: [
      providerDefinition(PROVIDER_HTTP_MAIN, 'HTTP', http as unknown as PublicClient),
    ],
    wsProviders: [
      providerDefinition(PROVIDER_WS_MAIN, 'WEBSOCKET', ws as unknown as PublicClient),
    ],
    txProviders: [
      providerDefinition(PROVIDER_TX_MAIN, 'TX', tx as unknown as PublicClient),
    ],
  });

  const snapshots = await pool.getProviderSnapshots();
  const httpSnapshot = snapshots.find((entry) => entry.id === PROVIDER_HTTP_MAIN);
  const expectedError = sanitizeRpcText(`erreur sur ${rawRpcUrl}`);
  assert.equal(httpSnapshot?.lastError, expectedError);
  assert.equal(httpSnapshot?.lastError?.includes(rawRpcUrl), false);
  assert.equal(httpSnapshot?.lastError?.includes('[REDACTED_RPC_URL]'), true);
});

test('ne construit pas les identifiants fournisseur à partir d’une URL', async () => {
  const http = new MockPublicClient({ blockNumberSequence: [10n] });
  const ws = new MockPublicClient();
  const tx = new MockPublicClient();
  const customReadProvider: RpcProviderDefinition = {
    id: 'custom-01',
    kind: 'HTTP',
    url: 'https://secret.example.com/v1/abc123?apikey=topsecret',
    client: http as unknown as PublicClient,
    maxLogBlockRange: 4,
  };
  const pool = createRpcClientPoolForTest({
    readProviders: [customReadProvider],
    wsProviders: [
      providerDefinition(PROVIDER_WS_MAIN, 'WEBSOCKET', ws as unknown as PublicClient),
    ],
    txProviders: [
      providerDefinition(PROVIDER_TX_MAIN, 'TX', tx as unknown as PublicClient),
  ],
  });

  const snapshots = await pool.getProviderSnapshots();
  const readSnapshot = snapshots.find((entry) => entry.id === 'custom-01');
  assert.equal(readSnapshot?.id, 'custom-01');
  assert.equal(readSnapshot?.id.includes('https://'), false);
  assert.equal(readSnapshot?.id.includes('?'), false);
});
