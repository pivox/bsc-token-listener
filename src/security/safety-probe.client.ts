import type { Address, PublicClient } from 'viem';
import { safetyProbeAbi } from '../abi/safety-probe.abi.js';
import type { PairInfo } from '../types/domain.js';

export interface SafetyProbeResult {
  buyTaxBps: number;
  sellTaxBps: number;
  roundTripLossBps: number;
  quotedTokens: bigint;
  receivedTokens: bigint;
  quotedNative: bigint;
  recoveredNative: bigint;
}

export interface SafetyProbeOptions {
  address: Address | undefined;
  caller: Address | undefined;
  amountWei: bigint;
  deadlineSeconds: number;
  nowMs?: () => number;
}

function bpsLoss(expected: bigint, actual: bigint): number {
  if (expected <= 0n) return 10_000;
  if (actual >= expected) return 0;
  return Number(((expected - actual) * 10_000n) / expected);
}

export async function simulateSafetyProbe(
  client: PublicClient,
  options: SafetyProbeOptions,
  pair: PairInfo,
): Promise<SafetyProbeResult> {
  if (!options.address) {
    throw new Error('SAFETY_PROBE_ADDRESS non configurée.');
  }
  if (!options.caller) {
    throw new Error('RISK_PROBE_CALLER ou PRIVATE_KEY non configuré.');
  }
  const now = options.nowMs?.() ?? Date.now();
  const deadline = BigInt(Math.floor(now / 1_000) + options.deadlineSeconds);
  const { result } = await client.simulateContract({
    address: options.address,
    abi: safetyProbeAbi,
    functionName: 'probe',
    args: [pair.router, pair.token, deadline],
    account: options.caller,
    value: options.amountWei,
  });
  const [quotedTokens, receivedTokens, quotedNative, recoveredNative] = result;
  return {
    buyTaxBps: bpsLoss(quotedTokens, receivedTokens),
    sellTaxBps: bpsLoss(quotedNative, recoveredNative),
    roundTripLossBps: bpsLoss(options.amountWei, recoveredNative),
    quotedTokens,
    receivedTokens,
    quotedNative,
    recoveredNative,
  };
}
