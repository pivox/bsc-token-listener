export function medianBigInt(values: readonly bigint[]): bigint {
  if (values.length === 0) {
    throw new Error('medianBigInt: values must not be empty');
  }

  const sortedValues = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const middle = Math.floor(sortedValues.length / 2);

  if (sortedValues.length % 2 === 1) {
    return sortedValues[middle]!;
  }

  const lower = sortedValues[middle - 1];
  const upper = sortedValues[middle];
  if (lower === undefined || upper === undefined) {
    throw new Error('medianBigInt: unable to compute median.');
  }

  return (lower + upper) / 2n;
}

export function calculateEntryAmount(
  liquidityWbnbWei: bigint,
  observedBuyAmountsWei: readonly bigint[],
  walletBalanceWei: bigint,
  minBuyWei: bigint,
  maxBuyWei: bigint,
  liquidityShareBps: number,
  medianFactorBps: number,
  walletShareBps: number,
  gasReserveWei: bigint,
  stepWei: bigint,
): bigint | null {
  const liquidityCap = (liquidityWbnbWei * BigInt(liquidityShareBps)) / 10_000n;
  const medianCap = (medianBigInt(observedBuyAmountsWei) * BigInt(medianFactorBps)) / 10_000n;

  const availableWallet = walletBalanceWei > gasReserveWei ? walletBalanceWei - gasReserveWei : 0n;
  const walletCap = (availableWallet * BigInt(walletShareBps)) / 10_000n;

  let raw = maxBuyWei;
  if (liquidityCap < raw) {
    raw = liquidityCap;
  }
  if (medianCap < raw) {
    raw = medianCap;
  }
  if (walletCap < raw) {
    raw = walletCap;
  }

  const amount = raw - (raw % stepWei);
  if (amount < minBuyWei) {
    return null;
  }

  return amount;
}
