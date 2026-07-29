import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Hash } from 'viem';
import {
  FRESH_START_REASON,
  type FreshStartCutoff,
} from '../src/runtime/fresh-start.types.js';

const HASH = `0x${'1'.repeat(64)}` as Hash;
const PARENT_HASH = `0x${'2'.repeat(64)}` as Hash;

test('définit une raison stable et un cutoff bigint hash-aware', () => {
  const cutoff: FreshStartCutoff = {
    number: 9_007_199_254_740_993n,
    hash: HASH,
    parentHash: PARENT_HASH,
  };
  assert.equal(FRESH_START_REASON, 'FRESH_START_CUTOFF');
  assert.equal(cutoff.number, 9_007_199_254_740_993n);
});

test('la migration fresh-start est idempotente et bigint-safe', async () => {
  const sql = await readFile('migrations/009_fresh_start_cutoff.sql', 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fresh_start_runs/u);
  assert.match(sql, /cutoff_block_number NUMERIC\(78,\s*0\)/u);
  assert.match(sql, /cutoff_block_hash TEXT NOT NULL/u);
  assert.match(sql, /cutoff_parent_hash TEXT NOT NULL/u);
  assert.match(sql, /quarantined_sessions INTEGER NOT NULL/u);
  assert.match(sql, /quarantined_decisions INTEGER NOT NULL/u);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS/u);
});
