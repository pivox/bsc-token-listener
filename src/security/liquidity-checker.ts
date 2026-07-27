import { isAddressEqual } from 'viem';
import { pancakePairAbi } from '../abi/pancake-pair.abi.js';
import type { AppPublicClient } from '../rpc/clients.js';
import type { PairInfo } from '../types/domain.js';

export interface LiquidityCheckResult {
  accepted: boolean;
  wbnbReserveWei: bigint;
  tokenReserve: bigint;
  reason: string | undefined;
}

export class LiquidityChecker {
  public constructor(
    private readonly publicClient: AppPublicClient,
    private readonly minimumWbnbReserveWei: bigint,
  ) {}

  public async check(pair: PairInfo): Promise<LiquidityCheckResult> {
    try {
      const reserves = await this.publicClient.readContract({
        address: pair.pair,
        abi: pancakePairAbi,
        functionName: 'getReserves',
      });
      const reserve0 = reserves[0];
      const reserve1 = reserves[1];
      const wbnbIsToken0 = isAddressEqual(pair.token0, pair.wbnb);
      const wbnbReserveWei = wbnbIsToken0 ? reserve0 : reserve1;
      const tokenReserve = wbnbIsToken0 ? reserve1 : reserve0;

      if (wbnbReserveWei < this.minimumWbnbReserveWei) {
        return {
          accepted: false,
          wbnbReserveWei,
          tokenReserve,
          reason: 'Liquidité WBNB inférieure au minimum configuré.',
        };
      }
      if (tokenReserve <= 0n) {
        return {
          accepted: false,
          wbnbReserveWei,
          tokenReserve,
          reason: 'Réserve token nulle.',
        };
      }

      return {
        accepted: true,
        wbnbReserveWei,
        tokenReserve,
        reason: undefined,
      };
    } catch (error) {
      return {
        accepted: false,
        wbnbReserveWei: 0n,
        tokenReserve: 0n,
        reason: `Lecture de liquidité impossible: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
