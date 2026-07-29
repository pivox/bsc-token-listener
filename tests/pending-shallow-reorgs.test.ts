import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingShallowReorgQueue } from '../src/runtime/pending-shallow-reorgs.js';

const first = {
  identity: 'old:new',
  impact: {
    reorgId: 'reorg:old:new',
    depth: 1,
    orphanedEvents: 1,
    replayedEvents: 0,
    orphanedEventIds: ['event-1'],
    affectedPairs: [],
  },
} as const;

test('conserve la tête FIFO si la finalisation RPC échoue puis retire la même identité après succès', async () => {
  const queue = new PendingShallowReorgQueue();
  queue.enqueue(first);

  await assert.rejects(
    queue.finalizeHead(async () => { throw new Error('complete RPC failed'); }),
    /complete RPC failed/u,
  );
  assert.equal(queue.peek(), first);

  const result = await queue.finalizeHead(async (pending) => {
    assert.equal(pending, first);
    return 'completed';
  });

  assert.equal(result, 'completed');
  assert.equal(queue.peek(), undefined);
});
