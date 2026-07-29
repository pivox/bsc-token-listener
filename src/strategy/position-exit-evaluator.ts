import type {
  ExitEvaluationInput,
  ExitEvaluationResult,
  ExitPolicyAction,
  ExitRuleCode,
  PositionExitState,
} from './position-exit.types.js';

const BPS = 10_000n;

function applyBps(value: bigint, remainingBps: number): bigint {
  return (value * BigInt(remainingBps)) / BPS;
}

export function prudentNetExitValue(input: {
  quoteWei: bigint;
  sellTaxBps: number;
  quoteBufferBps: number;
  estimatedExitGasWei: bigint;
}): bigint {
  const afterTax = applyBps(input.quoteWei, 10_000 - input.sellTaxBps);
  const afterBuffer = applyBps(afterTax, 10_000 - input.quoteBufferBps);
  return afterBuffer > input.estimatedExitGasWei
    ? afterBuffer - input.estimatedExitGasWei
    : 0n;
}

function reachedLoss(current: bigint, reference: bigint, lossBps: number): boolean {
  return current * BPS <= reference * BigInt(10_000 - lossBps);
}

function reachedGain(current: bigint, reference: bigint, gainBps: number): boolean {
  return current * BPS >= reference * BigInt(10_000 + gainBps);
}

function freezeState(state: PositionExitState): Readonly<PositionExitState> {
  return Object.freeze({ ...state });
}

export function evaluatePositionExit(
  input: ExitEvaluationInput,
): ExitEvaluationResult {
  const { metrics, settings } = input;
  const state: PositionExitState = {
    ...input.state,
    referenceLiquidityWbnbWei:
      input.state.referenceLiquidityWbnbWei ?? metrics.currentLiquidityWbnbWei,
    currentLiquidityWbnbWei: metrics.currentLiquidityWbnbWei,
    latestNetValueWei: metrics.netExitValueWei,
    lastEvaluatedAtMs: input.nowMs,
    lastProbeAtMs: metrics.probeMeasuredAtMs,
    nextEvaluationAtMs: input.nowMs + settings.monitorIntervalSeconds * 1_000,
    lastProbeStatus: metrics.probeStatus,
    lastSellTaxBps: metrics.sellTaxBps,
    lastEstimatedExitGasWei: metrics.estimatedExitGasWei,
  };
  delete state.staleReason;

  const triggeredRules: ExitRuleCode[] = [];
  if (metrics.probeStatus === 'UNKNOWN') {
    triggeredRules.push('SELLABILITY_UNCERTAIN');
  } else if (metrics.probeStatus === 'BLOCKED') {
    triggeredRules.push('SELLABILITY_BLOCKED');
  }

  const referenceLiquidity = input.state.referenceLiquidityWbnbWei;
  if (
    referenceLiquidity !== undefined &&
    reachedLoss(
      metrics.currentLiquidityWbnbWei,
      referenceLiquidity,
      settings.liquidityDropBps,
    )
  ) {
    triggeredRules.push('LIQUIDITY_DROP');
  }
  if (reachedLoss(metrics.netExitValueWei, metrics.entryCostWei, settings.stopLossBps)) {
    triggeredRules.push('STOP_LOSS');
  }
  if (
    input.nowMs - input.openedAtMs >=
    settings.maxHoldingMinutes * 60_000
  ) {
    triggeredRules.push('MAX_HOLDING_TIME');
  }

  if (settings.trailingEnabled) {
    const previousPeak = input.state.peakNetValueWei ?? metrics.netExitValueWei;
    state.peakNetValueWei =
      metrics.netExitValueWei > previousPeak ? metrics.netExitValueWei : previousPeak;
    const armed =
      input.state.trailingArmedAtMs !== undefined ||
      reachedGain(
        metrics.netExitValueWei,
        metrics.entryCostWei,
        settings.trailingActivationBps,
      );
    if (armed && state.trailingArmedAtMs === undefined) {
      state.trailingArmedAtMs = input.nowMs;
    }
    if (
      armed &&
      reachedLoss(
        metrics.netExitValueWei,
        state.peakNetValueWei,
        settings.trailingDrawdownBps,
      )
    ) {
      triggeredRules.push('TRAILING_STOP');
    }
  } else if (
    reachedGain(metrics.netExitValueWei, metrics.entryCostWei, settings.takeProfitBps)
  ) {
    triggeredRules.push('TAKE_PROFIT');
  }

  if (input.observedBuysAfterEntry >= settings.targetBuysAfterEntry) {
    triggeredRules.push('TARGET_BUYS');
  }

  let primaryRule = triggeredRules[0];
  let action: ExitPolicyAction = 'HOLD';
  if (
    primaryRule === 'SELLABILITY_UNCERTAIN' ||
    primaryRule === 'SELLABILITY_BLOCKED'
  ) {
    action = 'MANUAL_REVIEW';
  } else if (primaryRule === 'LIQUIDITY_DROP') {
    if (metrics.estimatedExitGasWei > settings.emergencyMaxGasWei) {
      triggeredRules.push('EMERGENCY_GAS_EXCEEDED');
      primaryRule = 'EMERGENCY_GAS_EXCEEDED';
      action = 'MANUAL_REVIEW';
    } else {
      action = 'EMERGENCY_SELL';
    }
  } else if (primaryRule !== undefined) {
    if (
      metrics.netExitValueWei === 0n ||
      metrics.estimatedExitGasWei * BPS >
        metrics.netExitValueWei * BigInt(settings.maxGasValueBps)
    ) {
      triggeredRules.push('GAS_RATIO_EXCEEDED');
      primaryRule = 'GAS_RATIO_EXCEEDED';
      action = 'MANUAL_REVIEW';
    } else {
      action = 'SELL';
    }
  }

  const reason =
    primaryRule === undefined
      ? 'Aucune règle de sortie déclenchée.'
      : `Règle de sortie: ${primaryRule}.`;
  if (primaryRule === undefined) {
    delete state.lastPrimaryRule;
  } else {
    state.lastPrimaryRule = primaryRule;
  }
  state.lastReason = reason;

  const result: ExitEvaluationResult = {
    action,
    triggeredRules: [...triggeredRules],
    state: freezeState(state),
    reason,
  };
  if (primaryRule !== undefined) {
    result.primaryRule = primaryRule;
  }
  return result;
}
