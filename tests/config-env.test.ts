import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProviderUrls, parseRpcMaxLogBlockRange } from '../src/config/env.js';

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

test('la nouvelle liste HTTP remplace les variables legacy', () => {
  const previous = [
    process.env.BSC_HTTP_RPC_URLS,
    process.env.BSC_HTTP_URLS,
    process.env.BSC_HTTP_RPC_URL,
  ] as const;
  process.env.BSC_HTTP_RPC_URLS = 'https://new-one.example,https://new-two.example';
  process.env.BSC_HTTP_URLS = 'https://legacy-list.example';
  process.env.BSC_HTTP_RPC_URL = 'https://legacy-single.example';
  try {
    assert.deepEqual(
      parseProviderUrls('BSC_HTTP_RPC_URLS', 'BSC_HTTP_URLS', 'BSC_HTTP_RPC_URL'),
      ['https://new-one.example', 'https://new-two.example'],
    );
  } finally {
    const names = ['BSC_HTTP_RPC_URLS', 'BSC_HTTP_URLS', 'BSC_HTTP_RPC_URL'] as const;
    names.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});

test('les URLs legacy ne servent que de fallback', () => {
  const previous = [
    process.env.BSC_HTTP_RPC_URLS,
    process.env.BSC_HTTP_URLS,
    process.env.BSC_HTTP_RPC_URL,
  ] as const;
  delete process.env.BSC_HTTP_RPC_URLS;
  process.env.BSC_HTTP_URLS = 'https://legacy-list.example';
  process.env.BSC_HTTP_RPC_URL = 'https://legacy-single.example';
  try {
    assert.deepEqual(
      parseProviderUrls('BSC_HTTP_RPC_URLS', 'BSC_HTTP_URLS', 'BSC_HTTP_RPC_URL'),
      ['https://legacy-list.example', 'https://legacy-single.example'],
    );
  } finally {
    const names = ['BSC_HTTP_RPC_URLS', 'BSC_HTTP_URLS', 'BSC_HTTP_RPC_URL'] as const;
    names.forEach((name, index) => {
      const value = previous[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  }
});
