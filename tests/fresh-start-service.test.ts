import assert from 'node:assert/strict';
import test from 'node:test';
import type { Hash } from 'viem';
import { FreshStartService } from '../src/runtime/fresh-start.service.js';

const HASH = `0x${'1'.repeat(64)}` as Hash;
const PARENT_HASH = `0x${'2'.repeat(64)}` as Hash;

test('installe le header confirmé et non le latest RPC', async () => {
  const reads: bigint[] = [];
  const applied: bigint[] = [];
  const service = new FreshStartService(
    {
      getBlockNumber: async () => 105n,
      getBlock: async (number) => {
        reads.push(number);
        return { number, hash: HASH, parentHash: PARENT_HASH };
      },
    },
    {
      apply: async (cutoff) => {
        applied.push(cutoff.number);
        return {
          id: 'run',
          cutoff,
          appliedAtMs: 1,
          quarantinedSessions: 0,
          quarantinedDecisions: 0,
        };
      },
    },
    5,
    () => 1,
  );

  const result = await service.apply();
  assert.deepEqual(reads, [100n]);
  assert.deepEqual(applied, [100n]);
  assert.equal(result.cutoff.hash, HASH);
});

test('une erreur RPC ne provoque aucun appel repository', async () => {
  let applies = 0;
  const service = new FreshStartService(
    {
      getBlockNumber: async () => 105n,
      getBlock: async () => {
        throw new Error('RPC unavailable');
      },
    },
    {
      apply: async () => {
        applies += 1;
        throw new Error('unexpected');
      },
    },
    5,
  );
  await assert.rejects(service.apply(), /RPC unavailable/u);
  assert.equal(applies, 0);
});

test('refuse un numéro, hash ou parent hash RPC incohérent', async () => {
  for (const block of [
    { number: 99n, hash: HASH, parentHash: PARENT_HASH },
    { number: 100n, hash: 'bad', parentHash: PARENT_HASH },
    { number: 100n, hash: HASH, parentHash: 'bad' },
  ]) {
    const service = new FreshStartService(
      {
        getBlockNumber: async () => 105n,
        getBlock: async () => block as never,
      },
      {
        apply: async () => {
          throw new Error('unexpected');
        },
      },
      5,
    );
    await assert.rejects(service.apply(), /header.*invalide/iu);
  }
});
