import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;

export const RUNTIME_TABLES: readonly string[] = [
  'trade_transactions',
  'position_exit_decisions',
  'reconciliation_decisions',
  'trades',
  'token_risk_reports',
  'swap_events',
  'discovered_tokens',
  'token_sessions',
  'canonical_blocks',
  'chain_reorgs',
  'listener_checkpoints',
  'fresh_start_runs',
] as const;

interface QueryResult {
  rows: Array<{ count?: string }>;
  rowCount?: number | null;
}

export interface ResetDatabaseClient {
  query(sql: string): Promise<QueryResult>;
}

export function hasResetConfirmation(args: readonly string[]): boolean {
  return args.includes('--yes');
}

export function isDevelopmentProcess(command: string): boolean {
  return /\btsx\s+watch\s+src\/app\.ts(?:\s|$)/u.test(command);
}

export async function resetRuntimeDatabase(
  database: ResetDatabaseClient,
): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  await database.query('BEGIN');
  try {
    for (const table of RUNTIME_TABLES) {
      const result = await database.query(`DELETE FROM ${table}`);
      deleted[table] = result.rowCount ?? Number(result.rows[0]?.count ?? 0);
    }
    await database.query('COMMIT');
    return deleted;
  } catch (error) {
    await database.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

function developmentProcessIsRunning(): boolean {
  const processes = execFileSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
  return processes.split('\n').some(isDevelopmentProcess);
}

async function main(): Promise<void> {
  if (!hasResetConfirmation(process.argv.slice(2))) {
    throw new Error('Refus de réinitialiser la BDD : relance avec --yes après avoir arrêté npm run dev.');
  }
  if (developmentProcessIsRunning()) {
    throw new Error('Refus de réinitialiser la BDD : npm run dev semble encore actif.');
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL est requis.');

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const deleted = await resetRuntimeDatabase(pool);
    for (const table of RUNTIME_TABLES) {
      console.log(`${table}: ${deleted[table] ?? 0}`);
    }
    console.log('Réinitialisation runtime terminée.');
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Réinitialisation impossible.');
    process.exitCode = 1;
  });
}
