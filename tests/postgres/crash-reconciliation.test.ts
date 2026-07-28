import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL est obligatoire pour les tests PostgreSQL.');
}

const { Client } = pg;

test('migration de réconciliation idempotente', async () => {
  const client = new Client({ connectionString: testDatabaseUrl });
  const schema = `crash_reconciliation_${randomUUID().replaceAll('-', '')}`;
  await client.connect();

  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE token_sessions (
        pair_address TEXT PRIMARY KEY,
        token_address TEXT NOT NULL,
        status TEXT NOT NULL,
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )
    `);

    const migration = await readFile('migrations/006_crash_reconciliation.sql', 'utf8');
    await client.query(migration);
    await client.query(migration);

    const columns = await client.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'token_sessions'
    `, [schema]);
    const names = new Set(columns.rows.map((row) => row.column_name));
    for (const expected of [
      'recovery_owner',
      'recovery_lease_until',
      'recovery_attempts',
      'recovery_error',
      'last_reconciled_at',
    ]) {
      assert.equal(names.has(expected), true, `colonne absente: ${expected}`);
    }

    const decisions = await client.query<{ exists: boolean }>(`
      SELECT EXISTS(
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'reconciliation_decisions'
      ) AS exists
    `, [schema]);
    assert.equal(decisions.rows[0]?.exists, true);
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
