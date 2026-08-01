import { config } from '../config/env.js';

export interface RpcMethodUsageCounter {
  calls: number;
  errors: number;
  errors429: number;
  retries: number;
  failovers: number;
  averageLatencyMs: number | null;
  providers: Record<string, number>;
}

export interface RpcUsageWarnings {
  warning70: boolean;
  warning85: boolean;
  warning95: boolean;
}

export interface SwapReconciliationCounters {
  requestsReceived: number;
  coalescedRequests: number;
  centralPasses: number;
  chunksRead: number;
  addressBatches: number[];
  logsReceived: number;
  lastSuccessAtMs: number | null;
  lastErrorAtMs: number | null;
}

export interface RpcUsageSnapshot {
  methods: Record<string, RpcMethodUsageCounter>;
  reconciliation: SwapReconciliationCounters;
  totalRequests: number;
  lastSuccessAtMs: number | null;
  lastErrorAtMs: number | null;
  budget: {
    configured: number;
    projection30d: number | null;
    projectionStatus: 'insufficient-data' | 'ready';
    observationMs: number;
    warnings: RpcUsageWarnings;
  };
}

export interface RpcUsageTrackerOptions {
  monthlyBudget?: number;
  now?: () => number;
  minimumObservationMs?: number;
}

interface MutableMethodCounter extends RpcMethodUsageCounter {
  latencyTotalMs: number;
  latencySamples: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MINIMUM_OBSERVATION_MS = 60_000;

function normalizedMethod(method: string): string {
  const value = method.trim().toLowerCase();
  return value.length > 0 ? value : 'unknown';
}

export class RpcUsageTracker {
  private readonly startedAtMs: number;
  private readonly methodUsage = new Map<string, MutableMethodCounter>();
  private readonly providerAliases = new Map<string, string>();
  private readonly monthlyBudget: number;
  private readonly now: () => number;
  private readonly minimumObservationMs: number;
  private totalRequests = 0;
  private lastSuccessAtMs: number | null = null;
  private lastErrorAtMs: number | null = null;
  private readonly reconciliationCounters: SwapReconciliationCounters = {
    requestsReceived: 0,
    coalescedRequests: 0,
    centralPasses: 0,
    chunksRead: 0,
    addressBatches: [],
    logsReceived: 0,
    lastSuccessAtMs: null,
    lastErrorAtMs: null,
  };

  constructor(options: number | RpcUsageTrackerOptions = {}) {
    const normalized = typeof options === 'number'
      ? { monthlyBudget: options }
      : options;
    this.monthlyBudget = Math.max(
      1,
      normalized.monthlyBudget ?? config.rpcMonthlyRequestBudget,
    );
    this.now = normalized.now ?? Date.now;
    this.minimumObservationMs = Math.max(
      1,
      normalized.minimumObservationMs ?? DEFAULT_MINIMUM_OBSERVATION_MS,
    );
    this.startedAtMs = this.now();
  }

  recordMethodCall(method: string, providerId = 'provider'): void {
    const stats = this.getOrCreateMethod(method);
    stats.calls += 1;
    const alias = this.providerAlias(providerId);
    stats.providers[alias] = (stats.providers[alias] ?? 0) + 1;
    this.totalRequests += 1;
  }

  recordMethodSuccess(method: string, latencyMs = 0): void {
    const stats = this.getOrCreateMethod(method);
    stats.latencyTotalMs += Math.max(0, Math.floor(latencyMs));
    stats.latencySamples += 1;
    stats.averageLatencyMs = Math.round(stats.latencyTotalMs / stats.latencySamples);
    this.lastSuccessAtMs = this.now();
  }

  recordMethodError(method: string, is429 = false, latencyMs = 0): void {
    const stats = this.getOrCreateMethod(method);
    stats.errors += 1;
    if (is429) stats.errors429 += 1;
    stats.latencyTotalMs += Math.max(0, Math.floor(latencyMs));
    stats.latencySamples += 1;
    stats.averageLatencyMs = Math.round(stats.latencyTotalMs / stats.latencySamples);
    this.lastErrorAtMs = this.now();
  }

  recordMethodRetry(method: string): void {
    this.getOrCreateMethod(method).retries += 1;
  }

  recordMethodFailover(method: string): void {
    this.getOrCreateMethod(method).failovers += 1;
  }

  markReconciliationRequest(): void {
    this.reconciliationCounters.requestsReceived += 1;
  }

  markCoalescedRequest(): void {
    this.reconciliationCounters.coalescedRequests += 1;
  }

  markCentralPass(): void {
    this.reconciliationCounters.centralPasses += 1;
  }

  markChunkRead(addressBatchSize: number, logsReceived: number): void {
    this.markChunk();
    this.markAddressBatch(addressBatchSize, logsReceived);
  }

  markChunk(): void {
    this.reconciliationCounters.chunksRead += 1;
  }

  markAddressBatch(addressBatchSize: number, logsReceived: number): void {
    this.reconciliationCounters.addressBatches.push(Math.max(0, addressBatchSize));
    this.reconciliationCounters.logsReceived += Math.max(0, logsReceived);
  }

  markReconciliationSuccess(): void {
    const now = this.now();
    this.reconciliationCounters.lastSuccessAtMs = now;
    this.lastSuccessAtMs = now;
  }

  markReconciliationError(): void {
    const now = this.now();
    this.reconciliationCounters.lastErrorAtMs = now;
    this.lastErrorAtMs = now;
  }

  getSnapshot(): RpcUsageSnapshot {
    const observationMs = Math.max(0, this.now() - this.startedAtMs);
    const projectionReady = observationMs >= this.minimumObservationMs;
    const projection30d = projectionReady
      ? Math.round(this.totalRequests * THIRTY_DAYS_MS / Math.max(1, observationMs))
      : null;
    const ratio = projection30d === null ? 0 : projection30d / this.monthlyBudget;
    const methods: Record<string, RpcMethodUsageCounter> = {};
    for (const [method, counters] of this.methodUsage.entries()) {
      methods[method] = {
        calls: counters.calls,
        errors: counters.errors,
        errors429: counters.errors429,
        retries: counters.retries,
        failovers: counters.failovers,
        averageLatencyMs: counters.averageLatencyMs,
        providers: { ...counters.providers },
      };
    }
    return {
      methods,
      reconciliation: {
        ...this.reconciliationCounters,
        addressBatches: [...this.reconciliationCounters.addressBatches],
      },
      totalRequests: this.totalRequests,
      lastSuccessAtMs: this.lastSuccessAtMs,
      lastErrorAtMs: this.lastErrorAtMs,
      budget: {
        configured: this.monthlyBudget,
        projection30d,
        projectionStatus: projectionReady ? 'ready' : 'insufficient-data',
        observationMs,
        warnings: {
          warning70: ratio >= 0.7,
          warning85: ratio >= 0.85,
          warning95: ratio >= 0.95,
        },
      },
    };
  }

  private getOrCreateMethod(method: string): MutableMethodCounter {
    const key = normalizedMethod(method);
    const current = this.methodUsage.get(key);
    if (current) return current;
    const created: MutableMethodCounter = {
      calls: 0,
      errors: 0,
      errors429: 0,
      retries: 0,
      failovers: 0,
      averageLatencyMs: null,
      providers: {},
      latencyTotalMs: 0,
      latencySamples: 0,
    };
    this.methodUsage.set(key, created);
    return created;
  }

  private providerAlias(providerId: string): string {
    const current = this.providerAliases.get(providerId);
    if (current) return current;
    const alias = `provider-${this.providerAliases.size + 1}`;
    this.providerAliases.set(providerId, alias);
    return alias;
  }
}

export const rpcUsage = new RpcUsageTracker();
