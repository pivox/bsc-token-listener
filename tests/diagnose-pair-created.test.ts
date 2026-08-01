import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDiagnosticPairChunkSize } from '../scripts/diagnose-pair-created.js';

test('parseDiagnosticPairChunkSize utilise RPC_MAX_LOG_BLOCK_RANGE par défaut', () => {
  const previous = process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE;
  delete process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE;
  try {
    assert.equal(parseDiagnosticPairChunkSize(), 100);
  } finally {
    if (previous === undefined) {
      delete process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE;
    } else {
      process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE = previous;
    }
  }
});

test('parseDiagnosticPairChunkSize rejette une valeur vide, nulle ou non entière', () => {
  const previous = process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE;
  for (const value of ['0', '-1', 'abc']) {
    process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE = value;
    assert.throws(
      () => parseDiagnosticPairChunkSize(),
      /PAIR_DIAGNOSTIC_CHUNK_SIZE/,
    );
  }
  if (previous === undefined) {
    delete process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE;
  } else {
    process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE = previous;
  }
});

test('parseDiagnosticPairChunkSize accepte une valeur inférieure à la limite', () => {
  const previous = process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE;
  process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE = '50';
  try {
    assert.equal(parseDiagnosticPairChunkSize(), 50);
  } finally {
    if (previous === undefined) {
      delete process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE;
    } else {
      process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE = previous;
    }
  }
});

test('parseDiagnosticPairChunkSize refuse une valeur supérieure à RPC_MAX_LOG_BLOCK_RANGE', () => {
  const previous = process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE;
  process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE = '101';
  try {
    assert.throws(
      () => parseDiagnosticPairChunkSize(),
      /dépasse RPC_MAX_LOG_BLOCK_RANGE/,
    );
  } finally {
    if (previous === undefined) {
      delete process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE;
    } else {
      process.env.PAIR_DIAGNOSTIC_CHUNK_SIZE = previous;
    }
  }
});
