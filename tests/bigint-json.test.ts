import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWithBigInt, stringifyWithBigInt } from '../src/utils/bigint-json.js';

test('préserve les bigint dans les payloads PostgreSQL', () => {
  const input = { amount: 12345678901234567890n, nested: [1n, 2n] };
  const output = parseWithBigInt<typeof input>(stringifyWithBigInt(input));
  assert.deepEqual(output, input);
});

test('refuse une racine non sérialisable', () => {
  assert.throws(() => stringifyWithBigInt(undefined), /ne peut pas être sérialisée/u);
});
