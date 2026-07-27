import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export async function migrate(): Promise<void> {
  const directory = resolve('migrations');
  const files = (await readdir(directory))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  for (const file of files) {
    const alreadyApplied = await pool.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version = $1) AS exists',
      [file],
    );
    if (alreadyApplied.rows[0]?.exists) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(resolve(directory, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      logger.info({ migration: file }, 'Migration appliquée.');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
