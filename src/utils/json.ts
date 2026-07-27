const BIGINT_MARKER = '__bsc_bot_bigint__';

export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) =>
    typeof current === 'bigint' ? { [BIGINT_MARKER]: current.toString() } : current,
  );
}

export function parseJson<T>(value: unknown): T {
  const input = typeof value === 'string' ? value : JSON.stringify(value);
  return JSON.parse(input, (_key, current: unknown) => {
    if (
      typeof current === 'object' &&
      current !== null &&
      BIGINT_MARKER in current &&
      typeof (current as Record<string, unknown>)[BIGINT_MARKER] === 'string'
    ) {
      return BigInt((current as Record<string, string>)[BIGINT_MARKER]!);
    }
    return current;
  }) as T;
}
