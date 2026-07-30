import assert from 'node:assert/strict';
import test from 'node:test';
import { parseRpcMaxLogBlockRange } from '../src/config/env.js';

test('RPC_MAX_LOG_BLOCK_RANGE utilise 100 par défaut', () => {
  assert.equal(parseRpcMaxLogBlockRange(undefined), 100);
});

for (const value of ['0', '-1', '1501', 'abc']) {
  test(`refuse RPC_MAX_LOG_BLOCK_RANGE="${value}"`, () => {
    assert.throws(
      () => parseRpcMaxLogBlockRange(value),
      /RPC_MAX_LOG_BLOCK_RANGE.*entier entre 1 et 1500/i,
    );
  });
}

for (const value of ['1', '1500']) {
  test(`accepte RPC_MAX_LOG_BLOCK_RANGE="${value}"`, () => {
    assert.equal(parseRpcMaxLogBlockRange(value), Number(value));
  });
}
