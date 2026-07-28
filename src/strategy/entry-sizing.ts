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
