const BIGINT_TAG = '__bsc_bot_bigint__';

export function stringifyWithBigInt(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child === 'bigint') {
      return { [BIGINT_TAG]: child.toString() };
    }
    return child;
  });
  if (encoded === undefined) {
    throw new Error('La valeur ne peut pas être sérialisée en JSON.');
  }
  return encoded;
}

export function parseWithBigInt<T>(value: string): T {
  return JSON.parse(value, (_key, child: unknown) => {
    if (child !== null && typeof child === 'object' && BIGINT_TAG in child) {
      const encoded = (child as Record<string, unknown>)[BIGINT_TAG];
      if (typeof encoded === 'string') {
        return BigInt(encoded);
      }
    }
    return child;
  }) as T;
}
