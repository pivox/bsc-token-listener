import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { schemaName } from './schema-name.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL est obligatoire pour les tests PostgreSQL.');
}

const { Client } = pg;

export interface SchemaDatabase {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  connect(): Promise<SchemaDatabaseClient>;
}

export interface SchemaDatabaseClient {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  release(): void;
}

export async function withMigratedSchema<T>(
  label: string,
  run: (database: SchemaDatabase) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: testDatabaseUrl });
  const schema = schemaName('dry_run_e2e', label);
  await client.connect();

  const query: SchemaDatabase['query'] = async <Row = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ) => {
    const result = await client.query(sql, values);
    return { rows: result.rows as Row[] };
  };

  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    const migrationFiles = (await readdir('migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const file of migrationFiles) {
      await client.query(await readFile(`migrations/${file}`, 'utf8'));
    }

    const database: SchemaDatabase = {
      query,
      connect: async () => ({ query, release(): void {} }),
    };
    return await run(database);
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}
