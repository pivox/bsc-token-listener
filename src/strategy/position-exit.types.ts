import type { Address } from 'viem';
import type { PositionExitSettings } from './position-exit-settings.js';

export type ExitRuleCode =
  | 'SELLABILITY_UNCERTAIN'
  | 'SELLABILITY_BLOCKED'
  | 'LIQUIDITY_DROP'
  | 'STOP_LOSS'
  | 'MAX_HOLDING_TIME'
  | 'TRAILING_STOP'
  | 'TAKE_PROFIT'
  | 'TARGET_BUYS'
  | 'GAS_RATIO_EXCEEDED'
  | 'EMERGENCY_GAS_EXCEEDED';

export type ExitPolicyAction =
  | 'HOLD'
  | 'SELL'
  | 'EMERGENCY_SELL'
  | 'MANUAL_REVIEW';

export type SellabilityStatus = 'SAFE' | 'BLOCKED' | 'UNKNOWN';

export interface PositionExitState {
  referenceLiquidityWbnbWei?: bigint;
  currentLiquidityWbnbWei?: bigint;
  latestNetValueWei?: bigint;
  peakNetValueWei?: bigint;
  lastEvaluatedAtMs?: number;
  lastProbeAtMs?: number;
  nextEvaluationAtMs?: number;
  trailingArmedAtMs?: number;
  lastProbeStatus?: SellabilityStatus;
  lastSellTaxBps?: number;
  lastEstimatedExitGasWei?: bigint;
  pendingDecisionId?: string;
  lastPrimaryRule?: ExitRuleCode;
  lastReason?: string;
  staleReason?: string;
  settingsRevision?: number;
}

export interface PositionMetricsSnapshot {
  quoteWei: bigint;
  entryCostWei: bigint;
  netExitValueWei: bigint;
  currentLiquidityWbnbWei: bigint;
  estimatedExitGasWei: bigint;
  sellTaxBps: number;
  probeStatus: SellabilityStatus;
  probeMeasuredAtMs: number;
}

export interface ExitEvaluationInput {
  settings: Readonly<PositionExitSettings>;
  state: Readonly<PositionExitState>;
  metrics: Readonly<PositionMetricsSnapshot>;
  nowMs: number;
  openedAtMs: number;
  observedBuysAfterEntry: number;
}

export interface ExitEvaluationResult {
  action: ExitPolicyAction;
  primaryRule?: ExitRuleCode;
  triggeredRules: ExitRuleCode[];
  state: Readonly<PositionExitState>;
  reason: string;
}

export type PositionExitDecisionStatus =
  | 'PENDING'
  | 'EXECUTING'
  | 'EXECUTED'
  | 'MANUAL_REVIEW'
  | 'FAILED'
  | 'SUPERSEDED';

export interface EffectivePositionExitSettings {
  settings: Readonly<PositionExitSettings>;
  revision: number;
  source: 'ENV' | 'DATABASE';
  updatedAt: string | null;
}

export interface PositionExitDecision {
  id: string;
  idempotencyKey: string;
  pair: Address;
  token: Address;
  settingsRevision: number;
  primaryRule: ExitRuleCode;
  triggeredRules: ExitRuleCode[];
  action: Exclude<ExitPolicyAction, 'HOLD'>;
  status: PositionExitDecisionStatus;
  metrics: PositionMetricsSnapshot;
  reason: string;
  errorType?: string;
  relatedTradeId?: string;
  createdAtMs: number;
  executionStartedAtMs?: number;
  updatedAtMs: number;
}

export type NewPositionExitDecision = Omit<
  PositionExitDecision,
  'id' | 'status' | 'createdAtMs' | 'executionStartedAtMs' | 'updatedAtMs'
>;
