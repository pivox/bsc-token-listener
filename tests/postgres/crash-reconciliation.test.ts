import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import pg from 'pg';
import type { Address, Hash } from 'viem';
import type { ClaimedRecovery } from '../../src/recovery/recovery.types.js';
import type { TokenSession } from '../../src/types/domain.js';
import { stringifyJson } from '../../src/utils/json.js';

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

function session(status: TokenSession['status']): TokenSession {
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
    status,
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function scopedDatabase(schema: string): {
  connect: () => Promise<{
    query: <T = Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ) => Promise<{ rows: T[] }>;
    release: () => void;
  }>;
} {
  return {
    connect: async () => {
      const client = new Client({ connectionString: testDatabaseUrl });
      await client.connect();
      await client.query(`SET search_path TO ${schema}`);
      return {
        query: async <T = Record<string, unknown>>(
          sql: string,
          values?: unknown[],
        ): Promise<{ rows: T[] }> => {
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

test('les claims concurrents et l’application sous bail restent atomiques', async () => {
  const client = new Client({ connectionString: testDatabaseUrl });
  const schema = `crash_claim_${randomUUID().replaceAll('-', '')}`;
  await client.connect();

  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    for (const migrationFile of [
      'migrations/001_init.sql',
      'migrations/005_trade_lifecycle.sql',
      'migrations/006_crash_reconciliation.sql',
    ]) {
      await client.query(await readFile(migrationFile, 'utf8'));
    }
    const initial = session('MANUAL_REVIEW');
    initial.entry = {
      mode: 'live',
      amountInWei: 100n,
      amountOutToken: 200n,
      confirmedAtMs: 1,
      cursor: { blockNumber: 1n, transactionIndex: 0, logIndex: 0 },
    };
    initial.unreconciledExecution = {
      tradeId: 'trade-sell',
      step: 'APPROVE',
      outcome: 'CONFIRMED',
      transactionHash: HASH,
      recordedAtMs: 1,
    };
    await client.query(
      `INSERT INTO token_sessions(
         pair_address, token_address, status, payload, created_at, updated_at
       ) VALUES ($1, $2, $3, $4::jsonb, NOW(), NOW())`,
      [PAIR.toLowerCase(), TOKEN.toLowerCase(), initial.status, stringifyJson(initial)],
    );

    const { ReconciliationRepository } =
      await import('../../src/recovery/reconciliation.repository.js');
    const firstRepository = new ReconciliationRepository(scopedDatabase(schema));
    const secondRepository = new ReconciliationRepository(scopedDatabase(schema));
    const claims = await Promise.all([
      firstRepository.claimNext('worker-1', 60_000),
      secondRepository.claimNext('worker-2', 60_000),
    ]);
    const claimed = claims.find(
      (candidate): candidate is ClaimedRecovery => candidate !== null,
    );
    assert.ok(claimed);
    assert.equal(claims.filter((candidate) => candidate !== null).length, 1);

    const { SessionRepository } = await import('../../src/storage/repositories.js');
    const sessions = new SessionRepository({
      query: async <T = Record<string, unknown>>(
        sql: string,
        values?: unknown[],
      ): Promise<{ rows: T[] }> => {
        const result = await client.query(sql, values);
        return { rows: result.rows as T[] };
      },
    });
    await assert.rejects(
      sessions.save(structuredClone(claimed.snapshot.session)),
      /réconciliation active/u,
    );

    const approvalRecorded = structuredClone(claimed.snapshot.session);
    approvalRecorded.status = 'SELL_PENDING';
    delete approvalRecorded.unreconciledExecution;
    await firstRepository.applyDecision(claimed, {
      idempotencyKey: 'approval-retained',
      session: approvalRecorded,
      action: 'APPROVAL_CONFIRMED',
      reason: 'Approval confirmé.',
      retainLease: true,
    });
    const retained = await client.query<{
      recovery_owner: string | null;
      status: string;
    }>(
      'SELECT recovery_owner, status FROM token_sessions WHERE pair_address = $1',
      [PAIR.toLowerCase()],
    );
    assert.equal(retained.rows[0]?.recovery_owner, claimed.owner);
    assert.equal(retained.rows[0]?.status, 'SELL_PENDING');
    assert.equal(claimed.statusBefore, 'SELL_PENDING');

    const completed = structuredClone(approvalRecorded);
    completed.status = 'CLOSED';
    await firstRepository.applyDecision(claimed, {
      idempotencyKey: 'sell-completed',
      session: completed,
      action: 'RESUME_INTENT',
      reason: 'Vente reprise.',
    });
    const final = await client.query<{
      recovery_owner: string | null;
      status: string;
      decisions: string;
    }>(
      `SELECT
         s.recovery_owner,
         s.status,
         COUNT(d.decision_id)::text AS decisions
       FROM token_sessions s
       LEFT JOIN reconciliation_decisions d
         ON d.pair_address = s.pair_address
       WHERE s.pair_address = $1
       GROUP BY s.recovery_owner, s.status`,
      [PAIR.toLowerCase()],
    );
    assert.equal(final.rows[0]?.recovery_owner, null);
    assert.equal(final.rows[0]?.status, 'CLOSED');
    assert.equal(final.rows[0]?.decisions, '2');
    assert.equal(await secondRepository.claimNext('worker-3', 60_000), null);

    const manualWithReference = session('MANUAL_REVIEW');
    manualWithReference.pair.pair = `0x${'4'.repeat(40)}` as Address;
    manualWithReference.unreconciledExecution = {
      tradeId: 'trade-manual',
      step: 'BUY',
      outcome: 'CONFIRMED',
      transactionHash: HASH,
      recordedAtMs: 4,
    };
    const manualWithoutReference = session('MANUAL_REVIEW');
    manualWithoutReference.pair.pair = `0x${'5'.repeat(40)}` as Address;
    await client.query(
      `INSERT INTO token_sessions(
         pair_address, token_address, status, payload, created_at, updated_at
       ) VALUES
         ($1, $2, $3, $4::jsonb, NOW(), NOW()),
         ($5, $6, $7, $8::jsonb, NOW(), NOW())`,
      [
        manualWithReference.pair.pair.toLowerCase(),
        TOKEN.toLowerCase(),
        manualWithReference.status,
        stringifyJson(manualWithReference),
        manualWithoutReference.pair.pair.toLowerCase(),
        TOKEN.toLowerCase(),
        manualWithoutReference.status,
        stringifyJson(manualWithoutReference),
      ],
    );
    const manualClaim = await secondRepository.claimNext('worker-4', 60_000);
    assert.equal(
      manualClaim?.snapshot.session.pair.pair.toLowerCase(),
      manualWithReference.pair.pair.toLowerCase(),
    );
    assert.equal(await secondRepository.claimNext('worker-5', 60_000), null);
  } finally {
    await client.query('SET search_path TO public');
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
