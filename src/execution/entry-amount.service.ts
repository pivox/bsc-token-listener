import { config } from '../config/env.js';
import { calculateEntryAmount } from '../strategy/entry-sizing.js';
import type { TokenSession } from '../types/domain.js';

export interface WalletBalanceProvider {
  getWalletBalanceWei(): Promise<bigint | null>;
}

export class EntryAmountService {
  constructor(private readonly walletBalanceProvider: WalletBalanceProvider) {}

  async resolve(session: TokenSession, liquidityWbnbWei: bigint): Promise<bigint | null> {
    const observedBuyAmountsWei = (session.entryObservationBuys ?? []).map((event) => event.amountWbnb);
    const walletBalanceWei = await this.walletBalanceProvider.getWalletBalanceWei();
    const effectiveWalletBalanceWei = walletBalanceWei
      ?? config.gasReserveWei
      + (config.maxBuyBnbWei * 10_000n) / BigInt(config.buyWalletShareBps);

    return calculateEntryAmount(
      liquidityWbnbWei,
      observedBuyAmountsWei,
      effectiveWalletBalanceWei,
      config.minBuyBnbWei,
      config.maxBuyBnbWei,
      config.buyLiquidityShareBps,
      config.buyMedianFactorBps,
      config.buyWalletShareBps,
      config.gasReserveWei,
      config.buyAmountStepWei,
    );
  }
}
