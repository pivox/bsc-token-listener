import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  type Hash,
  type Hex,
  type PublicClient,
  type WalletClient,
  webSocket,
} from 'viem';
import { privateKeyToAccount, type LocalAccount } from 'viem/accounts';
import { chain } from '../config/chain.js';
import { config } from '../config/env.js';
import {
  TransactionBroadcastRejectedError,
  TransactionBroadcastUnknownError,
} from '../execution/execution.types.js';
import {
  rpcUsage,
  type RpcUsageSnapshot,
  type RpcUsageTracker,
} from '../monitoring/rpc-usage.js';
import { errorMessage } from '../utils/error.js';
import { sanitizeRpcText } from '../utils/sanitize.js';

type RpcProviderKind = 'HTTP' | 'WEBSOCKET' | 'TX';
type RpcInternalStatus = 'up' | 'cooldown' | 'recovering';
type RpcStatus = 'up' | 'down';
type SleepFunction = (ms: number) => Promise<void>;
type RetryJitter = (delayMs: number, retry: number) => number;

type RpcProviderClient = PublicClient & {
  close?: () => Promise<void>;
};

type ReadContractInput = Parameters<PublicClient['readContract']>[0];
type SimulateContractInput = Parameters<PublicClient['simulateContract']>[0];
type GetBlockInput = Parameters<PublicClient['getBlock']>[0];
type GetBalanceInput = Parameters<PublicClient['getBalance']>[0];
type GetTransactionReceiptInput = Parameters<PublicClient['getTransactionReceipt']>[0];
type GetTransactionInput = Parameters<PublicClient['getTransaction']>[0];
type GetCodeInput = Parameters<PublicClient['getCode']>[0];
type GetTransactionCountInput = Parameters<PublicClient['getTransactionCount']>[0];
type WaitForTransactionReceiptInput = Parameters<PublicClient['waitForTransactionReceipt']>[0];
type WatchContractEventInput = Parameters<PublicClient['watchContractEvent']>[0];
type SendRawTransactionInput = Parameters<PublicClient['sendRawTransaction']>[0];
type GetContractEventsInput = Parameters<PublicClient['getContractEvents']>[0];
type GetLogsInput = Omit<GetContractEventsInput, 'fromBlock' | 'toBlock' | 'blockHash'> & {
  fromBlock: bigint;
  toBlock: bigint;
};

export interface RpcProviderDefinition {
  id: string;
  kind: RpcProviderKind;
  url: string;
  client: RpcProviderClient;
  maxLogBlockRange: number;
}

export interface RpcProviderStateSnapshot {
  id: string;
  kind: RpcProviderKind;
  status: RpcStatus;
  lagging: boolean;
  configuredMaxLogBlockRange: number;
  blockNumber: string | null;
  errorRate: number;
  latencyMs: number | null;
  switches: number;
  lastError: string | null;
  maxLogBlockRange: number;
  lastBlockAgeMs: number | null;
  lastWsMessageAgeMs: number | null;
  inCooldownUntilMs: number | null;
  consensusLag: string | null;
}

export type TransactionBroadcastState =
  | 'PENDING_BROADCAST'
  | 'UNKNOWN'
  | 'BROADCASTED'
  | 'REJECTED';

interface SentTransactionEntry {
  providerId: string;
  atMs: number;
  state: TransactionBroadcastState;
  error: string | null;
}

interface RpcProviderState {
  resultCount: number;
  errorCount: number;
  latencySamples: number[];
  lastBlockAtMs: number | null;
  lastBlockNumber: bigint | null;
  lastError: string | null;
  status: RpcInternalStatus;
  cooldownUntilMs: number | null;
  failureStreak: number;
  recoverySuccess: number;
  nextCooldownMs: number;
  lagging: boolean;
  lagDistance: bigint | null;
  lastWsMessageAtMs: number | null;
  switchCount: number;
  configuredMaxLogBlockRange: number;
  currentSafeLogBlockRange: number;
  stableSuccessfulLogReads: number;
}

class RpcProvider {
  private readonly state: RpcProviderState;

  constructor(
    readonly id: string,
    readonly kind: RpcProviderKind,
    readonly url: string,
    readonly client: RpcProviderClient,
    configuredMaxLogBlockRange: number,
    private readonly now: () => number,
  ) {
    const range = Math.max(1, Math.floor(configuredMaxLogBlockRange));
    this.state = {
      resultCount: 0,
      errorCount: 0,
      latencySamples: [],
      lastBlockAtMs: null,
      lastBlockNumber: null,
      lastError: null,
      status: 'up',
      cooldownUntilMs: null,
      failureStreak: 0,
      recoverySuccess: 0,
      nextCooldownMs: BASE_COOLDOWN_MS,
      lagging: false,
      lagDistance: null,
      lastWsMessageAtMs: this.now(),
      switchCount: 0,
      configuredMaxLogBlockRange: range,
      currentSafeLogBlockRange: range,
      stableSuccessfulLogReads: 0,
    };
  }

  get maxLogBlockRange(): number {
    return this.state.currentSafeLogBlockRange;
  }

  get configuredMaxLogBlockRange(): number {
    return this.state.configuredMaxLogBlockRange;
  }

  get status(): RpcStatus {
    this.refreshRecovery();
    if (this.state.status === 'cooldown') return 'down';
    return this.state.lagging ? 'down' : 'up';
  }

  get inCooldownUntilMs(): number | null {
    return this.state.status === 'cooldown' ? this.state.cooldownUntilMs : null;
  }

  get lagging(): boolean {
    return this.state.lagging;
  }

  get latencyMs(): number | null {
    if (this.state.latencySamples.length === 0) return null;
    return Math.round(
      this.state.latencySamples.reduce((sum, value) => sum + value, 0)
      / this.state.latencySamples.length,
    );
  }

  get errorRate(): number {
    if (this.state.resultCount === 0) return 0;
    return Math.round(this.state.errorCount / this.state.resultCount * 10_000) / 100;
  }

  get lastBlockNumber(): bigint | null {
    return this.state.lastBlockNumber;
  }

  get recovering(): boolean {
    this.refreshRecovery();
    return this.state.status === 'recovering';
  }

  markSwitch(): void {
    this.state.switchCount += 1;
  }

  markWsTechnicalMessage(): void {
    this.state.lastWsMessageAtMs = this.now();
  }

  markSuccess(latencyMs: number, blockNumber?: bigint): void {
    this.state.resultCount += 1;
    this.state.failureStreak = 0;
    this.state.lastError = null;
    this.state.latencySamples = [
      ...this.state.latencySamples.slice(-29),
      clampMs(latencyMs),
    ];
    if (blockNumber !== undefined) {
      if (this.state.lastBlockNumber === null || this.state.lastBlockNumber !== blockNumber) {
        this.state.lastBlockAtMs = this.now();
      }
      this.state.lastBlockNumber = blockNumber;
    }
    if (this.state.status === 'recovering') {
      this.state.recoverySuccess += 1;
      if (this.state.recoverySuccess < RECOVERY_SUCCESS_TARGET) return;
      this.state.nextCooldownMs = BASE_COOLDOWN_MS;
    }
    this.state.status = 'up';
    this.state.cooldownUntilMs = null;
    this.state.recoverySuccess = 0;
  }

  markFailure(error: unknown): void {
    this.recordError(error);
    this.state.recoverySuccess = 0;
    this.state.failureStreak += 1;
    if (this.state.failureStreak < FAILURE_THRESHOLD) return;
    this.state.status = 'cooldown';
    this.state.cooldownUntilMs = this.now() + this.state.nextCooldownMs;
    this.state.nextCooldownMs = Math.min(
      this.state.nextCooldownMs * 2,
      MAX_COOLDOWN_MS,
    );
    this.state.failureStreak = 0;
  }

  markSoftFailure(error: unknown): void {
    this.recordError(error);
  }

  markLagging(consensus: bigint | null): void {
    if (consensus === null || this.state.lastBlockNumber === null) {
      this.state.lagging = false;
      this.state.lagDistance = null;
      return;
    }
    const distance = this.state.lastBlockNumber > consensus
      ? this.state.lastBlockNumber - consensus
      : consensus - this.state.lastBlockNumber;
    this.state.lagging = distance > CONSENSUS_LAG_MAX;
    this.state.lagDistance = distance;
    if (this.state.lagging) {
      this.state.lastError = 'Provider en retard par rapport au consensus.';
    }
  }

  shrinkLogRange(): boolean {
    const previous = this.state.currentSafeLogBlockRange;
    this.state.currentSafeLogBlockRange = Math.max(1, Math.floor(previous / 2));
    this.state.stableSuccessfulLogReads = 0;
    return this.state.currentSafeLogBlockRange < previous;
  }

  recordSuccessfulLogRead(): void {
    if (
      this.state.currentSafeLogBlockRange >= this.state.configuredMaxLogBlockRange
    ) {
      this.state.stableSuccessfulLogReads = 0;
      return;
    }
    this.state.stableSuccessfulLogReads += 1;
    if (this.state.stableSuccessfulLogReads < LOG_RANGE_RECOVERY_SUCCESS_TARGET) return;
    this.state.currentSafeLogBlockRange = Math.min(
      this.state.configuredMaxLogBlockRange,
      this.state.currentSafeLogBlockRange + 1,
    );
    this.state.stableSuccessfulLogReads = 0;
  }

  setLastWsMessageAtMs(value: number | null): void {
    this.state.lastWsMessageAtMs = value;
  }

  snapshot(): RpcProviderStateSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      status: this.status,
      lagging: this.state.lagging,
      configuredMaxLogBlockRange: this.state.configuredMaxLogBlockRange,
      blockNumber: this.state.lastBlockNumber?.toString() ?? null,
      errorRate: this.errorRate,
      latencyMs: this.latencyMs,
      switches: this.state.switchCount,
      lastError: this.state.lastError,
      maxLogBlockRange: this.state.currentSafeLogBlockRange,
      lastBlockAgeMs: this.state.lastBlockAtMs === null
        ? null
        : clampMs(this.now() - this.state.lastBlockAtMs),
      lastWsMessageAgeMs: this.state.lastWsMessageAtMs === null
        ? null
        : clampMs(this.now() - this.state.lastWsMessageAtMs),
      inCooldownUntilMs: this.inCooldownUntilMs,
      consensusLag: this.state.lagDistance?.toString() ?? null,
    };
  }

  private recordError(error: unknown): void {
    this.state.resultCount += 1;
    this.state.errorCount += 1;
    this.state.lastError = sanitizeRpcText(errorMessage(error));
  }

  private refreshRecovery(): void {
    if (this.state.status !== 'cooldown') return;
    if (
      this.state.cooldownUntilMs === null
      || this.now() >= this.state.cooldownUntilMs
    ) {
      this.state.status = 'recovering';
      this.state.recoverySuccess = 0;
      this.state.failureStreak = 0;
    }
  }
}

function clampMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function withTimeoutMs<T>(action: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timeoutexceeded:${timeoutMs}`));
    }, timeoutMs);
    void action().then(
      (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function parseErrorCode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as { code?: unknown; status?: unknown };
  for (const value of [candidate.code, candidate.status]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^-?\d+$/u.test(value)) return Number(value);
  }
  return null;
}

function is429Error(error: unknown): boolean {
  const code = parseErrorCode(error);
  const message = errorMessage(error).toLowerCase();
  return code === 429 || message.includes('429') || message.includes('too many requests');
}

function isBusinessError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('execution reverted')
    || message.includes('insufficient output amount')
    || message.includes('token not compatible')
    || message.includes('token non compatible')
    || message.includes('nonce too low')
    || message.includes('transaction underpriced')
    || message.includes('invalid params')
    || message.includes('insufficient funds')
    || message.includes('intrinsic gas too low')
    || message.includes('transaction type not supported')
    || message.includes('already known')
    || message.includes('already imported')
    || message.includes('already exists');
}

function isRetriableError(error: unknown): boolean {
  if (isBusinessError(error)) return false;
  const code = parseErrorCode(error);
  const message = errorMessage(error).toLowerCase();
  if (code === 429 || code === -32005) return true;
  if (code !== null && code >= 500 && code <= 599) return true;
  return message.includes('timeout')
    || message.includes('timed out')
    || message.includes('provider down')
    || /\bprovider\b.*\bdown\b/u.test(message)
    || message.includes('unavailable')
    || message.includes('econnreset')
    || message.includes('econnrefused')
    || message.includes('econnaborted')
    || message.includes('enotfound')
    || message.includes('fetch failed')
    || message.includes('network')
    || message.includes('socket hang up')
    || message.includes('connection reset')
    || message.includes('connection closed')
    || message.includes('websocket')
    || message.includes('closed')
    || message.includes('eof')
    || message.includes('malformed response')
    || message.includes('invalid response')
    || message.includes('query returned more than')
    || message.includes('result set is too large')
    || message.includes('max block range')
    || message.includes('too many logs');
}

function isProviderHealthError(error: unknown): boolean {
  return isRetriableError(error)
    || errorMessage(error).toLowerCase().includes('provider en retard');
}

function isLogLimitError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  const code = parseErrorCode(error);
  return code === -32005
    || message.includes('query returned more than')
    || message.includes('result set is too large')
    || message.includes('max block range')
    || message.includes('too many logs')
    || message.includes('block range') && message.includes('too large');
}

function isAlreadyKnown(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('already known')
    || message.includes('already imported')
    || message.includes('already exists');
}

export function isTxRejectionError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('invalid sender')
    || message.includes('insufficient funds')
    || message.includes('intrinsic gas too low')
    || message.includes('transaction type not supported')
    || message.includes('nonce too low')
    || message.includes('replacement transaction underpriced')
    || message.includes('execution reverted');
}

function readRetryAfterMs(error: unknown, now: number): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as {
    headers?: Record<string, string | undefined> | Headers | Map<string, string>;
    response?: {
      headers?: Record<string, string | undefined> | Headers | Map<string, string>;
    };
    retryAfter?: string;
    'retry-after'?: string;
  };
  const headers = candidate.headers ?? candidate.response?.headers;
  let value: string | null = null;
  if (headers instanceof Headers) value = headers.get('retry-after');
  else if (headers instanceof Map) {
    value = headers.get('retry-after') ?? headers.get('Retry-After') ?? null;
  } else if (headers) {
    value = headers['retry-after'] ?? headers['Retry-After'] ?? null;
  }
  value ??= candidate.retryAfter ?? candidate['retry-after'] ?? null;
  if (value === null) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

class HttpReadRateLimiter {
  private nextAllowedAtMs = 0;
  private tail: Promise<void> = Promise.resolve();
  private readonly intervalMs: number;

  constructor(
    maxRequestsPerSecond: number,
    private readonly now: () => number,
    private readonly sleep: SleepFunction,
  ) {
    this.intervalMs = 1_000 / Math.max(1, Math.min(25, maxRequestsPerSecond));
  }

  acquire(): Promise<void> {
    const acquisition = this.tail.then(async () => {
      const waitMs = Math.max(0, Math.ceil(this.nextAllowedAtMs - this.now()));
      if (waitMs > 0) await this.sleep(waitMs);
      const acquiredAt = this.now();
      this.nextAllowedAtMs = Math.max(this.nextAllowedAtMs, acquiredAt) + this.intervalMs;
    });
    this.tail = acquisition.catch(() => {});
    return acquisition;
  }
}

export interface ProviderDefinitionList {
  readProviders?: RpcProviderDefinition[];
  wsProviders?: RpcProviderDefinition[];
  txProviders?: RpcProviderDefinition[];
  now?: () => number;
  sleep?: SleepFunction;
  maxHttpRps?: number;
  maxHttpRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  retryJitter?: RetryJitter;
  maxWsRetries?: number;
  wsRetryBaseDelayMs?: number;
  wsRetryMaxDelayMs?: number;
  usage?: RpcUsageTracker;
}

interface NetworkAttemptOptions {
  method: string;
  kind: RpcProviderKind;
  rateLimited: boolean;
}

export class RpcClientPool {
  private readonly now: () => number;
  private readonly sleep: SleepFunction;
  private readonly maxHttpRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retryJitter: RetryJitter;
  private readonly maxWsRetries: number;
  private readonly wsRetryBaseDelayMs: number;
  private readonly wsRetryMaxDelayMs: number;
  private readonly usage: RpcUsageTracker;
  private readonly readRateLimiter: HttpReadRateLimiter;
  private readonly readProviders: RpcProvider[];
  private readonly wsProviders: RpcProvider[];
  private readonly txProviders: RpcProvider[];
  private readonly knownTransactions = new Map<Hash, SentTransactionEntry>();
  private readCursor = -1;
  private wsCursor = -1;
  private txCursor = -1;
  private lastHeightRefreshMs = -PROVIDER_HEALTH_REFRESH_MS;

  constructor(options: ProviderDefinitionList = {}) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    }));
    this.maxHttpRetries = Math.max(0, options.maxHttpRetries ?? config.rpcMaxHttpRetries);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 250);
    this.retryMaxDelayMs = Math.max(this.retryBaseDelayMs, options.retryMaxDelayMs ?? 30_000);
    this.retryJitter = options.retryJitter ?? ((delay) =>
      Math.floor(delay + Math.random() * Math.min(250, delay * 0.25)));
    this.maxWsRetries = Math.max(0, options.maxWsRetries ?? 5);
    this.wsRetryBaseDelayMs = Math.max(0, options.wsRetryBaseDelayMs ?? 500);
    this.wsRetryMaxDelayMs = Math.max(
      this.wsRetryBaseDelayMs,
      options.wsRetryMaxDelayMs ?? 30_000,
    );
    this.usage = options.usage ?? rpcUsage;
    this.readRateLimiter = new HttpReadRateLimiter(
      options.maxHttpRps ?? config.rpcMaxHttpRps,
      this.now,
      this.sleep,
    );
    this.readProviders = this.makeProviders(
      options.readProviders ?? this.buildReadProviders(),
    );
    const wsDefinitions = options.wsProviders ?? this.buildWsProviders();
    this.wsProviders = this.makeProviders(wsDefinitions.length > 0
      ? wsDefinitions
      : this.readProviders.map((provider) => ({
        id: `${provider.id}-ws-fallback`,
        kind: 'WEBSOCKET' as const,
        url: provider.url,
        client: provider.client,
        maxLogBlockRange: provider.configuredMaxLogBlockRange,
      })));
    this.txProviders = this.makeProviders(
      options.txProviders ?? this.buildTxProviders(),
    );
  }

  private static sequence = 0;

  getPublicClient(): PublicClient {
    return {
      getChainId: () => this.executeRead('HTTP', 'eth_chainId', (provider) =>
        provider.client.getChainId()),
      getBlockNumber: () => this.executeRead('HTTP', 'eth_blockNumber', (provider) =>
        provider.client.getBlockNumber()),
      getBlock: (input: GetBlockInput) => this.executeRead('HTTP', 'eth_getBlockByNumber',
        (provider) => provider.client.getBlock(input)),
      readContract: (input: ReadContractInput) => this.executeRead('HTTP', 'eth_call',
        (provider) => provider.client.readContract(input)),
      simulateContract: (input: SimulateContractInput) => this.executeRead('HTTP', 'eth_call',
        (provider) => provider.client.simulateContract(input)),
      getBalance: (input: GetBalanceInput) => this.executeRead('HTTP', 'eth_getBalance',
        (provider) => provider.client.getBalance(input)),
      getTransactionReceipt: (input: GetTransactionReceiptInput) =>
        this.executeRead('HTTP', 'eth_getTransactionReceipt',
          (provider) => provider.client.getTransactionReceipt(input)),
      getTransaction: (input: GetTransactionInput) =>
        this.executeRead('HTTP', 'eth_getTransactionByHash',
          (provider) => provider.client.getTransaction(input)),
      getCode: (input: GetCodeInput) => this.executeRead('HTTP', 'eth_getCode',
        (provider) => provider.client.getCode(input)),
      getTransactionCount: (input: GetTransactionCountInput) =>
        this.executeRead('HTTP', 'eth_getTransactionCount',
          (provider) => provider.client.getTransactionCount(input)),
      getGasPrice: () => this.executeRead('HTTP', 'eth_gasPrice',
        (provider) => provider.client.getGasPrice()),
      getContractEvents: (input: GetLogsInput) => this.getContractEvents(input),
      waitForTransactionReceipt: (input: WaitForTransactionReceiptInput) =>
        this.executeRead('HTTP', 'eth_waitForTransactionReceipt',
          (provider) => provider.client.waitForTransactionReceipt(input)),
    } as unknown as PublicClient;
  }

  getWsClient(): PublicClient {
    return {
      getChainId: () => this.executeRead('WEBSOCKET', 'eth_chainId', (provider) =>
        provider.client.getChainId()),
      getBlockNumber: () => this.executeRead('WEBSOCKET', 'eth_blockNumber', (provider) =>
        provider.client.getBlockNumber()),
      getBlock: (input: GetBlockInput) => this.executeRead('WEBSOCKET', 'eth_getBlockByNumber',
        (provider) => provider.client.getBlock(input)),
      readContract: (input: ReadContractInput) => this.executeRead('WEBSOCKET', 'eth_call',
        (provider) => provider.client.readContract(input)),
      watchContractEvent: (input: WatchContractEventInput) => this.watchContractEvent(input),
      close: () => this.closeProviders(this.wsProviders),
    } as unknown as PublicClient;
  }

  getTxClient(): PublicClient {
    return {
      sendRawTransaction: (input: SendRawTransactionInput) =>
        this.sendRawTransaction(input.serializedTransaction),
      getTransactionReceipt: (input: GetTransactionReceiptInput) =>
        this.executeRead('TX', 'eth_getTransactionReceipt',
          (provider) => provider.client.getTransactionReceipt(input)),
      getTransaction: (input: GetTransactionInput) =>
        this.executeRead('TX', 'eth_getTransactionByHash',
          (provider) => provider.client.getTransaction(input)),
      waitForTransactionReceipt: (input: WaitForTransactionReceiptInput) =>
        this.executeRead('TX', 'eth_waitForTransactionReceipt',
          (provider) => provider.client.waitForTransactionReceipt(input)),
      getBalance: (input: GetBalanceInput) => this.executeRead('TX', 'eth_getBalance',
        (provider) => provider.client.getBalance(input)),
      getCode: (input: GetCodeInput) => this.executeRead('TX', 'eth_getCode',
        (provider) => provider.client.getCode(input)),
      getTransactionCount: (input: GetTransactionCountInput) =>
        this.executeRead('TX', 'eth_getTransactionCount',
          (provider) => provider.client.getTransactionCount(input)),
    } as unknown as PublicClient;
  }

  get estimateClient(): PublicClient {
    return this.getPublicClient();
  }

  get nonceClient(): PublicClient {
    return this.getPublicClient();
  }

  forTestGetProviderSnapshotById(id: string): RpcProviderStateSnapshot | undefined {
    return this.allProviders().find((provider) => provider.id === id)?.snapshot();
  }

  forTestSetProviderWsMessageAge(id: string, atMs: number | null): boolean {
    const provider = this.wsProviders.find((candidate) => candidate.id === id);
    if (!provider) return false;
    provider.setLastWsMessageAtMs(atMs);
    return true;
  }

  forTestGetTransactionState(hash: Hash): TransactionBroadcastState | null {
    return this.getKnownTransaction(hash)?.state ?? null;
  }

  async getProviderSnapshots(): Promise<RpcProviderStateSnapshot[]> {
    await this.refreshProviderHeights();
    return this.allProviders().map((provider) => provider.snapshot());
  }

  async close(): Promise<void> {
    await this.closeProviders(this.allProviders());
  }

  private makeProviders(definitions: RpcProviderDefinition[]): RpcProvider[] {
    return definitions.map((definition) => new RpcProvider(
      definition.id,
      definition.kind,
      definition.url,
      definition.client,
      definition.maxLogBlockRange,
      this.now,
    ));
  }

  private buildReadProviders(): RpcProviderDefinition[] {
    return config.httpRpcUrls.map((url) => ({
      id: `http-${RpcClientPool.nextId()}`,
      kind: 'HTTP',
      url,
      client: RpcClientPool.createHttpClient(url),
      maxLogBlockRange: config.rpcMaxLogBlockRange,
    }));
  }

  private buildWsProviders(): RpcProviderDefinition[] {
    return config.wsRpcUrls.map((url) => ({
      id: `ws-${RpcClientPool.nextId()}`,
      kind: 'WEBSOCKET',
      url,
      client: RpcClientPool.createWebSocketClient(url),
      maxLogBlockRange: config.rpcMaxLogBlockRange,
    }));
  }

  private buildTxProviders(): RpcProviderDefinition[] {
    const url = config.txRpcUrl ?? config.httpRpcUrl;
    return [{
      id: `tx-${RpcClientPool.nextId()}`,
      kind: 'TX',
      url,
      client: RpcClientPool.createHttpClient(url),
      maxLogBlockRange: config.rpcMaxLogBlockRange,
    }];
  }

  private static nextId(): string {
    RpcClientPool.sequence += 1;
    return RpcClientPool.sequence.toString().padStart(3, '0');
  }

  private static createHttpClient(url: string): RpcProviderClient {
    return createPublicClient({
      chain,
      transport: http(url, { timeout: REQUEST_TIMEOUTS.HTTP }),
    }) as RpcProviderClient;
  }

  private static createWebSocketClient(url: string): RpcProviderClient {
    return createPublicClient({
      chain,
      transport: webSocket(url, { timeout: REQUEST_TIMEOUTS.WEBSOCKET }),
    }) as RpcProviderClient;
  }

  private async executeRead<T>(
    kind: RpcProviderKind,
    method: string,
    action: (provider: RpcProvider) => Promise<T>,
  ): Promise<T> {
    const providers = kind === 'HTTP'
      ? this.readProviders
      : kind === 'WEBSOCKET'
        ? this.wsProviders
        : this.txProviders;
    const selected = this.rotate(this.sortByHealth(this.selectProviders(providers, true)), kind);
    if (selected.length === 0) {
      throw new Error(`Aucun provider ${kind} disponible pour ${method}.`);
    }
    let lastError: unknown = null;
    const attemptCount = this.maxHttpRetries + 1;
    for (let attempt = 0; attempt < attemptCount; attempt += 1) {
      const provider = selected[attempt % selected.length];
      if (!provider) break;
      provider.markSwitch();
      try {
        return await this.performNetworkAttempt(provider, () => action(provider), {
          method,
          kind,
          rateLimited: kind !== 'WEBSOCKET',
        });
      } catch (error) {
        lastError = error;
        if (!isRetriableError(error) || attempt >= attemptCount - 1) throw error;
        this.usage.recordMethodRetry(method);
        const nextProvider = selected[(attempt + 1) % selected.length];
        if (nextProvider && nextProvider.id !== provider.id) {
          this.usage.recordMethodFailover(method);
        }
        await this.sleep(this.retryDelay(error, attempt + 1));
      }
    }
    throw normalizeReadError(lastError, method);
  }

  private async getContractEvents(input: GetLogsInput): Promise<readonly unknown[]> {
    if (typeof input.fromBlock !== 'bigint' || typeof input.toBlock !== 'bigint') {
      throw new Error('Les bornes de getContractEvents doivent être des bigint.');
    }
    const selected = this.rotate(
      this.sortByHealth(this.selectProviders(this.readProviders, true)),
      'HTTP',
    );
    if (selected.length === 0) {
      throw new Error('Aucun provider HTTP disponible pour getContractEvents.');
    }
    let lastError: unknown = null;
    const attemptCount = this.maxHttpRetries + 1;
    for (let attempt = 0; attempt < attemptCount; attempt += 1) {
      const provider = selected[attempt % selected.length];
      if (!provider) break;
      provider.markSwitch();
      try {
        return await this.readContractEventsWithProvider(provider, input);
      } catch (error) {
        lastError = error;
        if (!isRetriableError(error) || attempt >= attemptCount - 1) break;
        this.usage.recordMethodRetry('eth_getLogs');
        const nextProvider = selected[(attempt + 1) % selected.length];
        if (nextProvider && nextProvider.id !== provider.id) {
          this.usage.recordMethodFailover('eth_getLogs');
        }
        await this.sleep(this.retryDelay(error, attempt + 1));
      }
    }
    if (lastError && !isRetriableError(lastError)) throw lastError;
    throw new Error('Aucun provider HTTP disponible pour eth_getLogs.');
  }

  private async readContractEventsWithProvider(
    provider: RpcProvider,
    input: GetLogsInput,
  ): Promise<readonly unknown[]> {
    let cursor = input.fromBlock;
    let output: unknown[] = [];
    while (cursor <= input.toBlock) {
      const range = BigInt(provider.maxLogBlockRange);
      const chunkEnd = cursor + range - 1n > input.toBlock
        ? input.toBlock
        : cursor + range - 1n;
      try {
        const chunk = await this.performNetworkAttempt(
          provider,
          () => provider.client.getContractEvents({
            ...input,
            fromBlock: cursor,
            toBlock: chunkEnd,
          }),
          { method: 'eth_getLogs', kind: 'HTTP', rateLimited: true },
        );
        output.push(...chunk);
        provider.recordSuccessfulLogRead();
        cursor = chunkEnd + 1n;
      } catch (error) {
        if (!isLogLimitError(error)) throw error;
        const reduced = provider.shrinkLogRange();
        if (!reduced) throw error;
        this.usage.recordMethodRetry('eth_getLogs');
        cursor = input.fromBlock;
        output = [];
      }
    }
    return output;
  }

  private watchContractEvent(input: WatchContractEventInput): () => void {
    const state = {
      activeStop: null as (() => void) | null,
      stopped: false,
      reconnecting: false,
      retries: 0,
      generation: 0,
      provider: null as RpcProvider | null,
    };

    const stopCurrent = (): void => {
      const stop = state.activeStop;
      state.activeStop = null;
      if (!stop) return;
      try {
        stop();
      } catch {
        // La souscription est déjà considérée arrêtée localement.
      }
    };

    const install = (avoidProviderId?: string): void => {
      if (state.stopped) return;
      const candidates = this.rotate(
        this.sortByHealth(this.selectProviders(this.wsProviders, true)),
        'WEBSOCKET',
      );
      const provider = candidates.find((candidate) => candidate.id !== avoidProviderId)
        ?? candidates[0];
      if (!provider) {
        input.onError?.(new Error('Aucun provider WebSocket disponible.'));
        return;
      }
      stopCurrent();
      state.provider = provider;
      provider.markSwitch();
      this.usage.recordMethodCall('eth_subscribe', provider.id);
      const startedAt = this.now();
      try {
        const stop = provider.client.watchContractEvent({
          ...input,
          onLogs: (logs) => {
            input.onLogs(logs);
          },
          onError: (error) => scheduleReconnect(error),
        });
        state.activeStop = stop;
        provider.markSuccess(this.now() - startedAt);
        this.usage.recordMethodSuccess('eth_subscribe', this.now() - startedAt);
      } catch (error) {
        scheduleReconnect(error);
      }
    };

    const scheduleReconnect = (error: unknown): void => {
      if (state.stopped || state.reconnecting) return;
      const normalizedError = error instanceof Error ? error : new Error(String(error));
      const failedProvider = state.provider;
      stopCurrent();
      this.usage.recordMethodError('eth_subscribe', is429Error(normalizedError));
      failedProvider?.markFailure(normalizedError);
      input.onError?.(normalizedError);
      state.retries += 1;
      if (state.retries > this.maxWsRetries) return;
      state.reconnecting = true;
      const generation = ++state.generation;
      const exponential = Math.min(
        this.wsRetryMaxDelayMs,
        this.wsRetryBaseDelayMs * 2 ** Math.max(0, state.retries - 1),
      );
      const delay = Math.max(0, this.retryJitter(exponential, state.retries));
      this.usage.recordMethodRetry('eth_subscribe');
      void this.sleep(delay).then(() => {
        if (state.stopped || generation !== state.generation) return;
        state.reconnecting = false;
        if (failedProvider) this.usage.recordMethodFailover('eth_subscribe');
        install(failedProvider?.id);
      }).catch(() => {
        state.reconnecting = false;
      });
    };

    install();
    return () => {
      if (state.stopped) return;
      state.stopped = true;
      state.generation += 1;
      stopCurrent();
    };
  }

  private async sendRawTransaction(serializedTransaction: Hex): Promise<Hash> {
    const hash = keccak256(serializedTransaction);
    const known = this.getKnownTransaction(hash);
    if (known) {
      if (known.state === 'BROADCASTED') return hash;
      if (known.state === 'REJECTED') {
        throw new TransactionBroadcastRejectedError(hash, known.error ?? 'Diffusion rejetée.');
      }
      throw new TransactionBroadcastUnknownError(hash, 'Diffusion déjà en cours ou ambiguë.');
    }
    const provider = this.selectProviders(this.txProviders, false)[0];
    if (!provider) throw new Error('Aucun provider de diffusion disponible.');
    this.rememberTransaction(hash, provider.id, 'PENDING_BROADCAST', null);
    try {
      await this.performNetworkAttempt(
        provider,
        async () => {
          const response = await provider.client.sendRawTransaction({
            serializedTransaction,
          });
          if (typeof response !== 'string' || !/^0x[a-fA-F0-9]{64}$/u.test(response)) {
            throw new Error('Réponse sendRawTransaction invalide.');
          }
          if (response.toLowerCase() !== hash.toLowerCase()) {
            throw new Error('Hash RPC inattendu après diffusion.');
          }
          return response;
        },
        { method: 'eth_sendRawTransaction', kind: 'TX', rateLimited: false },
      );
      this.rememberTransaction(hash, provider.id, 'BROADCASTED', null);
      return hash;
    } catch (error) {
      if (isAlreadyKnown(error)) {
        this.rememberTransaction(hash, provider.id, 'BROADCASTED', null);
        return hash;
      }
      const safeError = sanitizeRpcText(errorMessage(error));
      if (isTxRejectionError(error)) {
        this.rememberTransaction(hash, provider.id, 'REJECTED', safeError);
        throw new TransactionBroadcastRejectedError(hash, safeError, { cause: error });
      }
      this.rememberTransaction(hash, provider.id, 'UNKNOWN', safeError);
      throw new TransactionBroadcastUnknownError(hash, safeError, { cause: error });
    }
  }

  private async performNetworkAttempt<T>(
    provider: RpcProvider,
    action: () => Promise<T>,
    options: NetworkAttemptOptions,
  ): Promise<T> {
    if (options.rateLimited) await this.readRateLimiter.acquire();
    this.usage.recordMethodCall(options.method, provider.id);
    const startedAt = this.now();
    try {
      const response = await withTimeoutMs(action, REQUEST_TIMEOUTS[options.kind]);
      const latency = this.now() - startedAt;
      const blockNumber = options.method === 'eth_blockNumber' && typeof response === 'bigint'
        ? response
        : undefined;
      provider.markSuccess(latency, blockNumber);
      if (provider.kind === 'WEBSOCKET') provider.markWsTechnicalMessage();
      this.usage.recordMethodSuccess(options.method, latency);
      return response;
    } catch (error) {
      const latency = this.now() - startedAt;
      this.usage.recordMethodError(options.method, is429Error(error), latency);
      if (isBusinessError(error) || isLogLimitError(error)) provider.markSoftFailure(error);
      else if (isProviderHealthError(error)) provider.markFailure(error);
      else provider.markSoftFailure(error);
      throw error;
    }
  }

  private retryDelay(error: unknown, retry: number): number {
    const retryAfter = is429Error(error) ? readRetryAfterMs(error, this.now()) : null;
    if (retryAfter !== null) return Math.min(this.retryMaxDelayMs, retryAfter);
    const exponential = Math.min(
      this.retryMaxDelayMs,
      this.retryBaseDelayMs * 2 ** Math.max(0, retry - 1),
    );
    return Math.max(0, Math.min(
      this.retryMaxDelayMs,
      this.retryJitter(exponential, retry),
    ));
  }

  private async refreshProviderHeights(): Promise<void> {
    const now = this.now();
    if (now - this.lastHeightRefreshMs < PROVIDER_HEALTH_REFRESH_MS) return;
    this.lastHeightRefreshMs = now;
    const providers = this.allProviders();
    const results = await Promise.all(providers.map(async (provider) => {
      try {
        const blockNumber = await this.performNetworkAttempt(
          provider,
          () => provider.client.getBlockNumber(),
          {
            method: 'eth_blockNumber',
            kind: provider.kind,
            rateLimited: provider.kind !== 'WEBSOCKET',
          },
        );
        return { provider, blockNumber };
      } catch {
        return { provider, blockNumber: null };
      }
    }));
    const readHeights = results
      .filter((entry) => entry.provider.kind === 'HTTP' && entry.blockNumber !== null)
      .map((entry) => entry.blockNumber)
      .filter((value): value is bigint => value !== null)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const consensus = readHeights[Math.floor(readHeights.length / 2)] ?? null;
    for (const provider of providers) provider.markLagging(consensus);
  }

  private selectProviders(providers: RpcProvider[], allowRecovering: boolean): RpcProvider[] {
    const healthy = providers.filter((provider) => provider.status === 'up' && !provider.lagging);
    if (healthy.length > 0) return healthy;
    return allowRecovering
      ? providers.filter((provider) => provider.recovering)
      : [];
  }

  private sortByHealth(providers: RpcProvider[]): RpcProvider[] {
    return [...providers].sort((left, right) => {
      const errorDifference = left.errorRate - right.errorRate;
      if (errorDifference !== 0) return errorDifference;
      return (left.latencyMs ?? 0) - (right.latencyMs ?? 0);
    });
  }

  private rotate(providers: RpcProvider[], kind: RpcProviderKind): RpcProvider[] {
    if (providers.length === 0) return [];
    if (kind === 'HTTP') this.readCursor += 1;
    else if (kind === 'WEBSOCKET') this.wsCursor += 1;
    else this.txCursor += 1;
    const cursor = kind === 'HTTP'
      ? this.readCursor
      : kind === 'WEBSOCKET'
        ? this.wsCursor
        : this.txCursor;
    const start = cursor % providers.length;
    return providers.map((_provider, offset) => providers[(start + offset) % providers.length]!) ;
  }

  private allProviders(): RpcProvider[] {
    return [...this.readProviders, ...this.wsProviders, ...this.txProviders];
  }

  private async closeProviders(providers: RpcProvider[]): Promise<void> {
    await Promise.all(providers.map(async (provider) => {
      if (provider.client.close) await provider.client.close();
    }));
  }

  private getKnownTransaction(hash: Hash): SentTransactionEntry | null {
    const entry = this.knownTransactions.get(hash);
    if (!entry) return null;
    if (this.now() - entry.atMs > KNOWN_TRANSACTION_TTL_MS) {
      this.knownTransactions.delete(hash);
      return null;
    }
    return entry;
  }

  private rememberTransaction(
    hash: Hash,
    providerId: string,
    state: TransactionBroadcastState,
    error: string | null,
  ): void {
    this.knownTransactions.set(hash, {
      providerId,
      atMs: this.now(),
      state,
      error,
    });
  }
}

function normalizeReadError(error: unknown, method: string): Error {
  return new Error(`${method} indisponible: ${sanitizeRpcText(errorMessage(error))}`);
}

const REQUEST_TIMEOUTS: Record<RpcProviderKind, number> = {
  HTTP: 8_000,
  WEBSOCKET: 10_000,
  TX: 8_000,
};
const FAILURE_THRESHOLD = 2;
const BASE_COOLDOWN_MS = 8_000;
const MAX_COOLDOWN_MS = 60_000;
const RECOVERY_SUCCESS_TARGET = 2;
const CONSENSUS_LAG_MAX = 16n;
const PROVIDER_HEALTH_REFRESH_MS = 5_000;
const LOG_RANGE_RECOVERY_SUCCESS_TARGET = 3;
const KNOWN_TRANSACTION_TTL_MS = 24 * 60 * 60 * 1000;

const pool = new RpcClientPool();

export function createRpcClientPoolForTest(
  options: ProviderDefinitionList = {},
): RpcClientPool {
  return new RpcClientPool(options);
}

export const account: LocalAccount | undefined = config.privateKey
  ? privateKeyToAccount(config.privateKey)
  : undefined;
export const publicClient = pool.getPublicClient();
export const wsClient = pool.getWsClient();
export const txClient = pool.getTxClient();
export const estimateClient = pool.estimateClient;
export const nonceClient = pool.nonceClient;
export const walletClient: WalletClient | undefined = account
  ? createWalletClient({
    chain,
    account,
    transport: http(config.txRpcUrl ?? config.httpRpcUrl, {
      timeout: REQUEST_TIMEOUTS.TX,
    }),
  })
  : undefined;

export async function getRpcProviderSnapshots(): Promise<RpcProviderStateSnapshot[]> {
  return pool.getProviderSnapshots();
}

export async function getRpcUsageSnapshot(): Promise<RpcUsageSnapshot> {
  return rpcUsage.getSnapshot();
}

export function getRpcClientPoolForTest(): RpcClientPool {
  return pool;
}
