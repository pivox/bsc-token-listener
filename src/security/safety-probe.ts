import {
  BaseError,
  ContractFunctionRevertedError,
  type Address,
} from 'viem';
import { safetyProbeAbi } from '../abi/safety-probe.abi.js';
import type { AppPublicClient } from '../rpc/clients.js';
import { calculateLossBps } from '../utils/math.js';

export interface SafetyProbeResult {
  passed: boolean;
  tokensBought: bigint;
  bnbRecovered: bigint;
  lossBps: number | undefined;
  reason: string | undefined;
}

export class SafetyProbe {
  public constructor(
    private readonly publicClient: AppPublicClient,
    private readonly probeAddress: Address,
    private readonly account: Address,
    private readonly amountWei: bigint,
    private readonly maxLossBps: number,
    private readonly deadlineSeconds: number,
  ) {}

  public async run(router: Address, token: Address): Promise<SafetyProbeResult> {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + this.deadlineSeconds);

    try {
      await this.publicClient.simulateContract({
        account: this.account,
        address: this.probeAddress,
        abi: safetyProbeAbi,
        functionName: 'probe',
        args: [router, token, deadline],
        value: this.amountWei,
      });

      return {
        passed: false,
        tokensBought: 0n,
        bnbRecovered: 0n,
        lossBps: undefined,
        reason: "La sonde n'a pas produit le résultat sécurisé attendu.",
      };
    } catch (error) {
      const revertError =
        error instanceof BaseError
          ? error.walk((candidate) => candidate instanceof ContractFunctionRevertedError)
          : undefined;

      if (
        revertError instanceof ContractFunctionRevertedError &&
        revertError.data?.errorName === 'ProbeResult'
      ) {
        const args = revertError.data.args;
        if (
          !Array.isArray(args) ||
          args.length !== 2 ||
          typeof args[0] !== 'bigint' ||
          typeof args[1] !== 'bigint'
        ) {
          return {
            passed: false,
            tokensBought: 0n,
            bnbRecovered: 0n,
            lossBps: undefined,
            reason: 'Résultat de sonde mal formé.',
          };
        }

        const tokensBought = args[0];
        const bnbRecovered = args[1];
        const lossBps = calculateLossBps(this.amountWei, bnbRecovered);
        const passed = tokensBought > 0n && bnbRecovered > 0n && lossBps <= this.maxLossBps;

        return {
          passed,
          tokensBought,
          bnbRecovered,
          lossBps,
          reason: passed
            ? undefined
            : `Perte aller-retour ${lossBps} bps, maximum autorisé ${this.maxLossBps} bps.`,
        };
      }

      return {
        passed: false,
        tokensBought: 0n,
        bnbRecovered: 0n,
        lossBps: undefined,
        reason: `Simulation achat/revente échouée: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
