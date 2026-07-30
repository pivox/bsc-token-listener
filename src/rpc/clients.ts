import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  type Hash,
  type PublicClient,
  type WalletClient,
  webSocket,
} from 'viem';
import { privateKeyToAccount, type LocalAccount } from 'viem/accounts';
import { chain } from '../config/chain.js';
import { config } from '../config/env.js';
import { errorMessage } from '../utils/error.js';
import { sanitizeRpcText } from '../utils/sanitize.js';

type RpcProviderKind = 'HTTP' | 'WEBSOCKET' | 'TX';

type RpcInternalStatus = 'up' | 'down' | 'cooldown' | 'recovering';

type RpcStatus = 'up' | 'down';

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

interface SentTransactionEntry {
  providerId: string;
  atMs: number;
}

interface RpcProviderState {
  resultCount: number;
  errorCount: number;
  latencySamples: number[];
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
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
  lastSwitchAtMs: number | null;
}

class RpcProvider {
  private readonly state: RpcProviderState = {
    resultCount: 0,
    errorCount: 0,
    latencySamples: [],
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
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
    lastWsMessageAtMs: nowMs(),
    switchCount: 0,
    lastSwitchAtMs: null,
  };

  constructor(
    readonly id: string,
    readonly kind: RpcProviderKind,
    readonly url: string,
    readonly client: RpcProviderClient,
    private maxLogBlockRangeInput: number,
  ) {}

  get maxLogBlockRange(): number {
    return this.maxLogBlockRangeInput;
  }

  get status(): RpcStatus {
    this.refreshRecovery();
    if (this.state.status === 'down') return 'down';
    if (this.state.status === 'cooldown') return 'down';
    return this.state.lagging ? 'down' : 'up';
  }

  get inCooldownUntilMs(): number | null {
    return this.state.status === 'cooldown' ? this.state.cooldownUntilMs : null;
  }

  get lagging(): boolean {
    return this.state.lagging;
  }

  get consensusLag(): bigint | null {
    return this.state.lagDistance;
  }

  get latencyMs(): number | null {
    if (this.state.latencySamples.length === 0) return null;
    const sum = this.state.latencySamples.reduce((acc, value) => acc + value, 0);
    return Math.round(sum / this.state.latencySamples.length);
  }

  get lastError(): string | null {
    return this.state.lastError;
  }

  get errorRate(): number {
    if (this.state.resultCount === 0) return 0;
    return Math.round((this.state.errorCount / this.state.resultCount) * 10000) / 100;
  }

  get lastBlockAgeMs(): number | null {
    if (this.state.lastBlockAtMs === null) return null;
    return clampMs(Date.now() - this.state.lastBlockAtMs);
  }

  get lastWsMessageAgeMs(): number | null {
    if (this.state.lastWsMessageAtMs === null) return null;
    return clampMs(Date.now() - this.state.lastWsMessageAtMs);
  }

  get lastBlockNumber(): bigint | null {
    return this.state.lastBlockNumber;
  }

  get switches(): number {
    return this.state.switchCount;
  }

  get recovering(): boolean {
    this.refreshRecovery();
    return this.state.status === 'recovering';
  }

  get up(): boolean {
    return this.status === 'up';
  }

  private refreshRecovery(): void {
    if (this.state.status !== 'cooldown') return;
    if (this.state.cooldownUntilMs === null) {
      this.state.status = 'recovering';
      this.state.recoverySuccess = 0;
      this.state.failureStreak = 0;
      return;
    }
    if (Date.now() >= this.state.cooldownUntilMs) {
      this.state.status = 'recovering';
      this.state.recoverySuccess = 0;
      this.state.failureStreak = 0;
    }
  }

  markSwitch(): void {
    this.state.switchCount += 1;
    this.state.lastSwitchAtMs = Date.now();
  }

  markWsMessage(): void {
    this.state.lastWsMessageAtMs = Date.now();
  }

  markSuccess(latencyMs?: number, blockNumber?: bigint): void {
    this.state.resultCount += 1;
    this.state.failureStreak = 0;
    this.state.lastSuccessAtMs = Date.now();
    this.state.lastFailureAtMs = null;
    if (typeof latencyMs === 'number') {
      this.state.latencySamples = [...this.state.latencySamples.slice(-29), clampMs(latencyMs)];
    }
    this.state.lastError = null;
    this.state.lastBlockAtMs = Date.now();
    if (blockNumber !== undefined) this.state.lastBlockNumber = blockNumber;

    if (this.state.status === 'recovering') {
      this.state.recoverySuccess += 1;
      if (this.state.recoverySuccess >= RECOVERY_SUCCESS_TARGET) {
        this.state.status = 'up';
        this.state.nextCooldownMs = BASE_COOLDOWN_MS;
        this.state.recoverySuccess = 0;
        this.state.failureStreak = 0;
        this.state.lagging = false;
      }
      return;
    }

    this.state.status = 'up';
    this.state.recoverySuccess = 0;
    this.state.failureStreak = 0;
  }

  markFailure(error: unknown, retryable: boolean): void {
    const sanitized = sanitizeRpcText(errorMessage(error));
    this.state.resultCount += 1;
    this.state.errorCount += 1;
    this.state.lastError = sanitized;
    this.state.lastFailureAtMs = Date.now();
    if (!retryable) {
      this.state.status = 'down';
      this.state.cooldownUntilMs = Date.now() + BASE_COOLDOWN_MS;
      return;
    }

    if (this.state.status === 'recovering') {
      this.state.recoverySuccess = 0;
    }
    this.state.failureStreak += 1;
    if (this.state.failureStreak >= FAILURE_THRESHOLD) {
      this.state.status = 'cooldown';
      this.state.cooldownUntilMs = Date.now() + this.state.nextCooldownMs;
      this.state.nextCooldownMs = Math.min(this.state.nextCooldownMs * 2, MAX_COOLDOWN_MS);
      this.state.failureStreak = 0;
    }
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
  }

  shrinkLogRange(): void {
    const next = Math.max(1, Math.floor(this.maxLogBlockRangeInput / 2));
    this.maxLogBlockRangeInput = next;
  }

  resetLogRange(): void {
    this.maxLogBlockRangeInput = config.rpcMaxLogBlockRange;
  }

  snapshot(): RpcProviderStateSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      status: this.status,
      lagging: this.state.lagging,
      blockNumber: this.state.lastBlockNumber?.toString() ?? null,
      errorRate: this.errorRate,
      latencyMs: this.latencyMs,
      switches: this.state.switchCount,
      lastError: this.state.lastError,
      maxLogBlockRange: this.maxLogBlockRange,
      lastBlockAgeMs: this.lastBlockAgeMs,
      lastWsMessageAgeMs: this.lastWsMessageAgeMs,
      inCooldownUntilMs: this.inCooldownUntilMs,
      consensusLag: this.state.lagDistance?.toString() ?? null,
    };
  }

  setLastWsMessageAtMs(value: number | null): void {
    this.state.lastWsMessageAtMs = value;
  }
}

interface TimedFailure {
  count: number;
  lastAtMs: number;
}

function clampMs(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function nowMs(): number {
  return Date.now();
}

function withTimeoutMs<T>(action: () => Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    action(),
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => {
        reject(new Error(`timeoutexceeded:${timeoutMs}`));
      }, timeoutMs);
    }),
  ]);
}

function isKnownTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('timeoutexceeded')
    || error.message.toLowerCase().includes('timeout')
    || error.message.toLowerCase().includes('timed out');
}

function parseErrorCode(error: unknown): number | null {
  if (!(typeof error === 'object') || error === null) return null;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    name?: unknown;
  };

  if (typeof candidate.code === 'number') return candidate.code;
  if (typeof candidate.code === 'string' && /^\d+$/.test(candidate.code)) {
    const parsed = Number(candidate.code);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.status === 'string' && /^\d+$/.test(candidate.status)) {
    const parsed = Number(candidate.status);
    if (Number.isFinite(parsed)) return parsed;
  }

  return null;
}

function isRetriableError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  const code = parseErrorCode(error);
  if (code !== null && (code === 429 || code === -32005)) return true;
  return message.includes('timeout')
    || message.includes('provider down')
    || /\bprovider\b.*\bdown\b/u.test(message)
    || message.includes('unavailable')
    || message.includes('timed out')
    || message.includes('econnreset')
    || message.includes('econnrefused')
    || message.includes('econnaborted')
    || message.includes('network')
    || message.includes('enotfound')
    || message.includes('fetch failed')
    || message.includes('socket hang up')
    || message.includes('connection aborted')
    || message.includes('connection reset')
    || message.includes('eof')
    || message.includes('websocket')
    || isKnownTimeout(error);
}

function isLogLimitError(error: unknown): boolean {
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  const code = parseErrorCode(error);
  return code === -32005
    || lower.includes('query returned more than')
    || lower.includes('result set is too large')
    || lower.includes('max block range')
    || lower.includes('block range') && lower.includes('too large')
    || lower.includes('too many logs');
}

function isAlreadyKnown(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes('already known')
    || message.includes('already exists')
    || message.includes('already imported');
}

function extractRpcHash(message: string): Hash | null {
  const match = message.match(/0x[a-fA-F0-9]{64}/u);
  return match?.[0] ? (match[0] as Hash) : null;
}

interface RpcCallOptions {
  method: string;
  idempotent: boolean;
  kind: RpcProviderKind;
}

export interface ProviderDefinitionList {
  readProviders?: RpcProviderDefinition[];
  wsProviders?: RpcProviderDefinition[];
  txProviders?: RpcProviderDefinition[];
}

export class RpcClientPool {
  private readonly readProviders: RpcProvider[];
  private readonly wsProviders: RpcProvider[];
  private readonly txProviders: RpcProvider[];
  private readonly knownTransactions = new Map<Hash, SentTransactionEntry>();
  private readonly failuresByMethod = new Map<string, TimedFailure>();
  private readCursor = -1;
  private wsCursor = 0;
  private txCursor = 0;
  private lastHeightRefreshMs = -PROVIDER_HEALTH_REFRESH_MS;

  constructor(options: ProviderDefinitionList = {}) {
    this.readProviders = (options.readProviders ?? this.buildReadProviders()).map((definition) =>
      new RpcProvider(
        definition.id,
        definition.kind,
        definition.url,
        definition.client,
        definition.maxLogBlockRange,
      ),
    );

    const wsProviders = options.wsProviders ?? this.buildWsProviders();
    this.wsProviders = (wsProviders.length === 0
      ? this.readProviders.map((provider) => ({
        id: `${provider.id}-ws-fallback`,
        kind: 'WEBSOCKET' as const,
        url: provider.url,
        client: provider.client,
        maxLogBlockRange: provider.maxLogBlockRange,
      }))
      : wsProviders
    ).map((definition) =>
      new RpcProvider(
        definition.id,
        definition.kind,
        definition.url,
        definition.client,
        definition.maxLogBlockRange,
      ),
    );

    this.txProviders = (options.txProviders ?? this.buildTxProviders()).map((definition) =>
      new RpcProvider(
        definition.id,
        definition.kind,
        definition.url,
        definition.client,
        definition.maxLogBlockRange,
      ),
    );
  }

  private static sequence = 0;

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
      transport: webSocket(url, {
        timeout: REQUEST_TIMEOUTS.WEBSOCKET,
      }),
    }) as RpcProviderClient;
  }

  private buildReadProviders(): RpcProviderDefinition[] {
    const candidates = config.httpRpcUrls.length > 0
      ? config.httpRpcUrls
      : [config.httpRpcUrl];
    return candidates.map((url) => ({
      id: `http-${RpcClientPool.nextId()}`,
      kind: 'HTTP',
      url,
      client: RpcClientPool.createHttpClient(url),
      maxLogBlockRange: config.rpcMaxLogBlockRange,
    }));
  }

  private buildWsProviders(): RpcProviderDefinition[] {
    const candidates = config.wsRpcUrls;
    return candidates.map((url) => ({
      id: `ws-${RpcClientPool.nextId()}`,
      kind: 'WEBSOCKET',
      url,
      client: RpcClientPool.createWebSocketClient(url),
      maxLogBlockRange: config.rpcMaxLogBlockRange,
    }));
  }

  private buildTxProviders(): RpcProviderDefinition[] {
    const candidates = config.txRpcUrl
      ? [config.txRpcUrl]
      : [config.httpRpcUrl];
    return candidates.map((url) => ({
      id: `tx-${RpcClientPool.nextId()}`,
      kind: 'TX',
      url,
      client: RpcClientPool.createHttpClient(url),
      maxLogBlockRange: config.rpcMaxLogBlockRange,
    }));
  }

  getPublicClient(): PublicClient {
    return {
      getChainId: () => this.executeRead<number>({
        action: (provider) => provider.client.getChainId(),
        method: 'eth_chainId',
        idempotent: true,
        providerKind: 'HTTP',
      }),
      getBlockNumber: () => this.executeRead<bigint>({
        action: (provider) => provider.client.getBlockNumber(),
        method: 'eth_blockNumber',
        idempotent: true,
        providerKind: 'HTTP',
      }),
      getBlock: (input: GetBlockInput) => this.executeRead({
        action: (provider) => provider.client.getBlock(input),
        method: 'eth_getBlockByNumber',
        idempotent: true,
        providerKind: 'HTTP',
      }),
      readContract: (input: ReadContractInput) => this.executeRead({
        action: (provider) => provider.client.readContract(input),
        method: 'eth_call',
        idempotent: true,
        providerKind: 'HTTP',
      }),
      simulateContract: (input: SimulateContractInput) => this.executeRead({
        action: (provider) => provider.client.simulateContract(input),
        method: 'eth_call',
        idempotent: true,
        providerKind: 'HTTP',
      }),
      getBalance: (input: GetBalanceInput) => this.executeRead({
        action: (provider) => provider.client.getBalance(input),
        method: 'eth_getBalance',
        idempotent: true,
        providerKind: 'HTTP',
      }),
      getTransactionReceipt: (input: GetTransactionReceiptInput) => this.executeRead({
        action: (provider) => provider.client.getTransactionReceipt(input),
        method: 'eth_getTransactionReceipt',
        idempotent: true,
        providerKind: 'HTTP',
      }),
      getTransaction: (input: GetTransactionInput) => this.executeRead({
        action: (provider) => provider.client.getTransaction(input),
        method: 'eth_getTransactionByHash',
        idempotent: true,
        providerKind: 'HTTP',
      }),
      getCode: (input: GetCodeInput) => this.executeRead({
        action: (provider) => provider.client.getCode(input),
        method: 'eth_getCode',
        idempotent: true,
        providerKind: 'HTTP',
      }),
      getTransactionCount: (input: GetTransactionCountInput) => this.executeRead({
        action: (provider) => provider.client.getTransactionCount(input),
        method: 'eth_getTransactionCount',
        idempotent: true,
        providerKind: 'HTTP',
      }),
      getGasPrice: () => this.executeRead({
        action: (provider) => provider.client.getGasPrice(),
        method: 'eth_gasPrice',
        idempotent: true,
        providerKind: 'HTTP',
      }),
      getContractEvents: (input: GetLogsInput) => this.getContractEvents(input),
      waitForTransactionReceipt: (input: WaitForTransactionReceiptInput) => this.executeRead({
        action: (provider) => provider.client.waitForTransactionReceipt(input),
        method: 'eth_waitForTransactionReceipt',
        idempotent: false,
        providerKind: 'HTTP',
      }),
    } as unknown as PublicClient;
  }

  getWsClient(): PublicClient {
    return {
      getBlockNumber: () => this.executeRead<bigint>({
        action: (provider) => provider.client.getBlockNumber(),
        method: 'eth_blockNumber',
        idempotent: true,
        providerKind: 'WEBSOCKET',
      }),
      readContract: (input: ReadContractInput) => this.executeRead({
        action: (provider) => provider.client.readContract(input),
        method: 'eth_call',
        idempotent: true,
        providerKind: 'WEBSOCKET',
      }),
      getBlock: (input: GetBlockInput) => this.executeRead({
        action: (provider) => provider.client.getBlock(input),
        method: 'eth_getBlockByNumber',
        idempotent: true,
        providerKind: 'WEBSOCKET',
      }),
      watchContractEvent: (input: WatchContractEventInput) => {
        const provider = this.selectProvider(this.wsProviders, true);
        if (!provider) {
          throw new Error('Aucun provider WebSocket disponible.');
        }

        provider.markSwitch();
        return provider.client.watchContractEvent({
          ...input,
          onLogs: (logs) => {
            provider.markWsMessage();
            input.onLogs(logs);
          },
          onError: (error) => {
            provider.markFailure(error, false);
            input.onError?.(error);
          },
        });
      },
      close: async () => {
        await Promise.all(
          this.wsProviders
            .map((provider) => provider.client.close)
            .filter((close): close is () => Promise<void> => close !== undefined)
            .map((close) => close()),
        );
      },
    } as unknown as PublicClient;
  }

  getTxClient(): PublicClient {
    return {
      sendRawTransaction: (input: SendRawTransactionInput) => this.sendRawTransaction(input.serializedTransaction),
      getTransactionReceipt: (input: GetTransactionReceiptInput) => this.executeTxRead({
        action: (provider) => provider.client.getTransactionReceipt(input),
        method: 'eth_getTransactionReceipt',
      }),
      getTransaction: (input: GetTransactionInput) => this.executeTxRead({
        action: (provider) => provider.client.getTransaction(input),
        method: 'eth_getTransactionByHash',
      }),
      waitForTransactionReceipt: (input: WaitForTransactionReceiptInput) => this.executeTxRead({
        action: (provider) => provider.client.waitForTransactionReceipt(input),
        method: 'eth_waitForTransactionReceipt',
      }),
      getBalance: (input: GetBalanceInput) => this.executeTxRead({
        action: (provider) => provider.client.getBalance(input),
        method: 'eth_getBalance',
      }),
      getCode: (input: GetCodeInput) => this.executeTxRead({
        action: (provider) => provider.client.getCode(input),
        method: 'eth_getCode',
      }),
      getTransactionCount: (input: GetTransactionCountInput) => this.executeTxRead({
        action: (provider) => provider.client.getTransactionCount(input),
        method: 'eth_getTransactionCount',
      }),
    } as unknown as PublicClient;
  }

  get estimateClient(): PublicClient {
    return this.getPublicClient();
  }

  get nonceClient(): PublicClient {
    return this.getPublicClient();
  }

  forTestGetProviderSnapshotById(id: string): RpcProviderStateSnapshot | undefined {
    const provider = [...this.readProviders, ...this.wsProviders, ...this.txProviders]
      .find((candidate) => candidate.id === id);
    return provider?.snapshot();
  }

  forTestSetProviderWsMessageAge(id: string, atMs: number | null): boolean {
    const provider = [...this.wsProviders].find((candidate) => candidate.id === id);
    if (!provider) return false;
    provider.setLastWsMessageAtMs(atMs);
    return true;
  }

  async getProviderSnapshots(): Promise<RpcProviderStateSnapshot[]> {
    await this.refreshProviderHeights();

    for (const provider of [...this.wsProviders]) {
      if (
        provider.lastWsMessageAgeMs !== null
        && provider.lastWsMessageAgeMs > PROVIDER_STALE_WS_MS
      ) {
        provider.markFailure(new Error('WebSocket silencieux'), false);
      }
    }

    return [...this.readProviders, ...this.wsProviders, ...this.txProviders].map(
      (provider) => provider.snapshot(),
    );
  }

  async close(): Promise<void> {
    await Promise.all([
      ...this.readProviders,
      ...this.wsProviders,
      ...this.txProviders,
    ].map((provider) => provider.client.close)
      .filter((close): close is () => Promise<void> => close !== undefined)
      .map((close) => close()),
    );
  }

  private async refreshProviderHeights(): Promise<void> {
    const now = nowMs();
    if (now - this.lastHeightRefreshMs < PROVIDER_HEALTH_REFRESH_MS) return;
    this.lastHeightRefreshMs = now;

    const candidates = [...this.readProviders, ...this.wsProviders, ...this.txProviders];
    const requests = candidates.map((provider) =>
      this.withProvider(
        provider,
        () => this.withTimeoutByKind(() => provider.client.getBlockNumber(), provider.kind),
        {
          method: 'eth_blockNumber',
          idempotent: true,
          kind: provider.kind,
        },
      )
        .then((response) => ({
          provider,
          blockNumber: response,
        }))
        .catch((error) => {
          provider.markFailure(error, isRetriableError(error));
          return { provider, blockNumber: null };
        }),
    );
    const results = await Promise.all(requests);
    const laggingCandidates = [...this.readProviders];
    const blockNumbers = results
      .filter((entry) => laggingCandidates.includes(entry.provider))
      .map((value) => value.blockNumber)
      .filter((value): value is bigint => value !== null)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

    const consensus = blockNumbers.length === 0
      ? null
      : blockNumbers[Math.floor(blockNumbers.length / 2)] ?? null;
    for (const provider of candidates) {
      const result = results.find((entry) => entry.provider.id === provider.id);
      if (result?.blockNumber !== undefined && result.blockNumber !== null) {
        provider.markSuccess(undefined, result.blockNumber);
        provider.resetLogRange();
      }
      provider.markLagging(consensus);
    }
  }

  private selectProvider(
    providers: RpcProvider[],
    allowRecovering: boolean,
  ): RpcProvider | null {
    const candidates = this.selectProviders(providers, allowRecovering);
    return candidates[0] ?? null;
  }

  private selectProviders(
    providers: RpcProvider[],
    allowRecovering: boolean,
  ): RpcProvider[] {
    const selected = providers.filter((provider) => provider.status === 'up'
      && !provider.lagging);
    if (selected.length > 0) return selected;
    if (!allowRecovering) return [];
    return providers.filter((provider) => provider.recovering);
  }

  private sortByHealth(providers: RpcProvider[]): RpcProvider[] {
    return [...providers].sort((left, right) => {
      const errorDelta = left.errorRate - right.errorRate;
      if (errorDelta !== 0) return errorDelta;
      const leftLatency = left.latencyMs ?? 0;
      const rightLatency = right.latencyMs ?? 0;
      return leftLatency - rightLatency;
    });
  }

  private rotate(providers: RpcProvider[], kind: RpcProviderKind): RpcProvider[] {
    if (providers.length === 0) return [];
    if (kind === 'HTTP') this.readCursor += 1;
    if (kind === 'WEBSOCKET') this.wsCursor += 1;
    if (kind === 'TX') this.txCursor += 1;

    const start = kind === 'HTTP'
      ? this.readCursor % providers.length
      : kind === 'WEBSOCKET'
        ? this.wsCursor % providers.length
        : this.txCursor % providers.length;

    const ordered: RpcProvider[] = [];
    for (let offset = 0; offset < providers.length; offset += 1) {
      const index = (start + offset) % providers.length;
      const provider = providers[index];
      if (provider) {
        ordered.push(provider);
      }
    }
    return ordered;
  }

  private async executeTxRead<T>(options: {
    action: (provider: RpcProvider) => Promise<T>;
    method: string;
  }): Promise<T> {
    const provider = this.selectProvider(this.txProviders, true);
    if (!provider) {
      throw new Error('Aucun provider de diffusion disponible.');
    }
    const response = await this.withProvider(provider, () => options.action(provider), {
      method: options.method,
      idempotent: false,
      kind: 'TX',
    });
    return response as T;
  }

  private async executeRead<T>(options: {
    action: (provider: RpcProvider) => Promise<T>;
    method: string;
    idempotent: boolean;
    providerKind: 'HTTP' | 'WEBSOCKET';
  }): Promise<T> {
    const pool = options.providerKind === 'HTTP'
      ? this.readProviders
      : this.wsProviders;
    const selected = this.sortByHealth(this.selectProviders(pool, options.idempotent));
    if (selected.length === 0) {
      throw new Error(`Aucun provider ${options.providerKind} disponible pour ${options.method}.`);
    }

    if (!options.idempotent) {
      const provider = selected[0];
      if (!provider) {
        throw new Error(`Aucun provider ${options.providerKind} disponible pour ${options.method}.`);
      }
      const response = await this.withProvider(provider, () => options.action(provider), {
        method: options.method,
        idempotent: false,
        kind: options.providerKind,
      });
      provider.markSuccess();
      return response as T;
    }

    const ordered = this.rotate(selected, options.providerKind);
    let lastError: unknown = null;
    for (const provider of ordered) {
      provider.markSwitch();
      try {
        const response = await this.withProvider(provider, () => options.action(provider), {
          method: options.method,
          idempotent: true,
          kind: options.providerKind,
        });
        provider.markSuccess();
        return response as T;
      } catch (error) {
        provider.markFailure(error, isRetriableError(error));
        lastError = error;
        if (!isRetriableError(error)) throw error;
      }
    }

    throw normalizeReadError(lastError, options.method);
  }

  private async getContractEvents(input: GetLogsInput): Promise<readonly unknown[]> {
    if (typeof input.fromBlock !== 'bigint' || typeof input.toBlock !== 'bigint') {
      throw new Error('Les bornes de getContractEvents doivent être des bigint.');
    }

    const selectedProviders = this.sortByHealth(this.selectProviders(this.readProviders, true));
    if (selectedProviders.length === 0) {
      throw new Error('Aucun provider HTTP disponible pour getContractEvents.');
    }

    const ordered = this.rotate(selectedProviders, 'HTTP');
    let lastError: unknown = null;
    let hadRetriableFailure = false;
    for (const provider of ordered) {
      provider.markSwitch();
      try {
        return await this.readContractEventsWithProvider(provider, input);
      } catch (error) {
        lastError = error;
        if (!isRetriableError(error)) {
          throw error;
        }
        hadRetriableFailure = true;
      }
    }

    if (hadRetriableFailure) {
      throw new Error('Aucun provider HTTP disponible pour eth_getLogs.');
    }

    throw normalizeReadError(lastError, 'eth_getLogs');
  }

  private async readContractEventsWithProvider(
    provider: RpcProvider,
    input: GetLogsInput,
  ): Promise<readonly unknown[]> {
    let cursor = input.fromBlock;
    let outputs: unknown[] = [];

    while (cursor <= input.toBlock) {
      const chunkSize = provider.maxLogBlockRange;
      const chunkEnd = cursor + BigInt(chunkSize) - 1n >= input.toBlock
        ? input.toBlock
        : cursor + BigInt(chunkSize) - 1n;
      try {
        const chunk = await this.withProvider(
          provider,
          () =>
            provider.client.getContractEvents({
              ...input,
              fromBlock: cursor,
              toBlock: chunkEnd,
            }),
          {
            method: 'eth_getLogs',
            idempotent: true,
            kind: 'HTTP',
          },
        );

        for (const log of chunk) {
          outputs.push(log);
        }
        cursor = chunkEnd + 1n;
      } catch (error) {
        if (!isLogLimitError(error)) {
          provider.markFailure(error, true);
          throw error;
        }
        provider.shrinkLogRange();
        if (provider.maxLogBlockRange <= 1) {
          provider.markFailure(error, false);
          throw error;
        }

        cursor = input.fromBlock;
        outputs = [];
        continue;
      }
    }

    provider.markSuccess();
    return outputs;
  }

  private async sendRawTransaction(serializedTransaction: Hash): Promise<Hash> {
    const hash = keccak256(serializedTransaction);
    const knownProvider = this.getKnownTransaction(hash);
    if (knownProvider !== null) {
      return hash;
    }

    const provider = this.selectProvider(this.txProviders, false);
    if (!provider) {
      throw new Error('Aucun provider de diffusion disponible.');
    }
    this.rememberTransaction(hash, provider.id);

    try {
      const result = await this.withProvider(
        provider,
        () => this.withTimeoutByKind(
          () => provider.client.sendRawTransaction({
            serializedTransaction,
          }),
          'TX',
        ),
        {
          method: 'eth_sendRawTransaction',
          idempotent: false,
          kind: 'TX',
        },
      );
      if (typeof result !== 'string' || !/^0x[a-fA-F0-9]{64}$/u.test(result)) {
        throw new Error('Réponse sendRawTransaction invalide.');
      }
      if (result.toLowerCase() !== hash.toLowerCase()) {
        throw new Error(`Hash RPC inattendu: ${result}.`);
      }
      provider.markSuccess();
      return result as Hash;
    } catch (error) {
      if (isAlreadyKnown(error)) {
        const parsed = extractRpcHash(errorMessage(error));
        if (parsed) {
          provider.markSuccess();
          this.rememberTransaction(parsed, provider.id);
          return parsed;
        }
      }

      provider.markFailure(error, isRetriableError(error));
      if (isRetriableError(error)) {
        throw new Error(
          `broadcast timeout or temporary RPC issue for ${hash}; status UNKNOWN.`,
        );
      }
      throw error;
    }
  }

  private async withProvider<T>(
    provider: RpcProvider,
    action: () => Promise<T>,
    options: RpcCallOptions,
  ): Promise<T> {
    const startedAt = nowMs();
    try {
      const response = await this.withTimeoutByKind(action, options.kind);
      const elapsed = nowMs() - startedAt;
      this.recordMethodCall(options.method);
      provider.markSuccess(elapsed, this.safeSampleBlockNumber());
      return response;
    } catch (error) {
      const elapsed = nowMs() - startedAt;
      this.recordMethodError(options.method, isRetriableError(error), elapsed);
      throw error;
    }
  }

  private async withTimeoutByKind<T>(
    action: () => Promise<T>,
    kind: RpcProviderKind,
  ): Promise<T> {
    const timeout = REQUEST_TIMEOUTS[kind];
    return withTimeoutMs(action, timeout);
  }

  private safeSampleBlockNumber(): bigint | undefined {
    for (const candidate of this.readProviders) {
      const value = candidate.lastBlockNumber;
      if (value !== null) return value;
    }
    return undefined;
  }

  private getKnownTransaction(hash: Hash): SentTransactionEntry | null {
    const entry = this.knownTransactions.get(hash);
    if (!entry) return null;
    if (nowMs() - entry.atMs > KNOWN_TRANSACTION_TTL_MS) {
      this.knownTransactions.delete(hash);
      return null;
    }
    return entry;
  }

  private rememberTransaction(hash: Hash, providerId: string): void {
    this.knownTransactions.set(hash, {
      providerId,
      atMs: nowMs(),
    });
  }

  private recordMethodCall(method: string): void {
    this.failuresByMethod.set(method, {
      count: (this.failuresByMethod.get(method)?.count ?? 0) + 1,
      lastAtMs: nowMs(),
    });
  }

  private recordMethodError(method: string, retriable: boolean, _latencyMs: number): void {
    const entry = this.failuresByMethod.get(method);
    if (!entry) {
      this.failuresByMethod.set(method, {
        count: 1,
        lastAtMs: nowMs(),
      });
      return;
    }

    if (retriable) {
      entry.count += 1;
      entry.lastAtMs = nowMs();
    }
  }
}

function normalizeReadError(error: unknown, method: string): Error {
  const raw = sanitizeRpcText(
    error instanceof Error ? error.message : String(error),
  );
  return new Error(`${method} indisponible: ${raw}`);
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
const PROVIDER_STALE_WS_MS = 45_000;
const PROVIDER_HEALTH_REFRESH_MS = 5_000;
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

export function getRpcClientPoolForTest(): RpcClientPool {
  return pool;
}
