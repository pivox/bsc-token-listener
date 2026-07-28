export function readBlockConfirmations(
  environment: NodeJS.ProcessEnv,
): number {
  const raw = environment.BLOCK_CONFIRMATIONS?.trim() ?? '5';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error('BLOCK_CONFIRMATIONS doit être un entier entre 1 et 100.');
  }
  return value;
}

export function confirmedHead(
  latestBlock: bigint,
  confirmations: number,
): bigint | null {
  const depth = BigInt(confirmations);
  return latestBlock < depth ? null : latestBlock - depth;
}
