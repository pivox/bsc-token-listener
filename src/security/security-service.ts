import type { Address } from 'viem';
import type { AppConfig } from '../config/env.js';
import type { AppPublicClient } from '../rpc/clients.js';
import type { PairInfo, SafetyReport } from '../types/domain.js';
import { LiquidityChecker } from './liquidity-checker.js';
import { SafetyProbe } from './safety-probe.js';
import { TokenChecker } from './token-checker.js';

export class SecurityService {
  private readonly tokenChecker: TokenChecker;
  private readonly liquidityChecker: LiquidityChecker;

  public constructor(
    publicClient: AppPublicClient,
    private readonly config: AppConfig,
    private readonly traderAddress: Address | undefined,
  ) {
    this.tokenChecker = new TokenChecker(publicClient);
    this.liquidityChecker = new LiquidityChecker(publicClient, config.minWbnbLiquidityWei);
    this.publicClient = publicClient;
  }

  private readonly publicClient: AppPublicClient;

  public async inspect(pair: PairInfo): Promise<SafetyReport> {
    const reasons: string[] = [];
    const token = await this.tokenChecker.inspect(pair.token);
    if (!token.accepted || token.metadata === undefined) {
      reasons.push(token.reason ?? 'Contrôle BEP-20 refusé.');
      return {
        accepted: false,
        metadata: undefined,
        wbnbLiquidityWei: 0n,
        probeStatus: 'SKIPPED',
        probeTokensBought: 0n,
        probeBnbRecovered: 0n,
        roundTripLossBps: undefined,
        reasons,
      };
    }

    const liquidity = await this.liquidityChecker.check(pair);
    if (!liquidity.accepted) {
      reasons.push(liquidity.reason ?? 'Contrôle de liquidité refusé.');
    }

    let probeStatus: SafetyReport['probeStatus'] = 'SKIPPED';
    let probeTokensBought = 0n;
    let probeBnbRecovered = 0n;
    let roundTripLossBps: number | undefined;

    if (this.config.safetyProbeAddress !== undefined && this.traderAddress !== undefined) {
      const probe = new SafetyProbe(
        this.publicClient,
        this.config.safetyProbeAddress,
        this.traderAddress,
        this.config.buyAmountWei,
        this.config.maxRoundTripLossBps,
        this.config.txDeadlineSeconds,
      );
      const probeResult = await probe.run(pair.router, pair.token);
      probeStatus = probeResult.passed ? 'PASSED' : 'FAILED';
      probeTokensBought = probeResult.tokensBought;
      probeBnbRecovered = probeResult.bnbRecovered;
      roundTripLossBps = probeResult.lossBps;
      if (!probeResult.passed) {
        reasons.push(probeResult.reason ?? 'Sonde achat/revente refusée.');
      }
    } else if (this.config.executionMode === 'live' && this.config.requireSafetyProbe) {
      reasons.push('La sonde de sécurité est obligatoire en mode live.');
      probeStatus = 'FAILED';
    } else {
      reasons.push('Sonde achat/revente non exécutée en mode simulation.');
    }

    return {
      accepted: liquidity.accepted && probeStatus !== 'FAILED',
      metadata: token.metadata,
      wbnbLiquidityWei: liquidity.wbnbReserveWei,
      probeStatus,
      probeTokensBought,
      probeBnbRecovered,
      roundTripLossBps,
      reasons,
    };
  }
}
