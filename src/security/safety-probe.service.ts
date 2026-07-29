import type { Address, PublicClient } from 'viem';
import { safetyProbeAbi } from '../abi/safety-probe.abi.js';
import { config } from '../config/env.js';
import { account } from '../rpc/clients.js';
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

export class SafetyProbeService {
  constructor(
    private readonly client: PublicClient,
    private readonly options: SafetyProbeOptions = {
      address: config.safetyProbeAddress,
      caller: config.riskProbeCaller ?? account?.address,
      amountWei: config.riskProbeAmountWei,
      deadlineSeconds: config.txDeadlineSeconds,
    },
  ) {}

  async probe(pair: PairInfo): Promise<SafetyProbeResult> {
    if (!this.options.address) {
      throw new Error('SAFETY_PROBE_ADDRESS non configurée.');
    }
    if (!this.options.caller) {
      throw new Error('RISK_PROBE_CALLER ou PRIVATE_KEY non configuré.');
    }
    const now = this.options.nowMs?.() ?? Date.now();
    const deadline = BigInt(
      Math.floor(now / 1_000) + this.options.deadlineSeconds,
    );
    const { result } = await this.client.simulateContract({
      address: this.options.address,
      abi: safetyProbeAbi,
      functionName: 'probe',
      args: [pair.router, pair.token, deadline],
      account: this.options.caller,
      value: this.options.amountWei,
    });
    const [quotedTokens, receivedTokens, quotedNative, recoveredNative] = result;
    return {
      buyTaxBps: bpsLoss(quotedTokens, receivedTokens),
      sellTaxBps: bpsLoss(quotedNative, recoveredNative),
      roundTripLossBps: bpsLoss(this.options.amountWei, recoveredNative),
      quotedTokens,
      receivedTokens,
      quotedNative,
      recoveredNative,
    };
  }
}
