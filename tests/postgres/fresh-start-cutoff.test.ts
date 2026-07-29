import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import type { Address, Hash } from 'viem';
import type { FreshStartCutoff } from '../../src/runtime/fresh-start.types.js';
import type { TokenSession } from '../../src/types/domain.js';
import { stringifyJson } from '../../src/utils/json.js';
import { schemaName } from './schema-name.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();
if (!testDatabaseUrl) {
  throw new Error('TEST_DATABASE_URL est obligatoire pour les tests PostgreSQL.');
}
process.env.DATABASE_URL = testDatabaseUrl;
process.env.BSC_HTTP_RPC_URL ??= 'http://127.0.0.1:8545';
process.env.BSC_WS_RPC_URL ??= 'ws://127.0.0.1:8546';

const { Client } = pg;
const HASH = `0x${'a'.repeat(64)}` as Hash;
const PARENT_HASH = `0x${'b'.repeat(64)}` as Hash;

interface QueryResult<T> {
  rows: T[];
}

interface RepositoryDatabase {
  connect(): Promise<{
    query<T = Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ): Promise<QueryResult<T>>;
    release(): void;
  }>;
}

function address(value: number): Address {
  return `0x${value.toString(16).padStart(40, '0')}` as Address;
}

function session(
  status: TokenSession['status'],
  index: number,
): TokenSession {
  const pair = address(index * 2 + 1);
  const token = address(index * 2 + 2);
  return {
    pair: {
      factory: address(10_001),
      router: address(10_002),
      wbnb: address(10_003),
      pair,
      token,
      token0: token,
      token1: address(10_003),
      createdBlock: 1n,
      blockHash: HASH,
      createdTransactionHash: HASH,
      createdLogIndex: index,
      discoveredAtMs: 1,
    },
    metadata: {
      address: token,
      name: `Token ${index}`,
      symbol: `T${index}`,
      decimals: 18,
      totalSupply: 1_000n,
      codeSizeBytes: 1,
    },
    status,
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function scopedDatabase(
  schema: string,
  failSql?: RegExp,
): RepositoryDatabase {
  return {
    connect: async () => {
      const client = new Client({ connectionString: testDatabaseUrl });
      await client.connect();
      await client.query(`SET search_path TO ${schema}`);
      return {
        query: async <T = Record<string, unknown>>(
          sql: string,
          values?: unknown[],
        ): Promise<QueryResult<T>> => {
          if (failSql?.test(sql)) {
            throw new Error('injected fresh-start failure');
          }
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

async function applyMigrations(
  client: InstanceType<typeof Client>,
): Promise<void> {
  for (const file of [
    'migrations/001_init.sql',
    'migrations/005_trade_lifecycle.sql',
    'migrations/006_crash_reconciliation.sql',
    'migrations/007_chain_reorg_safety.sql',
    'migrations/008_position_exit_policy.sql',
    'migrations/009_fresh_start_cutoff.sql',
  ]) {
    await client.query(await readFile(file, 'utf8'));
  }
  await client.query(
    await readFile('migrations/009_fresh_start_cutoff.sql', 'utf8'),
  );
}

async function withSchema(
  label: string,
  run: (
    client: InstanceType<typeof Client>,
    schema: string,
  ) => Promise<void>,
): Promise<void> {
  const client = new Client({ connectionString: testDatabaseUrl });
  const schema = schemaName('fresh_start', label);
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await applyMigrations(client);
    await run(client, schema);
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
}

async function insertSession(
  client: InstanceType<typeof Client>,
  value: TokenSession,
): Promise<void> {
  await client.query(
    `INSERT INTO token_sessions(
       pair_address, token_address, status, payload, created_at, updated_at
     ) VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW())`,
    [
      value.pair.pair.toLowerCase(),
      value.pair.token.toLowerCase(),
      value.status,
      stringifyJson(value),
    ],
  );
}

async function insertDecision(
  client: InstanceType<typeof Client>,
  id: string,
  status: string,
  pair: Address,
  token: Address,
): Promise<void> {
  await client.query(
    `INSERT INTO position_exit_decisions(
       decision_id, idempotency_key, pair_address, token_address,
       settings_revision, primary_rule, triggered_rules, action,
       status, metrics, reason
     ) VALUES ($1, $2, $3, $4, 1, 'STOP_LOSS', '[]'::jsonb, 'SELL',
       $5, '{}'::jsonb, 'test')`,
    [id, `key-${id}`, pair, token, status],
  );
}

async function repository(): Promise<
  typeof import('../../src/runtime/fresh-start.repository.js')
> {
  return import('../../src/runtime/fresh-start.repository.js');
}

test('quarantaine tous les états non terminaux et conserve les terminaux', async () => {
  await withSchema('statuses', async (client, schema) => {
    const statuses: TokenSession['status'][] = [
      'WAITING_FIRST_BUY',
      'RISK_CHECKING',
      'BUY_PENDING',
      'HOLDING',
      'SELL_PENDING',
      'MANUAL_REVIEW',
      'CLOSED',
      'REJECTED',
      'EXPIRED',
    ];
    for (const [index, status] of statuses.entries()) {
      await insertSession(client, session(status, index + 1));
    }

    const { FreshStartRepository } = await repository();
    const result = await new FreshStartRepository(
      scopedDatabase(schema),
    ).apply(
      { number: 100n, hash: HASH, parentHash: PARENT_HASH },
      1_000,
    );

    assert.equal(result.quarantinedSessions, 6);
    const rows = await client.query<{
      status: string;
      payload_status: string;
      reason: string | null;
      recovery_error: string | null;
    }>(`
      SELECT
        status,
        payload->>'status' AS payload_status,
        payload->>'rejectionReason' AS reason,
        recovery_error
      FROM token_sessions
      ORDER BY pair_address
    `);
    assert.equal(
      rows.rows.filter(({ status }) => status === 'MANUAL_REVIEW').length,
      6,
    );
    for (const row of rows.rows.filter(
      ({ status }) => status === 'MANUAL_REVIEW',
    )) {
      assert.equal(row.payload_status, 'MANUAL_REVIEW');
      assert.match(row.reason ?? '', /FRESH_START_CUTOFF/u);
      assert.match(row.recovery_error ?? '', /FRESH_START_CUTOFF/u);
    }
    assert.deepEqual(
      rows.rows.slice(-3).map(({ status, payload_status }) => ({
        status,
        payload_status,
      })),
      [
        { status: 'CLOSED', payload_status: 'CLOSED' },
        { status: 'REJECTED', payload_status: 'REJECTED' },
        { status: 'EXPIRED', payload_status: 'EXPIRED' },
      ],
    );
  });
});

test('préserve bigint, décisions, checkpoints, journal et audit exacts', async () => {
  await withSchema('exact_state', async (client, schema) => {
    const pair = address(201);
    const token = address(202);
    for (const status of ['PENDING', 'EXECUTING', 'EXECUTED', 'FAILED']) {
      await insertDecision(client, status.toLowerCase(), status, pair, token);
    }
    await client.query(
      `INSERT INTO listener_checkpoints(listener_key, block_number, block_hash)
       VALUES
         ('pair-created', 10, $1),
         ('canonical-startup-sync', 11, $1),
         ('swap:old', 12, $1)`,
      [HASH],
    );
    await client.query(
      `INSERT INTO canonical_blocks(
         block_number, block_hash, parent_hash
       ) VALUES (10, $1, $2), (11, $3, $1)`,
      [
        `0x${'1'.repeat(64)}`,
        `0x${'0'.repeat(64)}`,
        `0x${'2'.repeat(64)}`,
      ],
    );
    const cutoff: FreshStartCutoff = {
      number: 9_007_199_254_740_993n,
      hash: HASH,
      parentHash: PARENT_HASH,
    };
    const { FreshStartRepository } = await repository();
    const result = await new FreshStartRepository(
      scopedDatabase(schema),
    ).apply(cutoff, 2_000);

    assert.equal(result.cutoff.number, cutoff.number);
    assert.equal(result.quarantinedDecisions, 2);
    const decisions = await client.query<{ status: string; error_type: string | null }>(
      `SELECT status, error_type
       FROM position_exit_decisions
       ORDER BY decision_id`,
    );
    assert.deepEqual(
      decisions.rows.map(({ status }) => status).sort(),
      ['EXECUTED', 'FAILED', 'MANUAL_REVIEW', 'MANUAL_REVIEW'],
    );
    assert.equal(
      decisions.rows.filter(
        ({ status, error_type }) =>
          status === 'MANUAL_REVIEW'
          && error_type === 'FRESH_START_CUTOFF',
      ).length,
      2,
    );

    const checkpoints = await client.query<{
      listener_key: string;
      block_number: string;
      block_hash: string;
    }>(
      `SELECT listener_key, block_number::text, block_hash
       FROM listener_checkpoints
       ORDER BY listener_key`,
    );
    assert.equal(checkpoints.rows.length, 3);
    assert.ok(checkpoints.rows.every(
      ({ block_number, block_hash }) =>
        block_number === cutoff.number.toString()
        && block_hash === cutoff.hash.toLowerCase(),
    ));
    assert.ok(
      checkpoints.rows.some(
        ({ listener_key }) => listener_key === 'pair-created',
      ),
    );

    const journal = await client.query<{
      block_number: string;
      block_hash: string;
      parent_hash: string;
    }>(
      `SELECT block_number::text, block_hash, parent_hash
       FROM canonical_blocks`,
    );
    assert.deepEqual(journal.rows, [{
      block_number: cutoff.number.toString(),
      block_hash: cutoff.hash.toLowerCase(),
      parent_hash: cutoff.parentHash.toLowerCase(),
    }]);
    const audit = await client.query<{
      cutoff_block_number: string;
      quarantined_sessions: number;
      quarantined_decisions: number;
    }>(
      `SELECT cutoff_block_number::text, quarantined_sessions,
         quarantined_decisions
       FROM fresh_start_runs`,
    );
    assert.deepEqual(audit.rows, [{
      cutoff_block_number: cutoff.number.toString(),
      quarantined_sessions: 0,
      quarantined_decisions: 2,
    }]);
  });
});

test('rollback toutes les tables sur une erreur intermédiaire', async () => {
  await withSchema('rollback', async (client, schema) => {
    await insertSession(client, session('BUY_PENDING', 301));
    await insertDecision(
      client,
      'pending',
      'PENDING',
      address(603),
      address(604),
    );
    await client.query(
      `INSERT INTO listener_checkpoints(listener_key, block_number, block_hash)
       VALUES ('pair-created', 10, $1)`,
      [HASH],
    );
    await client.query(
      `INSERT INTO canonical_blocks(block_number, block_hash, parent_hash)
       VALUES (10, $1, $2)`,
      [HASH, PARENT_HASH],
    );
    const snapshot = async (): Promise<unknown[]> => {
      const sessions = await client.query(
        'SELECT * FROM token_sessions ORDER BY pair_address',
      );
      const decisions = await client.query(
        'SELECT * FROM position_exit_decisions ORDER BY decision_id',
      );
      const checkpoints = await client.query(
        'SELECT * FROM listener_checkpoints ORDER BY listener_key',
      );
      const canonical = await client.query(
        'SELECT * FROM canonical_blocks ORDER BY block_number',
      );
      const runs = await client.query(
        'SELECT * FROM fresh_start_runs ORDER BY run_id',
      );
      return [
        sessions.rows,
        decisions.rows,
        checkpoints.rows,
        canonical.rows,
        runs.rows,
      ];
    };
    const before = await snapshot();
    const { FreshStartRepository } = await repository();

    await assert.rejects(
      new FreshStartRepository(
        scopedDatabase(schema, /UPDATE position_exit_decisions/u),
      ).apply(
        { number: 100n, hash: HASH, parentHash: PARENT_HASH },
        3_000,
      ),
      /injected fresh-start failure/u,
    );
    assert.deepEqual(await snapshot(), before);
  });
});

test('sérialise les lancements et refuse les cutoffs régressifs', async () => {
  await withSchema('concurrency', async (client, schema) => {
    await insertSession(client, session('BUY_PENDING', 401));
    await insertDecision(
      client,
      'pending',
      'PENDING',
      address(803),
      address(804),
    );
    const cutoff = { number: 100n, hash: HASH, parentHash: PARENT_HASH };
    const { FreshStartRepository } = await repository();
    const first = new FreshStartRepository(scopedDatabase(schema));
    const second = new FreshStartRepository(scopedDatabase(schema));
    const concurrent = await Promise.all([
      first.apply(cutoff, 4_000),
      second.apply(cutoff, 4_000),
    ]);

    assert.deepEqual(
      concurrent.map(({ quarantinedSessions }) => quarantinedSessions).sort(),
      [0, 1],
    );
    assert.deepEqual(
      concurrent.map(({ quarantinedDecisions }) => quarantinedDecisions).sort(),
      [0, 1],
    );
    const runs = await client.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM fresh_start_runs',
    );
    assert.equal(runs.rows[0]?.count, '2');

    const newer = {
      number: 101n,
      hash: `0x${'c'.repeat(64)}` as Hash,
      parentHash: HASH,
    };
    await first.apply(newer, 3_000);
    const beforeRejected = await client.query<{
      cutoff_block_number: string;
      cutoff_block_hash: string;
    }>(
      `SELECT cutoff_block_number::text, cutoff_block_hash
       FROM fresh_start_runs
       ORDER BY cutoff_block_number DESC, applied_at DESC, run_id DESC
       LIMIT 1`,
    );
    await assert.rejects(
      second.apply(cutoff, 6_000),
      /antérieur ou divergent/u,
    );
    await assert.rejects(
      second.apply(
        {
          ...newer,
          hash: `0x${'d'.repeat(64)}` as Hash,
        },
        6_000,
      ),
      /antérieur ou divergent/u,
    );
    const afterRejected = await client.query<{
      cutoff_block_number: string;
      cutoff_block_hash: string;
    }>(
      `SELECT cutoff_block_number::text, cutoff_block_hash
       FROM fresh_start_runs
       ORDER BY cutoff_block_number DESC, applied_at DESC, run_id DESC
       LIMIT 1`,
    );
    assert.deepEqual(afterRejected.rows, beforeRejected.rows);
  });
});
