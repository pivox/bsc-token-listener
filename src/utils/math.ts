export const BPS_DENOMINATOR = 10_000n;

export function applySlippage(amount: bigint, slippageBps: number): bigint {
  const minimum = (amount * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
  return minimum > 0n ? minimum : 1n;
}

export function calculateLossBps(input: bigint, recovered: bigint): number {
  if (input <= 0n || recovered >= input) {
    return 0;
  }
  return Number(((input - recovered) * BPS_DENOMINATOR) / input);
}
