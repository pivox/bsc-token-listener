import type { PublicClient } from 'viem';
import { config } from '../config/env.js';
import { account } from '../rpc/clients.js';
import type { PairInfo } from '../types/domain.js';
import {
  simulateSafetyProbe,
  type SafetyProbeOptions,
  type SafetyProbeResult,
} from './safety-probe.client.js';

export type { SafetyProbeOptions, SafetyProbeResult } from './safety-probe.client.js';

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
    return simulateSafetyProbe(this.client, this.options, pair);
  }
}
