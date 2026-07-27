export interface PnlCalculation {
  deltaWei: bigint;
  percentage: string | null;
}

export function calculatePnl(costWei: bigint, valueWei: bigint): PnlCalculation {
  const deltaWei = valueWei - costWei;
  return {
    deltaWei,
    percentage: formatPercentage(deltaWei, costWei),
  };
}

export function applyBasisPointReduction(amountWei: bigint, basisPoints: number): bigint {
  if (!Number.isInteger(basisPoints) || basisPoints < 0 || basisPoints > 10_000) {
    throw new Error('basisPoints doit être un entier entre 0 et 10000.');
  }
  return (amountWei * BigInt(10_000 - basisPoints)) / 10_000n;
}

export function formatPercentage(delta: bigint, basis: bigint): string | null {
  if (basis <= 0n) return null;
  const hundredths = (delta * 10_000n) / basis;
  const sign = hundredths < 0n ? '-' : '';
  const absolute = hundredths < 0n ? -hundredths : hundredths;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${sign}${whole.toString()}.${fraction}`;
}
