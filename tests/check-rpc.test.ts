import assert from 'node:assert/strict';
import test from 'node:test';
import { chain } from '../src/config/chain.js';
import { config } from '../src/config/env.js';
import { sanitizeRpcError, runRpcChecks } from '../scripts/check-rpc.js';

interface PairLogCall {
  address: string;
  fromBlock: bigint;
  toBlock: bigint;
  eventName: string;
}

class MockChainClient {
  readonly contractEventCalls: PairLogCall[] = [];
  closeCallCount = 0;
  public closed = false;

  constructor(
    private readonly chainId: number,
    private readonly latestBlock: bigint,
    private readonly events: readonly unknown[] = [],
    private readonly getContractEventsError?: Error,
    private readonly neverResolveChainId = false,
  ) {}

  async getChainId(): Promise<number> {
    if (this.neverResolveChainId) return new Promise<number>(() => {});
    return this.chainId;
  }

  async getBlockNumber(): Promise<bigint> {
    return this.latestBlock;
  }

  async getContractEvents(args: {
    address: string;
    eventName: string;
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<readonly unknown[]> {
    this.contractEventCalls.push({
      address: args.address,
      fromBlock: args.fromBlock,
      toBlock: args.toBlock,
      eventName: args.eventName,
    });
    if (this.getContractEventsError) {
      throw this.getContractEventsError;
    }
    return this.events;
  }

  async close(): Promise<void> {
    this.closeCallCount += 1;
    this.closed = true;
  }
}

test('runRpcChecks valide la chaîne et limite correctement la fenêtre de PairCreated', async () => {
  const http = new MockChainClient(chain.id, 123n, [{ pair: '0x' }]);
  const ws = new MockChainClient(chain.id, 130n);

  const report = await runRpcChecks({ http, ws });

  assert.equal(report.httpChainId, chain.id);
  assert.equal(report.wsChainId, chain.id);
  assert.equal(report.blockDelta, '7');
  assert.equal(report.pairCreatedEventCount, 1);
  assert.equal(http.contractEventCalls.length, 1);
  assert.equal(http.contractEventCalls[0]?.address, config.factory);
  assert.equal(http.contractEventCalls[0]?.eventName, 'PairCreated');
  assert.equal(ws.closeCallCount, 1);
  const windowWidth = BigInt(report.pairCreatedRangeTo) - BigInt(report.pairCreatedRangeFrom);
  assert.ok(windowWidth >= 0n && windowWidth <= 9n);
});

test('runRpcChecks accepte une réponse PairCreated vide', async () => {
  const http = new MockChainClient(chain.id, 200n, []);
  const ws = new MockChainClient(chain.id, 199n);
  const report = await runRpcChecks({ http, ws });

  assert.equal(report.pairCreatedEventCount, 0);
  assert.equal(ws.closeCallCount, 1);
});

test('runRpcChecks valide explicitement BSC mainnet', async () => {
  const http = new MockChainClient(56, 200n, []);
  const ws = new MockChainClient(56, 200n, []);
  const report = await runRpcChecks(
    { http, ws },
    { expectedChainId: 56, network: 'mainnet' },
  );
  assert.equal(report.network, 'mainnet');
  assert.equal(report.expectedChainId, 56);
});

test('runRpcChecks valide explicitement BSC testnet', async () => {
  const http = new MockChainClient(97, 200n, []);
  const ws = new MockChainClient(97, 200n, []);
  const report = await runRpcChecks(
    { http, ws },
    { expectedChainId: 97, network: 'testnet' },
  );
  assert.equal(report.network, 'testnet');
  assert.equal(report.expectedChainId, 97);
});

test('runRpcChecks échoue en cas de chainId HTTP invalide', async () => {
  const http = new MockChainClient(1, 200n, []);
  const ws = new MockChainClient(chain.id, 200n, []);
  await assert.rejects(
    () => runRpcChecks({ http, ws }),
    /Le chainId HTTP ne correspond pas/,
  );
  assert.equal(ws.closeCallCount, 1);
});

test('runRpcChecks échoue en cas d’écart de tête anormal entre HTTP et WS', async () => {
  const http = new MockChainClient(chain.id, 200n, []);
  const ws = new MockChainClient(chain.id, 218n, []);
  await assert.rejects(
    () => runRpcChecks({ http, ws }),
    /Écart anormal entre HTTP \(200\) et WS \(218\)/u,
  );
  assert.equal(ws.closeCallCount, 1);
});

test('runRpcChecks échoue si eth_getLogs retourne une erreur RPC', async () => {
  const http = new MockChainClient(
    chain.id,
    123n,
    [],
    new Error('JSON-RPC error: eth_getLogs internal error'),
  );
  const ws = new MockChainClient(chain.id, 123n, []);
  await assert.rejects(
    () => runRpcChecks({ http, ws }),
    /eth_getLogs/,
  );
  assert.equal(ws.closeCallCount, 1);
});

test('sanitizeRpcError supprime toute URL complète', () => {
  assert.equal(
    sanitizeRpcError('échoue sur https://api.example.com/v1/abc123'),
    'échoue sur [REDACTED_RPC_URL]',
  );
  assert.equal(
    sanitizeRpcError('failed on wss://ws.example.com/path?token=abc123'),
    'failed on [REDACTED_RPC_URL]',
  );
});

test('runRpcChecks n’attend pas indéfiniment sur un WebSocket silencieux', async () => {
  const http = new MockChainClient(chain.id, 100n, []);
  const ws = new MockChainClient(chain.id, 100n, [], undefined, true);
  const started = Date.now();
  await assert.rejects(
    () => runRpcChecks({ http, ws }, { timeoutMs: 80 }),
    /timeout/,
  );
  const duration = Date.now() - started;
  assert.ok(duration < 500);
  assert.equal(ws.closeCallCount, 1);
});
