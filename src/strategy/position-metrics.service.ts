import type { SafetyProbeResult } from '../security/safety-probe.service.js';
import type { TokenSession } from '../types/domain.js';
import { prudentNetExitValue } from './position-exit-evaluator.js';
import type { PositionExitSettings } from './position-exit-settings.js';
import type {
  PositionExitState,
  PositionMetricsSnapshot,
  SellabilityStatus,
} from './position-exit.types.js';

export interface PositionMetricsGateway {
  quotePosition(session: TokenSession): Promise<bigint>;
  readLiquidityWbnb(session: TokenSession): Promise<bigint>;
  readFeePerGas(): Promise<bigint>;
  probeSellability(session: TokenSession): Promise<SafetyProbeResult>;
}

export class StalePositionMetricsError extends Error {
  override readonly name = 'StalePositionMetricsError';

  constructor(readonly causeType: string) {
    super(`Métriques de position indisponibles: ${causeType}.`);
  }
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

export class PositionMetricsService {
  constructor(private readonly gateway: PositionMetricsGateway) {}

  async collect(
    session: TokenSession,
    settings: Readonly<PositionExitSettings>,
    state: Readonly<PositionExitState>,
    nowMs: number,
    options: { forceProbe?: boolean } = {},
  ): Promise<PositionMetricsSnapshot> {
    if (!session.entry) {
      throw new StalePositionMetricsError('MISSING_ENTRY');
    }

    let quoteWei: bigint;
    let currentLiquidityWbnbWei: bigint;
    let feePerGas: bigint;
    try {
      [quoteWei, currentLiquidityWbnbWei, feePerGas] = await Promise.all([
        this.gateway.quotePosition(session),
        this.gateway.readLiquidityWbnb(session),
        this.gateway.readFeePerGas(),
      ]);
    } catch (error) {
      throw new StalePositionMetricsError(errorType(error));
    }

    const probeDue =
      options.forceProbe === true ||
      state.lastProbeAtMs === undefined ||
      nowMs - state.lastProbeAtMs >= settings.probeIntervalSeconds * 1_000;
    let probeStatus: SellabilityStatus = state.lastProbeStatus ?? 'UNKNOWN';
    let sellTaxBps = state.lastSellTaxBps ?? 10_000;
    let probeMeasuredAtMs = state.lastProbeAtMs ?? nowMs;
    if (probeDue) {
      probeMeasuredAtMs = nowMs;
      try {
        const probe = await this.gateway.probeSellability(session);
        probeStatus = probe.recoveredNative > 0n ? 'SAFE' : 'BLOCKED';
        sellTaxBps = probe.sellTaxBps;
      } catch {
        probeStatus = 'UNKNOWN';
      }
    }

    const estimatedExitGasWei =
      feePerGas * (settings.approvalGasUnits + settings.sellGasUnits);
    const entryCostWei =
      session.entry.amountInWei + (session.entry.gasCostWei ?? 0n);
    return Object.freeze({
      quoteWei,
      entryCostWei,
      netExitValueWei: prudentNetExitValue({
        quoteWei,
        sellTaxBps,
        quoteBufferBps: settings.quoteBufferBps,
        estimatedExitGasWei,
      }),
      currentLiquidityWbnbWei,
      estimatedExitGasWei,
      sellTaxBps,
      probeStatus,
      probeMeasuredAtMs,
    });
  }
}
