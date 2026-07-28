# Reorg-Resistant Listeners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Process `PairCreated` and `Swap` logs only after five confirmations, detect recent BSC block-hash divergence, rewind and replay reversible state, and escalate irreversible wallet consequences to `MANUAL_REVIEW`.

**Architecture:** A shared `CanonicalChainCoordinator` serializes listener ingestion, maintains a 128-block canonical header journal, and owns hash-aware checkpoint advancement. Event lifecycle snapshots make swap projections reversible; a dedicated reorg repository performs atomic orphaning/rewind, while the existing runtime recovery barrier prevents concurrent strategy mutations.

**Tech Stack:** TypeScript strict ESM, viem, PostgreSQL, Node test runner, existing recovery barrier and repository patterns.

---

## File Map

- Create `src/chain/confirmed-blocks.ts`: confirmation parsing and safe-head calculation.
- Create `src/chain/canonical-chain.types.ts`: block, checkpoint, chain status, provider, store, and reconciliation contracts.
- Create `src/chain/canonical-chain.repository.ts`: canonical journal, hash-aware checkpoints, reorg audit, and rollback transaction.
- Create `src/chain/canonical-chain.coordinator.ts`: serialized canonical verification, ancestor search, chunk processing, and status.
- Create `src/chain/reorg-session-reconciler.ts`: reversible projection restoration and irreversible-consequence policy.
- Create `migrations/007_chain_reorg_safety.sql`: idempotent schema changes.
- Modify `src/types/domain.ts`: block-hash provenance and canonical audit fields.
- Modify `src/config/env.ts`: `BLOCK_CONFIRMATIONS`.
- Modify `src/storage/repositories.ts`: event snapshots, canonical discoveries, reports/trades provenance, and hash-aware checkpoints.
- Modify `src/strategy/swap-classifier.ts`: require and copy `blockHash`.
- Modify `src/strategy/session-engine.ts`: claim/complete event lifecycle inside the pair lock and attach source-event IDs to consequences.
- Modify `src/execution/trade-executor.ts`: persist triggering event provenance without changing wallet execution semantics.
- Modify `src/listeners/pair-created.listener.ts`: WebSocket wake-up only and confirmed coordinator ranges.
- Modify `src/listeners/swap.listener.ts`: WebSocket wake-up only and confirmed coordinator ranges.
- Modify `src/app.ts`: wire the coordinator, reorg reconciler, recovery barrier, lifecycle, heartbeat, and shutdown.
- Modify `src/heartbeat/heartbeat.ts`, `src/dashboard/dashboard.ts`, and `src/dashboard/dashboard.page.ts`: expose chain confirmation/reorg status.
- Modify `.env.example`, `README.md`, and `docs/strategy.md`: operator documentation.
- Create `tests/confirmed-blocks.test.ts`.
- Create `tests/canonical-chain-coordinator.test.ts`.
- Create `tests/canonical-chain-repository.test.ts`.
- Create `tests/reorg-session-reconciler.test.ts`.
- Create `tests/listener-confirmations.test.ts`.
- Create `tests/postgres/chain-reorg.test.ts`.
- Modify related classifier, engine, heartbeat, dashboard, and repository tests.

### Task 1: Confirmation Configuration and Block Provenance

**Files:**
- Create: `src/chain/confirmed-blocks.ts`
- Modify: `src/config/env.ts`
- Modify: `src/types/domain.ts`
- Modify: `src/strategy/swap-classifier.ts`
- Create: `tests/confirmed-blocks.test.ts`
- Modify: `tests/swap-classifier.test.ts`
- Modify: `tests/setup-env.ts`
- Modify PairInfo/SwapEvent fixtures in:
  `tests/dashboard-action-policy.test.ts`,
  `tests/entry-amount-service.test.ts`,
  `tests/entry-observation.test.ts`,
  `tests/monitor-scheduler.test.ts`,
  `tests/reconciliation-policy.test.ts`,
  `tests/reconciliation-repository.test.ts`,
  `tests/recovery-intent.service.test.ts`,
  `tests/session-monitor-policy.test.ts`,
  `tests/session-reconciler.test.ts`,
  `tests/trade-executor.test.ts`,
  `tests/viem-reconciliation-gateway.test.ts`, and
  `tests/postgres/crash-reconciliation.test.ts`

- [ ] **Step 1: Write failing confirmation and provenance tests**

```ts
test('utilise cinq confirmations par défaut', () => {
  assert.equal(readBlockConfirmations({}), 5);
});

test('refuse zéro et les valeurs non entières', () => {
  assert.throws(
    () => readBlockConfirmations({ BLOCK_CONFIRMATIONS: '0' }),
    /entier entre 1 et 100/u,
  );
  assert.throws(
    () => readBlockConfirmations({ BLOCK_CONFIRMATIONS: '2.5' }),
    /entier entre 1 et 100/u,
  );
});

test('calcule uniquement une tête suffisamment confirmée', () => {
  assert.equal(confirmedHead(20n, 5), 15n);
  assert.equal(confirmedHead(4n, 5), null);
});
```

Extend the classifier test to pass a `blockHash` and assert:

```ts
assert.equal(event.blockHash, BLOCK_HASH);
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/confirmed-blocks.test.ts tests/swap-classifier.test.ts
```

Expected: FAIL because `readBlockConfirmations`, `confirmedHead`, and
`SwapEvent.blockHash` do not exist.

- [ ] **Step 3: Implement strict confirmation parsing**

```ts
export function readBlockConfirmations(
  environment: NodeJS.ProcessEnv,
): number {
  const raw = environment.BLOCK_CONFIRMATIONS?.trim() ?? '5';
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new Error('BLOCK_CONFIRMATIONS doit être un entier entre 1 et 100.');
  }
  return value;
}

export function confirmedHead(
  latestBlock: bigint,
  confirmations: number,
): bigint | null {
  const depth = BigInt(confirmations);
  return latestBlock < depth ? null : latestBlock - depth;
}
```

Add `blockConfirmations: readBlockConfirmations(process.env)` to `config`.
Add `blockHash: Hash` to `PairInfo` and `SwapEvent`, require it in `RawSwap`,
and copy it in `classifySwap`. Add deterministic hashes to every typed
`PairInfo` and `SwapEvent` fixture listed above, then set the default test
environment to `BLOCK_CONFIRMATIONS=5`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Step 2 command.

Expected: PASS.

Also run:

```bash
npm run check
```

Expected: PASS, proving no existing typed fixture lacks block provenance.

- [ ] **Step 5: Commit**

```bash
git add src/chain/confirmed-blocks.ts src/config/env.ts src/types/domain.ts \
  src/strategy/swap-classifier.ts tests/confirmed-blocks.test.ts \
  tests/swap-classifier.test.ts tests/setup-env.ts \
  tests/dashboard-action-policy.test.ts tests/entry-amount-service.test.ts \
  tests/entry-observation.test.ts tests/monitor-scheduler.test.ts \
  tests/reconciliation-policy.test.ts tests/reconciliation-repository.test.ts \
  tests/recovery-intent.service.test.ts tests/session-monitor-policy.test.ts \
  tests/session-reconciler.test.ts tests/trade-executor.test.ts \
  tests/viem-reconciliation-gateway.test.ts \
  tests/postgres/crash-reconciliation.test.ts
git commit -m "feat: configure confirmed block ingestion"
```

### Task 2: Idempotent Reorg Schema and Hash-Aware Repositories

**Files:**
- Create: `migrations/007_chain_reorg_safety.sql`
- Create: `src/chain/canonical-chain.types.ts`
- Create: `src/chain/canonical-chain.repository.ts`
- Modify: `src/storage/repositories.ts`
- Create: `tests/canonical-chain-repository.test.ts`
- Modify: `tests/trade-repository.test.ts`

- [ ] **Step 1: Write failing repository contract tests**

Use injectable recording database clients, following
`tests/reconciliation-repository.test.ts`, and assert:

```ts
const checkpoint = await checkpoints.get('pair-created');
assert.deepEqual(checkpoint, {
  blockNumber: 42n,
  blockHash: BLOCK_42_HASH,
});

await checkpoints.set('pair-created', {
  blockNumber: 43n,
  blockHash: BLOCK_43_HASH,
});
assert.match(lastSql, /block_hash = EXCLUDED\.block_hash/u);

await repository.saveCanonicalBlocks([
  { number: 42n, hash: BLOCK_42_HASH, parentHash: BLOCK_41_HASH },
  { number: 43n, hash: BLOCK_43_HASH, parentHash: BLOCK_42_HASH },
]);
assert.match(lastSql, /canonical_blocks/u);
```

Also assert that swap claim records `block_hash`, `session_before`, and
`canonical`, and that report/trade saves accept a source event.

- [ ] **Step 2: Run the tests and verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/canonical-chain-repository.test.ts tests/trade-repository.test.ts
```

Expected: FAIL because the schema types and repository APIs are absent.

- [ ] **Step 3: Add the idempotent migration**

The migration must use only `CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`, and `ADD COLUMN IF NOT EXISTS`. It creates:

```sql
CREATE TABLE IF NOT EXISTS canonical_blocks (
  block_number NUMERIC(78, 0) PRIMARY KEY,
  block_hash TEXT NOT NULL UNIQUE,
  parent_hash TEXT NOT NULL,
  validated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chain_reorgs (
  id BIGSERIAL PRIMARY KEY,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  common_ancestor_number NUMERIC(78, 0),
  common_ancestor_hash TEXT,
  old_tip_number NUMERIC(78, 0) NOT NULL,
  old_tip_hash TEXT NOT NULL,
  new_tip_number NUMERIC(78, 0) NOT NULL,
  new_tip_hash TEXT NOT NULL,
  depth INTEGER,
  status TEXT NOT NULL,
  orphaned_events INTEGER NOT NULL DEFAULT 0,
  replayed_events INTEGER NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
```

Add hash/canonical/orphan/snapshot columns described by the design to
`listener_checkpoints`, `swap_events`, `discovered_tokens`,
`token_risk_reports`, `trades`, and `token_sessions`. Add source-event indexes.

- [ ] **Step 4: Implement repository types and persistence**

Define:

```ts
export interface CanonicalBlock {
  number: bigint;
  hash: Hash;
  parentHash: Hash;
}

export interface ListenerCheckpoint {
  blockNumber: bigint;
  blockHash: Hash;
}

export type CanonicalChainState =
  | 'HEALTHY'
  | 'RECONCILING'
  | 'MANUAL_REVIEW';
```

Change the existing injected `CheckpointRepository` contract to:

```ts
get(key: string): Promise<ListenerCheckpoint | null>;
set(key: string, checkpoint: ListenerCheckpoint): Promise<void>;
```

Implement these injected-database methods on `CanonicalChainRepository`:

```ts
getCanonicalTip(): Promise<CanonicalBlock | null>;
listCanonicalDescending(limit: number): Promise<CanonicalBlock[]>;
saveCanonicalBlocks(blocks: CanonicalBlock[]): Promise<void>;
pruneCanonicalBefore(blockNumber: bigint): Promise<void>;
getLastReorg(): Promise<ChainReorgAudit | null>;
```

Update event lifecycle methods to:

```ts
claim(event: SwapEvent, sessionBefore: TokenSession): Promise<boolean>;
markProcessed(eventId: string, sessionAfter: TokenSession): Promise<void>;
```

On conflict, an orphaned stable event is reactivated with its replacement
block provenance and `PENDING` status. Normal processed canonical duplicates
remain unclaimed.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/007_chain_reorg_safety.sql \
  src/chain/canonical-chain.types.ts \
  src/chain/canonical-chain.repository.ts src/storage/repositories.ts \
  tests/canonical-chain-repository.test.ts tests/trade-repository.test.ts
git commit -m "feat: persist canonical block provenance"
```

### Task 3: Canonical Head Verification and Confirmed Range Processing

**Files:**
- Create: `src/chain/canonical-chain.coordinator.ts`
- Create: `tests/canonical-chain-coordinator.test.ts`

- [ ] **Step 1: Write failing normal-chain tests**

Build an in-memory store and block reader. Verify:

```ts
test('ne traite que les blocs confirmés et avance numéro plus hash', async () => {
  const processed: Array<[bigint, bigint]> = [];
  const coordinator = fixture({ latest: 20n, confirmations: 5 });

  await coordinator.reconcile({
    listenerKey: 'pair-created',
    startBlock: 10n,
    processChunk: async (fromBlock, toBlock) => {
      processed.push([fromBlock, toBlock]);
      return true;
    },
  });

  assert.deepEqual(processed, [[10n, 15n]]);
  assert.deepEqual(coordinator.store.checkpoint('pair-created'), {
    blockNumber: 15n,
    blockHash: hash(15),
  });
});
```

Add tests for latest block below confirmation depth, continuous parents,
legacy checkpoint hash bootstrap, and two concurrent requests executing
serially.

- [ ] **Step 2: Run the test and verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/canonical-chain-coordinator.test.ts
```

Expected: FAIL because `CanonicalChainCoordinator` is absent.

- [ ] **Step 3: Implement the coordinator's normal path**

Use these contracts:

```ts
export interface CanonicalBlockReader {
  getBlockNumber(): Promise<bigint>;
  getBlock(blockNumber: bigint): Promise<CanonicalBlock>;
}

export interface ConfirmedRangeRequest {
  listenerKey: string;
  startBlock: bigint;
  processChunk(
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<boolean>;
}
```

The coordinator uses a promise tail to serialize all requests:

```ts
private tail: Promise<void> = Promise.resolve();

reconcile(request: ConfirmedRangeRequest): Promise<void> {
  const current = this.tail
    .catch(() => undefined)
    .then(() => this.execute(request));
  this.tail = current.catch(() => undefined);
  return current;
}
```

`execute` calculates the confirmed head, verifies/extends the retained header
chain, processes 1,500-block chunks, and saves the final block number/hash only
after `processChunk` returns `true`. A false result stops without skipping an
unprocessed remainder.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chain/canonical-chain.coordinator.ts \
  tests/canonical-chain-coordinator.test.ts
git commit -m "feat: coordinate confirmed block ranges"
```

### Task 4: Divergence Detection, Common Ancestor, and RPC Failure Safety

**Files:**
- Modify: `src/chain/canonical-chain.coordinator.ts`
- Modify: `src/chain/canonical-chain.types.ts`
- Modify: `tests/canonical-chain-coordinator.test.ts`

- [ ] **Step 1: Add failing reorg tests**

Cover:

```ts
test('ignore un reorg situé uniquement dans les blocs non confirmés', async () => {
  // Stored confirmed tip remains equal; mutate blocks 16..20 only.
  await coordinator.reconcile(request);
  assert.equal(reorgHandler.calls.length, 0);
});

test('retrouve le dernier ancêtre commun dans la fenêtre', async () => {
  // Stored 100..110; replacement chain shares block 106.
  await coordinator.reconcile(request);
  assert.equal(reorgHandler.calls[0]?.ancestor.number, 106n);
});

test('ne modifie rien si la vérification de hash échoue', async () => {
  reader.failAt = 108n;
  await assert.rejects(coordinator.reconcile(request), /RPC/u);
  assert.deepEqual(store.snapshot(), before);
});

test('bloque les décisions lorsque l’ancêtre sort des 128 blocs', async () => {
  await assert.rejects(coordinator.reconcile(request), DeepReorgError);
  assert.equal(coordinator.currentStatus.state, 'MANUAL_REVIEW');
});
```

- [ ] **Step 2: Run and verify RED**

Run the Task 3 test command.

Expected: FAIL on missing divergence handling.

- [ ] **Step 3: Implement ancestor search and status**

Before journal mutation, fetch all headers needed for validation. Compare the
stored canonical tip with the RPC block at the same height. On mismatch, walk
the retained rows newest-to-oldest until hashes match, then call:

```ts
export interface CanonicalReorgHandler {
  reconcileReorg(input: {
    ancestor: CanonicalBlock;
    oldTip: CanonicalBlock;
    newTip: CanonicalBlock;
  }): Promise<ReorgImpact>;
}
```

Do not catch RPC errors as reorgs. Only a successful unequal-hash response
proves divergence. Set status to `RECONCILING` during the handler, `HEALTHY`
after successful replay preparation, and `MANUAL_REVIEW` for a deep reorg.

- [ ] **Step 4: Run and verify GREEN**

Run the Task 3 test command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chain/canonical-chain.coordinator.ts \
  src/chain/canonical-chain.types.ts \
  tests/canonical-chain-coordinator.test.ts
git commit -m "feat: detect canonical chain divergence"
```

### Task 5: Atomic Rollback and Reorg Audit

**Files:**
- Modify: `src/chain/canonical-chain.repository.ts`
- Modify: `tests/canonical-chain-repository.test.ts`

- [ ] **Step 1: Write failing transaction tests**

Assert the rollback transaction executes:

```ts
[
  'BEGIN',
  'INSERT INTO chain_reorgs',
  'UPDATE discovered_tokens',
  'UPDATE swap_events',
  'UPDATE token_risk_reports',
  'UPDATE trades',
  'UPDATE listener_checkpoints',
  'DELETE FROM canonical_blocks',
  'COMMIT',
]
```

Verify a failure produces `ROLLBACK`, no `COMMIT`, and no externally visible
checkpoint update. Verify the returned impact contains orphan IDs, affected
pairs, earliest `session_before`, and whether wallet transaction rows exist.

- [ ] **Step 2: Run and verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/canonical-chain-repository.test.ts
```

Expected: FAIL because `rewindToAncestor` is missing.

- [ ] **Step 3: Implement one atomic rewind**

Implement:

```ts
rewindToAncestor(input: {
  ancestor: CanonicalBlock;
  oldTip: CanonicalBlock;
  newTip: CanonicalBlock;
}): Promise<ReorgImpact>;
```

Within one transaction:

- create the `RECONCILING` audit;
- mark discoveries/events above the ancestor non-canonical;
- supersede reports and non-wallet consequences by `source_event_id`;
- collect any `trade_transactions` tied to orphan source events;
- rewind checkpoints above the ancestor;
- delete old canonical headers above the ancestor;
- return deterministic affected-pair records.

Add `completeReorg(id, result)` and `requireManualReview(id, reason)`.

- [ ] **Step 4: Run and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chain/canonical-chain.repository.ts \
  tests/canonical-chain-repository.test.ts
git commit -m "feat: rewind reorg state atomically"
```

### Task 6: Swap Event Lifecycle Inside the Session Lock

**Files:**
- Modify: `src/strategy/session-engine.ts`
- Modify: `src/execution/trade-executor.ts`
- Modify: `src/types/domain.ts`
- Modify: `tests/session-monitor-policy.test.ts`
- Modify: `tests/trade-executor.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

Add an event lifecycle fake and verify:

```ts
test('capture les snapshots avant et après sous le verrou de paire', async () => {
  await engine.onSwap(detachedSession, buyEvent);
  assert.equal(events.claimed[0]?.before.status, 'WAITING_FIRST_BUY');
  assert.equal(events.processed[0]?.after.entryObservationBuys?.length, 1);
});

test('ne rejoue pas un doublon canonique non réclamé', async () => {
  events.claimResult = false;
  await engine.onSwap(detachedSession, buyEvent);
  assert.equal(risk.calls, 0);
});

test('attache l’événement source au report et au trade', async () => {
  await engine.onSwap(detachedSession, buyEvent);
  assert.equal(reports.saved[0]?.sourceEventId, buyEvent.id);
  assert.equal(trades.saved[0]?.sourceEventId, buyEvent.id);
});
```

Also verify `markFailed` happens under an engine error and no snapshot is
marked processed.

- [ ] **Step 2: Run and verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/session-monitor-policy.test.ts tests/trade-executor.test.ts
```

Expected: FAIL because lifecycle is still owned by `SwapListener`.

- [ ] **Step 3: Move lifecycle ownership into `SessionEngine`**

Add:

```ts
export interface SwapEventLifecycle {
  claim(event: SwapEvent, before: TokenSession): Promise<boolean>;
  markProcessed(eventId: string, after: TokenSession): Promise<void>;
  markFailed(eventId: string, reason: string): Promise<void>;
}
```

Inside `withLock`, reload the persisted session, claim with a structured clone,
run `handle`, then store the after snapshot. On failure, mark the event failed
and rethrow. Keep a no-op lifecycle default for isolated policy tests, but wire
the PostgreSQL lifecycle in `app.ts`.

Pass `event.id` to risk report persistence and to `TradeExecutor.buy/sell`.
Add optional `sourceEventId` to `TradeRecord`; recovery/manual execution keeps
the previously persisted source or leaves it undefined.

- [ ] **Step 4: Run and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/strategy/session-engine.ts src/execution/trade-executor.ts \
  src/types/domain.ts tests/session-monitor-policy.test.ts \
  tests/trade-executor.test.ts
git commit -m "feat: snapshot canonical swap transitions"
```

### Task 7: Session Projection Reconciliation

**Files:**
- Create: `src/chain/reorg-session-reconciler.ts`
- Create: `tests/reorg-session-reconciler.test.ts`

- [ ] **Step 1: Write the four failing policy tests**

Create four isolated fixtures:

- an orphaned pair discovery with no trade rows must save a non-canonical
  `REJECTED` session and emit its pair in `monitorsToStop`;
- an orphaned first-buy event with `session_before.status` equal to
  `WAITING_FIRST_BUY` must restore that snapshot and remove the obsolete
  `riskReportId` and entry observation;
- an orphaned post-entry buy must rebuild
  `countedBuyTransactionHashes` and `subsequentBuyCount` exclusively from the
  canonical events returned by the store;
- an affected pair with one `trade_transactions` row must retain the trade and
  transaction unchanged while saving the session as `MANUAL_REVIEW`.

The irreversible test must assert that the trade/transaction store receives no
delete or status rewrite and that:

```ts
assert.equal(savedSession.status, 'MANUAL_REVIEW');
assert.match(savedSession.rejectionReason ?? '', /réorganisation/u);
```

- [ ] **Step 2: Run and verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/reorg-session-reconciler.test.ts
```

Expected: FAIL because `ReorgSessionReconciler` is absent.

- [ ] **Step 3: Implement the explicit disappearing-event policy**

For each deterministic affected-pair record:

- if pair discovery vanished and no wallet consequence exists, set
  `canonical = false`, `status = REJECTED`, and stop monitor eligibility;
- if wallet consequence exists, preserve accounting and set `MANUAL_REVIEW`;
- otherwise restore the earliest orphan event's `session_before`, remove
  orphan hashes from observation arrays, and recompute counters from canonical
  processed events;
- retain dry-run audit rows with `canonical = false`;
- save the reconciled session through a repository method allowed while the
  runtime recovery barrier owns the mutation.

- [ ] **Step 4: Run and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chain/reorg-session-reconciler.ts \
  tests/reorg-session-reconciler.test.ts
git commit -m "feat: reconcile orphaned session projections"
```

### Task 8: Convert Both Listeners to Confirmed HTTP Ingestion

**Files:**
- Modify: `src/listeners/pair-created.listener.ts`
- Modify: `src/listeners/swap.listener.ts`
- Create: `tests/listener-confirmations.test.ts`
- Modify: `tests/pancake-factory-abi.test.ts`

- [ ] **Step 1: Write failing listener tests**

Inject watcher and log-reader dependencies. Verify:

```ts
test('PairCreated WebSocket réveille sans traiter le log reçu', async () => {
  watcher.emit([unconfirmedPairLog]);
  await flushPromises();
  assert.equal(onPairCalls.length, 0);
  assert.equal(coordinator.requests.length, 1);
});

test('Swap WebSocket réveille sans entrer sur le log reçu', async () => {
  watcher.emit([unconfirmedBuyLog]);
  await flushPromises();
  assert.equal(engine.calls.length, 0);
});

test('les logs HTTP confirmés exigent un blockHash', async () => {
  await assert.rejects(runConfirmedLogWithoutHash(), /block hash/u);
});
```

Also verify ordered confirmed logs carry `PairInfo.blockHash` and
`SwapEvent.blockHash`, and an RPC failure causes no checkpoint request to
complete.

- [ ] **Step 2: Run and verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/listener-confirmations.test.ts tests/pancake-factory-abi.test.ts
```

Expected: FAIL because WebSocket logs still call `processLogs`.

- [ ] **Step 3: Refactor listener dependencies and reconciliation**

Both `onLogs` callbacks call a coalesced `requestReconcile()` and ignore the
payload. `reconcile()` delegates range ownership to:

```ts
await coordinator.reconcile({
  listenerKey,
  startBlock,
  processChunk: async (fromBlock, toBlock) => {
    const logs = await logReader.getLogs({ fromBlock, toBlock });
    return processConfirmedLogs(logs);
  },
});
```

Remove direct checkpoint writes from both listeners. Remove event claim/mark
calls from `SwapListener`; `SessionEngine` now owns them under its pair lock.
Preserve `stopAndDrain`, terminal handling, and sanitized RPC errors.

- [ ] **Step 4: Run and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/listeners/pair-created.listener.ts \
  src/listeners/swap.listener.ts tests/listener-confirmations.test.ts \
  tests/pancake-factory-abi.test.ts
git commit -m "feat: ingest only confirmed listener logs"
```

### Task 9: Wire Reorg Recovery Without Listener Deadlocks

**Files:**
- Modify: `src/app.ts`
- Modify: `src/chain/canonical-chain.coordinator.ts`
- Modify: `tests/canonical-chain-coordinator.test.ts`
- Modify: `tests/runtime-recovery-barrier.test.ts`

- [ ] **Step 1: Write failing barrier and restart tests**

Implement four deterministic deferred-promise tests:

- hold a `runtimeRecoveryBarrier.runListener` operation open, request a
  divergence, and assert the rollback spy remains untouched until the listener
  deferred is resolved;
- hold the rollback deferred open, request a second listener reconciliation,
  and assert its `processChunk` spy remains untouched until rollback completes;
- construct a fresh coordinator over a persisted checkpoint whose RPC hash has
  changed and assert the restart calls the reorg handler with the stored common
  ancestor;
- hold `processChunk` open, call `waitForIdle`, and assert shutdown remains
  pending until the chunk deferred resolves.

The deadlock regression must queue a listener operation on
`RuntimeRecoveryBarrier`, trigger reorg, and prove that listener draining is
performed only after the recovery section releases the barrier.

- [ ] **Step 2: Run and verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/canonical-chain-coordinator.test.ts \
  tests/runtime-recovery-barrier.test.ts
```

Expected: FAIL because application-level reorg coordination is not wired.

- [ ] **Step 3: Wire the application**

Construct one repository/coordinator and inject it into every listener. The
reorg handler executes database rewind and session reconciliation through:

```ts
await runtimeRecoveryBarrier.runRecovery(async () => {
  const impact = await chainRepository.rewindToAncestor(input);
  await reorgSessions.reconcile(impact);
});
```

Inside the barrier, stop obsolete monitors without awaiting their drain and
retain their capacity reservation. After the barrier releases, drain/remove
them, run monitor scheduling, and only then permit confirmed replay. Reuse the
issue #10 pending-drain pattern rather than introducing another lifecycle.

During startup, synchronize the canonical journal after crash reconciliation
and before enabling `PairCreated` or swap listeners. During shutdown, disable
new requests, await `canonicalCoordinator.waitForIdle()`, then drain listeners
and close PostgreSQL.

- [ ] **Step 4: Run and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app.ts src/chain/canonical-chain.coordinator.ts \
  tests/canonical-chain-coordinator.test.ts \
  tests/runtime-recovery-barrier.test.ts
git commit -m "feat: coordinate reorg recovery at runtime"
```

### Task 10: Heartbeat, Dashboard, and Operator Documentation

**Files:**
- Modify: `src/heartbeat/heartbeat.ts`
- Modify: `tests/heartbeat-service.test.ts`
- Modify: `src/dashboard/dashboard.ts`
- Modify: `src/dashboard/dashboard.page.ts`
- Modify: `tests/dashboard-page.test.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/strategy.md`

- [ ] **Step 1: Write failing observability tests**

Assert the heartbeat contains:

```ts
assert.deepEqual(snapshot.chain, {
  confirmations: 5,
  confirmedHead: '115',
  canonicalBlockNumber: '115',
  canonicalBlockHash: BLOCK_115_HASH,
  state: 'HEALTHY',
  lastReorg: null,
});
```

Add a reorg fixture asserting depth, ancestor, time, orphan count, replay
count, and `MANUAL_REVIEW`. Assert dashboard HTML and JavaScript render all
chain fields.

- [ ] **Step 2: Run and verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/heartbeat-service.test.ts tests/dashboard-page.test.ts
```

Expected: FAIL because chain status is absent.

- [ ] **Step 3: Implement heartbeat/dashboard fields**

Inject a read-only chain status provider into `HeartbeatService`, retain the
last known confirmed/canonical values on RPC failure, and add a dashboard card
showing confirmation depth and reorg state. Never label a stale value as newly
validated.

Document:

```dotenv
# Business events wait for this many additional blocks.
BLOCK_CONFIRMATIONS=5
```

Explain WebSocket wake-up semantics, five-block latency, automatic recent
rollback, 128-block retained window, deep-reorg pause, and wallet
`MANUAL_REVIEW`.

- [ ] **Step 4: Run and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/heartbeat/heartbeat.ts tests/heartbeat-service.test.ts \
  src/dashboard/dashboard.ts src/dashboard/dashboard.page.ts \
  tests/dashboard-page.test.ts .env.example README.md docs/strategy.md
git commit -m "feat: expose canonical chain health"
```

### Task 11: PostgreSQL Reorg Scenarios and Full Verification

**Files:**
- Create: `tests/postgres/chain-reorg.test.ts`
- Modify: `.github/workflows/ci.yml` only if PostgreSQL is already provisioned there

- [ ] **Step 1: Write the PostgreSQL scenarios**

Following `tests/postgres/crash-reconciliation.test.ts`, create isolated
addresses and rows for:

1. normal chain and hash-aware checkpoint;
2. reorg inside the retained window;
3. divergence detected after repository restart;
4. disappearing `PairCreated`;
5. disappearing first buy;
6. disappearing counted buy;
7. confirmed wallet transaction preserved with `MANUAL_REVIEW`;
8. rollback SQL failure leaving rows unchanged;
9. applying migration `007` twice without error.

Each test must assert both current state and retained audit rows.

- [ ] **Step 2: Run PostgreSQL tests**

```bash
npm run test:postgres
```

Expected: PASS when the opt-in PostgreSQL test database is available. If it is
not available, record the exact connection failure in the PR and do not claim
integration verification.

- [ ] **Step 3: Run local review**

```bash
git diff main...HEAD --check
git diff main...HEAD --stat
git status --short
```

Review specifically for:

- any WebSocket payload reaching business processing;
- checkpoint writes before full success;
- RPC exceptions converted into reorg decisions;
- any deletion or rewrite of confirmed wallet transactions;
- missing block hash provenance;
- listener capacity release before drain;
- unrelated live-mode or secret-handling changes.

- [ ] **Step 4: Run mandatory full validation**

```bash
npm run check
npm test
npm run build
```

Expected: all commands exit zero with no failed tests.

- [ ] **Step 5: Commit final integration fixes**

```bash
git add tests/postgres/chain-reorg.test.ts .github/workflows/ci.yml
git commit -m "test: cover canonical chain reorg recovery"
```

Skip `.github/workflows/ci.yml` from the command if the existing workflow does
not provide PostgreSQL and no workflow change is made.

## Completion Checklist

- [ ] `BLOCK_CONFIRMATIONS=5` is strict and documented.
- [ ] WebSockets only wake confirmed HTTP reconciliation.
- [ ] Both listener checkpoints persist number and hash.
- [ ] Normal and replacement chains verify parent/hash continuity.
- [ ] RPC errors leave checkpoints and canonical state unchanged.
- [ ] Recent reorgs rewind to a common ancestor and replay without duplicates.
- [ ] Pair, first-buy, counted-buy, and sell-signal disappearance are tested.
- [ ] Confirmed wallet consequences remain immutable and force manual review.
- [ ] Deep reorgs pause ingestion visibly.
- [ ] Heartbeat/dashboard expose confirmation and last-reorg state.
- [ ] Migration `007` is idempotent.
- [ ] `npm run check`, `npm test`, and `npm run build` pass.
