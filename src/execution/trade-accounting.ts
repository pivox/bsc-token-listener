export interface RealizedPnlInput {
  buyPrincipalWei: bigint;
  sellProceedsWei: bigint;
  buyGasWei: bigint;
  approvalGasWei: bigint;
  sellGasWei: bigint;
}

export interface RealizedPnl {
  grossPnlWei: bigint;
  totalGasWei: bigint;
  netPnlWei: bigint;
}

export function calculateGasCost(gasUsed: bigint, effectiveGasPrice: bigint): bigint {
  if (gasUsed < 0n || effectiveGasPrice < 0n) {
    throw new Error('Le gas et son prix doivent être positifs.');
  }
  return gasUsed * effectiveGasPrice;
}

export function calculateBuyPrincipal(
  nativeBalanceBefore: bigint,
  nativeBalanceAfter: bigint,
  gasCostWei: bigint,
): bigint {
  const totalDebit = nativeBalanceBefore - nativeBalanceAfter;
  if (totalDebit < gasCostWei || gasCostWei < 0n) {
    throw new Error('variation native d\'achat invalide.');
  }
  return totalDebit - gasCostWei;
}

export function calculateSellProceeds(
  nativeBalanceBefore: bigint,
  nativeBalanceAfter: bigint,
  gasCostWei: bigint,
): bigint {
  const proceeds = nativeBalanceAfter - nativeBalanceBefore + gasCostWei;
  if (proceeds < 0n || gasCostWei < 0n) {
    throw new Error('variation native de vente invalide.');
  }
  return proceeds;
}

export function calculateRealizedPnl(input: RealizedPnlInput): RealizedPnl {
  const totalGasWei = input.buyGasWei + input.approvalGasWei + input.sellGasWei;
  const grossPnlWei = input.sellProceedsWei - input.buyPrincipalWei;
  return {
    grossPnlWei,
    totalGasWei,
    netPnlWei: grossPnlWei - totalGasWei,
  };
}
