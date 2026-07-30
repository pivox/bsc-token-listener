import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, type Hash, type PublicClient } from 'viem';
import {
  createRpcClientPoolForTest,
  type RpcProviderDefinition,
} from '../src/rpc/clients.js';
import { sanitizeRpcText } from '../src/utils/sanitize.js';

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

test('détecte un WebSocket silencieux et le marque indisponible', async () => {
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
  assert.deepEqual(snapshot?.status, 'down');
  assert.match(snapshot?.lastError ?? '', /WebSocket silencieux/);
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
    contractEventsSequence: [() => new Error('provider one down')],
  });
  const secondary = new MockPublicClient({
    contractEventsSequence: [() => new Error('provider two down')],
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
  assert.equal(primary.contractEventsCalls.length, 1);
  assert.equal(secondary.contractEventsCalls.length, 1);
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
  const knownHash = keccak256('0xface');
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
