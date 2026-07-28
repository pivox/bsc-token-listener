# Reorg-Resistant Listeners Design

## Goal

Make `PairCreated` and `Swap` ingestion resilient to recent BSC block
reorganizations. Business decisions must consume only sufficiently confirmed
logs, checkpoints must identify a canonical block by number and hash, recent
divergences must be rolled back and replayed idempotently, and irreversible
wallet consequences must be escalated instead of being silently rewritten.

This design implements issue #11. It does not add mempool processing, RPC high
availability, automatic live activation, or automatic reversal of wallet
transactions.

## Safety Invariants

- `EXECUTION_MODE=dry-run` remains the default.
- `BLOCK_CONFIRMATIONS` defaults to `5` and is validated as an integer from
  `1` through `100`.
- WebSocket logs are wake-up hints only. They never enter the strategy engine
  directly.
- Business logs are read over HTTP only through
  `latestBlock - BLOCK_CONFIRMATIONS`.
- A checkpoint is advanced only after the complete block range has been read,
  its header continuity has been verified, and all its logs have been
  processed successfully.
- Every persisted log keeps its transaction hash, log index, block number, and
  block hash. Its stable identity remains transaction hash plus log index.
- An RPC error during head lookup, header verification, log loading, ancestor
  discovery, rollback, or replay leaves all affected checkpoints unchanged.
- A confirmed wallet transaction is never deleted, reverted, or automatically
  compensated because a source event became orphaned.
- Any orphaned event whose consequence cannot be safely reconstructed moves the
  affected session to `MANUAL_REVIEW`.

## Selected Architecture

Use one shared canonical-chain coordinator for every listener.

`CanonicalChainCoordinator` owns a serialized reconciliation gate. It reads the
latest HTTP block, derives the confirmed head, verifies stored hashes, extends
the canonical block journal, detects divergence, coordinates rollback, and
only then allows a listener to process its confirmed range. `PairCreatedListener`
and each `SwapListener` remain responsible for decoding their own logs, but no
longer decide independently which chain is canonical.

The alternatives were rejected:

- Per-listener block windows duplicate reorg logic and can let discovery and
  swap listeners disagree about the current chain.
- Blindly rereading a recent range on every pass is simpler but creates
  unnecessary database churn and does not explicitly classify irreversible
  consequences.

The existing runtime recovery barrier continues to protect session recovery.
Canonical-chain reconciliation adds a separate in-process serialization gate
for listener ingestion. Multi-instance provider and ingestion coordination
remains part of the later high-availability roadmap; persisted hashes make a
restart safe for the current single-ingestion-owner architecture.

## Configuration

Add:

```dotenv
BLOCK_CONFIRMATIONS=5
```

`BLOCK_CONFIRMATIONS` uses the existing strict integer parser with a minimum of
`1` and maximum of `100`. A value of zero is forbidden because it would permit
unconfirmed business decisions.

The retained canonical window is a fixed implementation safety constant of
`128` blocks. It is deliberately not another operator setting in this issue:
all deployments need the same minimum rollback capability, and exposing it
would make unsafe under-sizing possible. At normal operation the coordinator
prunes canonical headers older than the latest 128 confirmed blocks only after
all listener checkpoints have advanced beyond them.

The latency trade-off is explicit: a log becomes actionable after five
additional BSC blocks. Raising the value increases reorg protection and entry
latency; lowering it is allowed down to one but makes recent confirmed
decisions more exposed to a reorg.

## Persistence Model

Add an idempotent migration `007_chain_reorg_safety.sql`.

### Canonical block journal

```sql
CREATE TABLE IF NOT EXISTS canonical_blocks (
  block_number NUMERIC(78, 0) PRIMARY KEY,
  block_hash TEXT NOT NULL UNIQUE,
  parent_hash TEXT NOT NULL,
  validated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

The journal stores only sufficiently confirmed headers. Adjacent stored rows
must satisfy `child.parent_hash = parent.block_hash`.

### Hash-aware checkpoints

Extend `listener_checkpoints` with nullable `block_hash TEXT`. New writes always
set both fields. A legacy row with no hash is bootstrapped by reading its block
header, recording the current canonical hash, and building the retained header
window before any new logs are processed. This migration cannot prove whether
a pre-upgrade checkpoint once belonged to another fork; that one-time
limitation is documented.

The repository API becomes:

```ts
interface ListenerCheckpoint {
  blockNumber: bigint;
  blockHash: Hash;
}

get(key: string): Promise<ListenerCheckpoint | null>;
set(key: string, checkpoint: ListenerCheckpoint): Promise<void>;
rewindAfter(blockNumber: bigint): Promise<void>;
```

Checkpoint changes and canonical journal changes use transactions where they
must be atomic.

### Event provenance

Extend `swap_events` with:

- `block_hash TEXT`;
- `canonical BOOLEAN NOT NULL DEFAULT TRUE`;
- `orphaned_at TIMESTAMPTZ`;
- `session_before JSONB`;
- `session_after JSONB`.

New rows require a block hash. `session_before` and `session_after` preserve the
strategy projection around a processed swap so that a safe rollback can
restore the last canonical snapshot without reconstructing unrelated manual
actions. The unique event identity remains the current transaction-hash plus
log-index identifier. If the same identity appears on the replacement chain,
its block provenance is updated and it becomes eligible for idempotent replay.

Add block provenance and canonical state to `discovered_tokens`. Persist the
creation block hash in `PairInfo` and the session payload. A pair discovery is
never physically deleted; an orphaned discovery remains auditable with
`canonical = FALSE`.

Risk reports and dry-run trades derived exclusively from an orphaned first-buy
event remain in the audit trail but are marked superseded by the reorg. Live
wallet transactions and their accounting rows are never superseded solely
because a source log disappeared.

### Reorg audit

```sql
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

`status` is `RECONCILING`, `RECOVERED`, or `MANUAL_REVIEW`. The row is created
when divergence is confirmed and updated after rollback/replay.

## Confirmed Ingestion Flow

For either listener:

1. A timer or WebSocket notification requests reconciliation.
2. The coordinator serializes the request with any active chain pass.
3. It reads `latestBlock` and computes
   `confirmedHead = latestBlock - BLOCK_CONFIRMATIONS`.
4. If the subtraction would be negative, there is no actionable range.
5. It verifies the hash of the stored canonical tip and the parent/hash
   continuity of every new header up to the confirmed head.
6. If the chain is unchanged, it lets the listener read logs from its
   checkpoint plus one through the confirmed head in bounded chunks.
7. Every log must include `blockHash`. Missing provenance aborts the pass.
8. The listener processes logs in block, transaction, and log-index order.
9. After a complete chunk succeeds, the checkpoint is stored with the exact
   hash of the chunk's final block.

`PairCreatedListener` starts at its existing discovery position. A new
`SwapListener` starts at the pair creation block, but never beyond the
confirmed head. WebSocket callbacks do not call `processLogs`; they coalesce
into a coordinator reconciliation request.

## Reorg Detection

A divergence exists when:

- the RPC hash for a stored canonical block differs from the stored hash; or
- a newly fetched block's parent hash differs from the preceding canonical
  hash.

The coordinator walks backward through the retained 128-block journal and asks
the RPC for each corresponding canonical block until it finds an equal hash.
This block is the common ancestor.

All required header reads complete before database mutation begins. Therefore,
an RPC error during detection cannot partially rewind the application.

If no common ancestor exists in the retained window:

- no listener checkpoint advances;
- the current reorg audit becomes `MANUAL_REVIEW`;
- new business ingestion remains paused;
- heartbeat/dashboard report the degraded state and diagnostic;
- no automatic rollback is attempted.

## Rollback and Replay

When a common ancestor exists, the coordinator pauses listener admissions and
executes rollback before the recovery barrier wakes listeners again.

In one database transaction it:

1. marks discoveries and swap events above the ancestor non-canonical;
2. records their orphaned timestamp;
3. rewinds every checkpoint above the ancestor to the ancestor number/hash;
4. removes old-fork canonical headers above the ancestor;
5. records the affected pairs and sessions for projection reconciliation.

After the transaction, affected sessions are reconciled under their existing
pair serialization locks. New canonical headers and logs are then replayed from
the ancestor plus one. Stable event identities prevent duplicates; an event
that returns with the same transaction hash and log index is reactivated with
its new block hash and processed once for the new canonical projection.

Capacity is not released to another pair until a stopped listener has drained,
preserving the monitor-queue invariant introduced by issue #10.

## Disappearing-Event Policy

### `PairCreated` disappears

If the pair has caused no wallet transaction, stop its listener, mark discovery
and session non-canonical, and retain both for audit. It is excluded from future
monitor admission.

If any live wallet transaction exists for the pair, preserve all accounting and
move the session to `MANUAL_REVIEW`.

### First observed buy disappears

If no wallet transaction exists, restore the last canonical session snapshot,
clear the orphaned first-buy/observation projection, supersede its risk report
and dry-run trade if present, then replay replacement-chain events.

If an entry transaction was broadcast or confirmed, do not alter or compensate
it. Move the session to `MANUAL_REVIEW`.

### A counted post-entry buy or sell signal disappears

Recompute `entryObservationBuys` and the exit counter from canonical events. If
the old signal only caused a dry-run sale, supersede that simulation and replay
the canonical projection.

If the signal caused a wallet approval or sale to be prepared, broadcast, or
confirmed, preserve the transaction and move the session to `MANUAL_REVIEW`.
The normal crash-reconciliation workflow remains responsible for determining
the on-chain transaction outcome.

### Unrelated confirmed wallet transaction

A confirmed wallet transaction is authoritative evidence of wallet state even
when its triggering event is orphaned. Its trade, transaction, amounts, and gas
remain immutable. Only the session's strategy classification changes to
`MANUAL_REVIEW`.

## Failure Handling

- `getBlockNumber`, `getBlock`, or `getContractEvents` failure: log a sanitized
  RPC error and leave checkpoints unchanged.
- Missing block hash or parent hash: abort as invalid RPC data.
- Log processing failure: mark the event failed using the existing mechanism
  and do not advance the chunk checkpoint.
- Rollback transaction failure: roll back all database mutations and keep
  ingestion paused for retry.
- Projection reconciliation failure: retain the reorg as `RECONCILING`, keep
  affected listeners paused, and retry through runtime recovery.
- Deep reorg: require manual review as described above.

## Heartbeat and Dashboard

Add:

- configured confirmation depth;
- latest RPC block;
- latest sufficiently confirmed block;
- latest canonical block number/hash;
- chain state: `HEALTHY`, `RECONCILING`, or `MANUAL_REVIEW`;
- last reorg detection time, depth, common ancestor, and status;
- orphaned and replayed event counts for the last reorg.

The dashboard explains that confirmation depth intentionally delays discovery
and swap decisions. Existing last-known RPC values remain visible during an RPC
failure, while chain state and checkpoint values clearly show that ingestion
did not advance.

## Tests

Use TDD for each behavior.

### Unit tests

- Strict `BLOCK_CONFIRMATIONS` parsing, default `5`, and invalid bounds.
- Confirmed-head calculation and insufficient-height behavior.
- Header continuity on a normal chain.
- Reorg before confirmation produces no business event or rollback.
- Common-ancestor search inside the 128-block window.
- Deep divergence produces `MANUAL_REVIEW`.
- RPC failure during hash verification produces no checkpoint write.
- WebSocket logs only schedule HTTP reconciliation.

### Listener tests

- `PairCreated` processes only confirmed HTTP logs with block hashes.
- `Swap` processes only confirmed HTTP logs with block hashes.
- Checkpoints persist number and hash only after successful processing.
- A replacement-chain event with the same stable identity is replayed once.

### PostgreSQL integration tests

- Migration is idempotent.
- Normal-chain journal/checkpoint persistence is atomic.
- Divergence discovered after restart rewinds to the common ancestor.
- Orphaned `PairCreated` disables its pair without deleting audit data.
- Orphaned first buy restores the previous session projection.
- Orphaned counted buy recomputes the observation state.
- A wallet transaction related to an orphaned event is preserved and forces
  `MANUAL_REVIEW`.
- Rollback failure leaves canonical rows and checkpoints unchanged.

### Full validation

```bash
npm run check
npm test
npm run build
```

PostgreSQL integration tests run through the repository's opt-in database test
setup and are added to CI when the existing PostgreSQL job is enabled.

## Documentation

Update `.env.example`, `README.md`, heartbeat/dashboard documentation, and
strategy documentation. State clearly that five confirmations are a latency
and safety compromise, that recent reorgs are recovered automatically, and
that deep reorgs or irreversible wallet consequences require human review.

## Acceptance Mapping

- Hash-aware checkpoints and `canonical_blocks` detect divergence.
- Confirmed-head ingestion prevents unconfirmed business decisions.
- The retained journal, orphan markers, snapshots, and stable event identity
  support recent rollback and duplicate-free replay.
- Explicit disappearing-event policies cover pair discovery, first buy,
  counted buys, sell signals, dry-run consequences, and wallet transactions.
- `MANUAL_REVIEW` and paused ingestion make irreversible/deep cases visible.
- Heartbeat/dashboard expose confirmation depth and the last detected reorg.
