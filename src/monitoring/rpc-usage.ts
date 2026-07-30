export interface RpcMethodUsageCounter {
  calls: number;
  errors: number;
  errors429: number;
  retries: number;
}

export interface RpcUsageWarnings {
  warning70: boolean;
  warning85: boolean;
  warning95: boolean;
}

export interface SwapReconciliationCounters {
  requestsReceived: number;
  coalescedRequests: number;
  chunksRead: number;
  addressBatches: number[];
  logsReceived: number;
  lastSuccessAtMs: number | null;
}

export interface RpcUsageSnapshot {
  methods: Record<string, RpcMethodUsageCounter>;
  reconciliation: SwapReconciliationCounters;
  budget: {
    configured: number;
    projection30d: number;
    warnings: RpcUsageWarnings;
  };
}

import { config } from '../config/env.js';

const DEFAULT_MONTHLY_BUDGET = config.rpcMonthlyRequestBudget;

class RpcUsageTracker {
  private readonly startedAtMs = Date.now();
  private readonly methodUsage = new Map<string, RpcMethodUsageCounter>();
  private readonly monthlyBudget: number;
  private totalRequests = 0;

  private readonly reconciliationCounters: SwapReconciliationCounters = {
    requestsReceived: 0,
    coalescedRequests: 0,
    chunksRead: 0,
    addressBatches: [],
    logsReceived: 0,
    lastSuccessAtMs: null,
  };
  private warning70 = false;
  private warning85 = false;
  private warning95 = false;

  constructor(monthlyBudget: number = DEFAULT_MONTHLY_BUDGET) {
    this.monthlyBudget = Math.max(1, monthlyBudget);
  }

  recordMethodCall(method: string): void {
    const normalized = method.trim().toLowerCase();
    const stats = this.methodUsage.get(normalized);
    if (stats) {
      stats.calls += 1;
    } else {
      this.methodUsage.set(normalized, {
        calls: 1,
        errors: 0,
        errors429: 0,
        retries: 0,
      });
    }
    this.totalRequests += 1;
  }

  recordMethodError(method: string, is429 = false): void {
    const normalized = method.trim().toLowerCase();
    const stats = this.methodUsage.get(normalized);
    if (!stats) return;
    stats.errors += 1;
    if (is429) stats.errors429 += 1;
  }

  recordMethodRetry(method: string): void {
    const normalized = method.trim().toLowerCase();
    const stats = this.methodUsage.get(normalized);
    if (stats) stats.retries += 1;
  }

  markReconciliationRequest(): void {
    this.reconciliationCounters.requestsReceived += 1;
  }

  markCoalescedRequest(): void {
    this.reconciliationCounters.coalescedRequests += 1;
  }

  markChunkRead(addressBatchSize: number, logsReceived: number): void {
    this.reconciliationCounters.chunksRead += 1;
    this.reconciliationCounters.addressBatches.push(addressBatchSize);
    this.reconciliationCounters.logsReceived += logsReceived;
  }

  markReconciliationSuccess(): void {
    this.reconciliationCounters.lastSuccessAtMs = Date.now();
  }

  getSnapshot(): RpcUsageSnapshot {
    const projection30d = this.monthlyProjection();
    this.updateWarnings();
    const methods: Record<string, RpcMethodUsageCounter> = {};
    for (const [method, counters] of this.methodUsage.entries()) {
      methods[method] = { ...counters };
    }
    return {
      methods,
      reconciliation: {
        ...this.reconciliationCounters,
        addressBatches: [...this.reconciliationCounters.addressBatches],
      },
      budget: {
        configured: this.monthlyBudget,
        projection30d,
        warnings: {
          warning70: this.warning70,
          warning85: this.warning85,
          warning95: this.warning95,
        },
      },
    };
  }

  private monthlyProjection(): number {
    const elapsedMs = Date.now() - this.startedAtMs;
    if (elapsedMs <= 0) return 0;
    const factor = (30 * 24 * 60 * 60 * 1000) / elapsedMs;
    return this.totalRequests * factor;
  }

  private updateWarnings(): void {
    const ratio = this.monthlyProjection() / this.monthlyBudget;
    this.warning70 = this.warning70 || ratio >= 0.7;
    this.warning85 = this.warning85 || ratio >= 0.85;
    this.warning95 = this.warning95 || ratio >= 0.95;
  }
}

export const rpcUsage = new RpcUsageTracker(
  Number(process.env.RPC_MONTHLY_REQUEST_BUDGET ?? 3_000_000),
);
