import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import type { Address, Hash } from 'viem';
import { stringifyJson } from '../../src/utils/json.js';
import type {
  NewPositionExitDecision,
  PositionMetricsSnapshot,
} from '../../src/strategy/position-exit.types.js';
import type { TokenSession } from '../../src/types/domain.js';
import { schemaName } from './schema-name.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL est obligatoire pour les tests PostgreSQL.');
}
process.env.DATABASE_URL = testDatabaseUrl;
process.env.BSC_HTTP_RPC_URL ??= 'http://127.0.0.1:8545';
process.env.BSC_WS_RPC_URL ??= 'ws://127.0.0.1:8546';

const { Client } = pg;
const PAIR = `0x${'1'.repeat(40)}` as Address;
const TOKEN = `0x${'2'.repeat(40)}` as Address;
const HASH = `0x${'3'.repeat(64)}` as Hash;

interface QueryResult<T> {
  rows: T[];
}

function scopedDatabase(schema: string): {
  query: <T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ) => Promise<QueryResult<T>>;
  connect: () => Promise<{
    query: <T = Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ) => Promise<QueryResult<T>>;
    release: () => void;
  }>;
} {
  const query = async <T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> => {
    const client = new Client({ connectionString: testDatabaseUrl });
    await client.connect();
    try {
      await client.query(`SET search_path TO ${schema}`);
      const result = await client.query(sql, values);
      return { rows: result.rows as T[] };
    } finally {
      await client.end();
    }
  };
  return {
    query,
    connect: async () => {
      const client = new Client({ connectionString: testDatabaseUrl });
      await client.connect();
      await client.query(`SET search_path TO ${schema}`);
      return {
        query: async <T = Record<string, unknown>>(
          sql: string,
          values?: unknown[],
        ): Promise<QueryResult<T>> => {
          const result = await client.query(sql, values);
          return { rows: result.rows as T[] };
        },
        release: () => {
          void client.end();
        },
      };
    },
  };
}

async function withSchema(
  label: string,
  run: (client: InstanceType<typeof Client>, schema: string) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: testDatabaseUrl });
  const schema = schemaName('position_exit', label);
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await run(client, schema);
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

function metrics(): PositionMetricsSnapshot {
  return {
    quoteWei: 9_007_199_254_740_993n,
    entryCostWei: 1_000n,
    netExitValueWei: 900n,
    currentLiquidityWbnbWei: 5_000n,
    estimatedExitGasWei: 50n,
    sellTaxBps: 100,
    probeStatus: 'SAFE',
    probeMeasuredAtMs: 1_000,
  };
}

function decision(idempotencyKey: string): NewPositionExitDecision {
  return {
    idempotencyKey,
    pair: PAIR,
    token: TOKEN,
    settingsRevision: 1,
    primaryRule: 'STOP_LOSS',
    triggeredRules: ['STOP_LOSS'],
    action: 'SELL',
    metrics: metrics(),
    reason: 'Stop loss atteint.',
  };
}

function holdingSession(): TokenSession {
  return {
    pair: {
      factory: PAIR,
      router: PAIR,
      wbnb: PAIR,
      pair: PAIR,
      token: TOKEN,
      token0: TOKEN,
      token1: PAIR,
      createdBlock: 1n,
      blockHash: HASH,
      createdTransactionHash: HASH,
      createdLogIndex: 0,
      discoveredAtMs: 1,
    },
    metadata: {
      address: TOKEN,
      name: 'Token',
      symbol: 'TKN',
      decimals: 18,
      totalSupply: 1_000n,
      codeSizeBytes: 1,
    },
    status: 'HOLDING',
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 2,
    exitPolicy: {
      referenceLiquidityWbnbWei: 10_000n,
      currentLiquidityWbnbWei: 8_000n,
      peakNetValueWei: 1_500n,
      latestNetValueWei: 1_300n,
      trailingArmedAtMs: 2,
      settingsRevision: 1,
    },
  };
}

test('migration, révisions concurrentes, audit et reset restent atomiques', async () => {
  await withSchema('settings', async (client, schema) => {
    const migration = await readFile('migrations/008_position_exit_policy.sql', 'utf8');
    await client.query(migration);
    await client.query(migration);

    const { PositionExitRepository } =
      await import('../../src/strategy/position-exit.repository.js');
    const { defaultPositionExitSettings } =
      await import('../../src/strategy/position-exit-settings.js');
    const database = scopedDatabase(schema);
    const first = new PositionExitRepository(database);
    const second = new PositionExitRepository(database);
    const defaults = defaultPositionExitSettings();
    const updated = { ...defaults, stopLossBps: 1_500 };

    const attempts = await Promise.allSettled([
      first.saveSettings(updated, 0, 'DASHBOARD'),
      second.saveSettings(updated, 0, 'DASHBOARD'),
    ]);
    assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
    assert.equal((await first.getSettings())?.revision, 1);

    const reset = await first.resetSettings(1, defaults);
    assert.equal(reset.source, 'ENV');
    assert.equal(reset.revision, 0);
    assert.equal(await first.getSettings(), null);

    const afterReset = await second.saveSettings(updated, 0, 'DASHBOARD');
    assert.equal(afterReset.revision, 3);
    const audit = await client.query<{
      revision: number;
      source: string;
    }>(
      `SELECT revision, source
       FROM strategy_settings_audit
       ORDER BY revision`,
    );
    assert.deepEqual(audit.rows, [
      { revision: 1, source: 'DASHBOARD' },
      { revision: 2, source: 'ENV_RESET' },
      { revision: 3, source: 'DASHBOARD' },
    ]);
  });
});

test('les décisions sont dédupliquées et récupérables après redémarrage', async () => {
  await withSchema('decisions', async (client, schema) => {
    await client.query(await readFile('migrations/008_position_exit_policy.sql', 'utf8'));
    const { PositionExitRepository } =
      await import('../../src/strategy/position-exit.repository.js');
    const first = new PositionExitRepository(scopedDatabase(schema));
    const created = await first.createDecision(decision('pair:stop-loss:1'));
    const duplicate = await first.createDecision(decision('pair:stop-loss:1'));
    assert.equal(duplicate.id, created.id);
    assert.equal(duplicate.metrics.quoteWei, 9_007_199_254_740_993n);

    const restarted = new PositionExitRepository(scopedDatabase(schema));
    assert.deepEqual(
      (await restarted.listRecoverableDecisions()).map((value) => value.id),
      [created.id],
    );
    assert.equal(
      await restarted.transitionDecision(
        created.id,
        'PENDING',
        'EXECUTING',
        { relatedTradeId: 'trade-sell-1' },
      ),
      true,
    );
    assert.equal(
      await restarted.transitionDecision(created.id, 'PENDING', 'EXECUTING'),
      false,
    );
    const recovered = await restarted.findDecision(created.id);
    assert.equal(recovered?.status, 'EXECUTING');
    assert.equal(recovered?.relatedTradeId, 'trade-sell-1');
  });
});

test('l’état trailing et la référence de liquidité survivent au redémarrage', async () => {
  await withSchema('session_state', async (client, schema) => {
    for (const migrationFile of [
      'migrations/001_init.sql',
      'migrations/006_crash_reconciliation.sql',
      'migrations/007_chain_reorg_safety.sql',
      'migrations/008_position_exit_policy.sql',
    ]) {
      await client.query(await readFile(migrationFile, 'utf8'));
    }
    const { SessionRepository } =
      await import('../../src/storage/repositories.js');
    const database = scopedDatabase(schema);
    await new SessionRepository(database).save(holdingSession());

    const restarted = new SessionRepository(database);
    const loaded = await restarted.loadHolding();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0]?.exitPolicy?.referenceLiquidityWbnbWei, 10_000n);
    assert.equal(loaded[0]?.exitPolicy?.peakNetValueWei, 1_500n);
    assert.equal(loaded[0]?.exitPolicy?.trailingArmedAtMs, 2);
  });
});

test('un JSON de décision corrompu échoue fermé', async () => {
  await withSchema('malformed', async (client, schema) => {
    await client.query(await readFile('migrations/008_position_exit_policy.sql', 'utf8'));
    const { PositionExitRepository } =
      await import('../../src/strategy/position-exit.repository.js');
    const repository = new PositionExitRepository(scopedDatabase(schema));
    const created = await repository.createDecision(decision('pair:malformed:1'));
    await client.query(
      `UPDATE position_exit_decisions
       SET metrics = '{"quoteWei":"not-a-bigint"}'::jsonb
       WHERE decision_id = $1`,
      [created.id],
    );
    await assert.rejects(
      repository.findDecision(created.id),
      /Métriques de décision persistées invalides/u,
    );
  });
});
