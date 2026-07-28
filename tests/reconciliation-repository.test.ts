import assert from 'node:assert/strict';
import test from 'node:test';
import type { Address, Hash } from 'viem';
import { ReconciliationRepository } from '../src/recovery/reconciliation.repository.js';
import type { TokenSession } from '../src/types/domain.js';
import { stringifyJson } from '../src/utils/json.js';

function session(): TokenSession {
  return {
    pair: {
      factory: `0x${'1'.repeat(40)}` as Address,
      router: `0x${'2'.repeat(40)}` as Address,
      wbnb: `0x${'3'.repeat(40)}` as Address,
      pair: `0x${'4'.repeat(40)}` as Address,
      token: `0x${'5'.repeat(40)}` as Address,
      token0: `0x${'5'.repeat(40)}` as Address,
      token1: `0x${'3'.repeat(40)}` as Address,
      createdBlock: 1n,
      createdTransactionHash: `0x${'6'.repeat(64)}` as Hash,
      createdLogIndex: 0,
      discoveredAtMs: 1,
    },
    metadata: {
      address: `0x${'5'.repeat(40)}` as Address,
      name: 'Token',
      symbol: 'TKN',
      decimals: 18,
      totalSupply: 1_000n,
      codeSizeBytes: 1,
    },
    status: 'BUY_PENDING',
    subsequentBuyCount: 0,
    targetBuysAfterEntry: 3,
    countedBuyTransactionHashes: [],
    sellAttempts: 0,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

class RecordingClient {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  guardedUpdateRows = 1;

  async query<T>(sql: string, values?: unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ sql, ...(values ? { values } : {}) });
    if (sql.includes('UPDATE token_sessions s')) {
      return {
        rows: [{
          payload: JSON.parse(stringifyJson(session())),
          status: 'BUY_PENDING',
        } as T],
      };
    }
    if (sql.includes('FROM trades')) return { rows: [] };
    if (sql.includes('UPDATE token_sessions') && sql.includes('recovery_owner = $2')) {
      return {
        rows: this.guardedUpdateRows === 1
          ? [{ pair_address: session().pair.pair.toLowerCase() } as T]
          : [],
      };
    }
    return { rows: [] };
  }

  release(): void {}
}

test('réclame une session avec SKIP LOCKED et charge son snapshot', async () => {
  const client = new RecordingClient();
  const repository = new ReconciliationRepository({
    connect: async () => client,
  });

  const claimed = await repository.claimNext('worker-1', 30_000);

  assert.equal(claimed?.owner, 'worker-1');
  assert.equal(claimed?.snapshot.session.status, 'BUY_PENDING');
  assert.ok(client.calls.some((call) => /FOR UPDATE SKIP LOCKED/u.test(call.sql)));
  assert.ok(client.calls.some((call) => /recovery_lease_until/u.test(call.sql)));
  assert.ok(client.calls.some((call) =>
    /status = 'MANUAL_REVIEW'/u.test(call.sql)
    && /unreconciledExecution/u.test(call.sql)));
});

test('applique la décision sous bail et écrit un audit idempotent', async () => {
  const client = new RecordingClient();
  const repository = new ReconciliationRepository({
    connect: async () => client,
  });
  const claimed = await repository.claimNext('worker-1', 30_000);
  assert.ok(claimed);
  const updated = structuredClone(claimed.snapshot.session);
  updated.status = 'MANUAL_REVIEW';

  await repository.applyDecision(claimed, {
    idempotencyKey: 'pair:buy:manual',
    session: updated,
    action: 'MANUAL_REVIEW',
    reason: 'Hash absent du RPC.',
  });

  assert.ok(client.calls.some((call) =>
    /recovery_owner = \$2/u.test(call.sql)
    && /status = \$6/u.test(call.sql)));
  assert.ok(client.calls.some((call) =>
    /INSERT INTO reconciliation_decisions/u.test(call.sql)
    && /ON CONFLICT \(idempotency_key\) DO NOTHING/u.test(call.sql)));
});
