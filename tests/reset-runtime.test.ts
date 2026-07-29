import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RUNTIME_TABLES,
  hasResetConfirmation,
  isDevelopmentProcess,
  resetRuntimeDatabase,
} from '../scripts/reset-runtime.js';

test('requires the explicit reset confirmation flag', () => {
  assert.equal(hasResetConfirmation([]), false);
  assert.equal(hasResetConfirmation(['--yes']), true);
});

test('detects the development watcher process without matching unrelated commands', () => {
  assert.equal(isDevelopmentProcess('node /repo/node_modules/.bin/tsx watch src/app.ts'), true);
  assert.equal(isDevelopmentProcess('node scripts/check-rpc.ts'), false);
});

test('deletes runtime tables in dependency-safe order and preserves configuration tables', async () => {
  const calls: string[] = [];
  const database = {
    async query(sql: string): Promise<{ rows: Array<{ count: string }> }> {
      calls.push(sql);
      return { rows: [{ count: '2' }] };
    },
  };

  await resetRuntimeDatabase(database);

  assert.deepEqual(calls, [
    'BEGIN',
    ...RUNTIME_TABLES.map((table) => `DELETE FROM ${table}`),
    'COMMIT',
  ]);
  assert.ok(RUNTIME_TABLES.indexOf('trade_transactions') < RUNTIME_TABLES.indexOf('trades'));
  assert.ok(!RUNTIME_TABLES.includes('runtime_settings'));
  assert.ok(!RUNTIME_TABLES.includes('strategy_settings'));
  assert.ok(!RUNTIME_TABLES.includes('ignored_assets'));
});

test('rolls back when a runtime deletion fails', async () => {
  const calls: string[] = [];
  const database = {
    async query(sql: string): Promise<{ rows: Array<{ count: string }> }> {
      calls.push(sql);
      if (sql.startsWith('DELETE FROM')) throw new Error('database failure');
      return { rows: [] };
    },
  };

  await assert.rejects(() => resetRuntimeDatabase(database), /database failure/u);
  assert.equal(calls.at(-1), 'ROLLBACK');
});
