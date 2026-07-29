import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Hash } from 'viem';
import {
  FRESH_START_REASON,
  type FreshStartCutoff,
} from '../src/runtime/fresh-start.types.js';
import { FreshStartRepository } from '../src/runtime/fresh-start.repository.js';

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

test('applique session, décision, checkpoints, journal et audit dans une transaction', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  let releases = 0;
  const client = {
    query: async <T = Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ): Promise<{ rows: T[] }> => {
      calls.push(values === undefined ? { sql } : { sql, values });
      if (sql.includes('pg_try_advisory_lock')) {
        return { rows: [{ locked: true }] as T[] };
      }
      if (sql.includes('UPDATE token_sessions')) {
        return { rows: [{ pair_address: '0x1' }] as T[] };
      }
      if (sql.includes('UPDATE position_exit_decisions')) {
        return { rows: [{ decision_id: 'decision-1' }] as T[] };
      }
      if (sql.includes('INSERT INTO fresh_start_runs')) {
        return {
          rows: [{
            run_id: 'run-1',
            cutoff_block_number: '9007199254740993',
            cutoff_block_hash: HASH,
            cutoff_parent_hash: PARENT_HASH,
            quarantined_sessions: 1,
            quarantined_decisions: 1,
            applied_at: new Date(1),
          }] as T[],
        };
      }
      return { rows: [] as T[] };
    },
    release(): void {
      releases += 1;
    },
  };
  const repository = new FreshStartRepository({
    connect: async () => client,
  });

  const result = await repository.apply({
    number: 9_007_199_254_740_993n,
    hash: HASH,
    parentHash: PARENT_HASH,
  }, 1);

  assert.equal(result.cutoff.number, 9_007_199_254_740_993n);
  assert.deepEqual(
    calls
      .filter(({ sql }) => ['BEGIN', 'COMMIT'].includes(sql))
      .map(({ sql }) => sql),
    ['BEGIN', 'COMMIT'],
  );
  assert.ok(calls.some(({ sql }) => /pg_advisory_xact_lock/u.test(sql)));
  assert.ok(calls.some(({ sql }) => /UPDATE token_sessions/u.test(sql)));
  assert.ok(
    calls.some(({ sql }) => /UPDATE position_exit_decisions/u.test(sql)),
  );
  assert.ok(
    calls.some(({ sql }) => /UPDATE listener_checkpoints/u.test(sql)),
  );
  assert.ok(calls.some(({ sql }) => /DELETE FROM canonical_blocks/u.test(sql)));
  assert.ok(calls.some(({ sql }) => /INSERT INTO fresh_start_runs/u.test(sql)));
  assert.equal(releases, 0);

  await repository.close();

  assert.equal(releases, 1);
  assert.ok(calls.some(({ sql }) => /pg_advisory_unlock/u.test(sql)));
});

test('rollback toute la transaction si une étape échoue', async () => {
  const calls: string[] = [];
  const repository = new FreshStartRepository({
    connect: async () => ({
      query: async <T>(sql: string): Promise<{ rows: T[] }> => {
        calls.push(sql);
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ locked: true }] as T[] };
        }
        if (sql.includes('UPDATE position_exit_decisions')) {
          throw new Error('decision update failed');
        }
        return { rows: [] };
      },
      release(): void {},
    }),
  });

  await assert.rejects(
    repository.apply(
      { number: 10n, hash: HASH, parentHash: PARENT_HASH },
      1,
    ),
    /decision update failed/u,
  );
  assert.equal(calls.includes('ROLLBACK'), true);
  assert.equal(calls.includes('COMMIT'), false);
});

test('refuse une seconde instance tant que le verrou runtime est détenu', async () => {
  const calls: string[] = [];
  let releases = 0;
  const repository = new FreshStartRepository({
    connect: async () => ({
      query: async <T>(sql: string): Promise<{ rows: T[] }> => {
        calls.push(sql);
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ locked: false }] as T[] };
        }
        throw new Error(`requête inattendue: ${sql}`);
      },
      release(): void {
        releases += 1;
      },
    }),
  });

  await assert.rejects(
    repository.apply(
      { number: 10n, hash: HASH, parentHash: PARENT_HASH },
      1,
    ),
    /instance.*déjà active/iu,
  );
  assert.equal(calls.includes('BEGIN'), false);
  assert.equal(releases, 1);
});
