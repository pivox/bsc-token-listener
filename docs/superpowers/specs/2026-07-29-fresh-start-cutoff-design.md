# Fresh-start cutoff at every bot launch

**Date:** 2026-07-29  
**Status:** Approved design  
**Scope:** Startup ingestion, persisted sessions and dashboard ordering

## 1. Objective

Every process launch establishes a new observation boundary at the current
confirmed BSC head. The bot must not replay or act on tokens, pairs, swaps,
sessions or decisions created before that boundary.

Historical records remain available for audit. They are not deleted.

This behavior is mandatory and has no environment switch. `EXECUTION_MODE`
continues to default to `dry-run`; this feature must never enable live mode.

## 2. User-visible behavior

On every launch the bot:

1. reads the current confirmed block and its hash;
2. quarantines all previously non-terminal sessions as `MANUAL_REVIEW`;
3. makes all previously recoverable exit decisions non-executable;
4. records and installs the new cutoff;
5. starts the dashboard;
6. starts listeners from the cutoff without scanning older blocks.

The initial crash reconciliation pass is not run. A position or transaction
from a previous process lifetime is never resumed automatically. Its persisted
context remains visible for manual inspection.

Only chain events strictly after the installed cutoff may enter business
processing.

## 3. Status and execution rules

All sessions whose status is not terminal at startup are moved to
`MANUAL_REVIEW`, including:

- `WAITING_FIRST_BUY`;
- `RISK_CHECKING`;
- `BUY_PENDING`;
- `HOLDING`;
- `SELL_PENDING`;
- an already existing `MANUAL_REVIEW`.

The session receives a stable, explicit diagnostic reason identifying the
fresh-start cutoff. Existing entry, exit, trade, transaction, risk and recovery
references are retained.

No buy, approval or sell may be broadcast while applying the cutoff. A session
that contains a potentially broadcast or confirmed transaction remains a
manual responsibility; the bot does not infer or resume its result.

Recoverable position-exit decisions (`PENDING` or `EXECUTING`) are moved to
`MANUAL_REVIEW`, not deleted and not requeued. Their metrics, rule, related
trade and error context are retained.

Terminal sessions (`CLOSED`, `REJECTED`, `EXPIRED`) are unchanged.

## 4. Persisted cutoff

An idempotent SQL migration adds a table for fresh-start runs. Each committed
run records at least:

- a unique run identifier;
- the confirmed cutoff block number;
- the cutoff block hash;
- the application timestamp;
- the number of sessions quarantined;
- the number of decisions quarantined.

The latest committed run is the authoritative ingestion lower bound. The
block number is stored as an exact PostgreSQL numeric value and mapped to
TypeScript `bigint`.

The cutoff is immutable after commit. A later launch creates a new run with a
new cutoff rather than mutating the previous audit row.

## 5. Atomic startup service

A dedicated `FreshStartService` owns the operation. It depends on:

- a gateway that reads the confirmed head and its real hash;
- a repository that applies the cutoff transaction;
- the configured confirmation count.

The RPC head and header are read before opening the database transaction. The
returned number and hash are strictly validated.

The repository then performs one PostgreSQL transaction:

1. acquire a transaction-scoped advisory lock;
2. ensure the candidate cutoff is not older than the latest committed cutoff;
3. quarantine non-terminal sessions and update their JSON payloads consistently;
4. quarantine recoverable position-exit decisions;
5. re-anchor every existing listener checkpoint to the cutoff, including
   internal canonical synchronization and obsolete `swap:*` checkpoints;
6. create the `pair-created` checkpoint at the cutoff when it does not yet
   exist;
7. insert the immutable fresh-start audit row;
8. commit.

Any SQL failure rolls back sessions, decisions, checkpoints and the audit row
together. A failure to read or validate the confirmed head happens before all
database mutation.

Two bot processes sharing PostgreSQL cannot apply overlapping cutoffs because
of the advisory lock. After acquiring it, the later process rechecks the
latest committed cutoff before writing.

## 6. Ingestion boundary

Checkpoint placement alone is insufficient because a reorg can rewind a
checkpoint. The canonical coordinator therefore enforces the persisted cutoff
as a hard lower bound:

- a requested range starts no earlier than `cutoff + 1`;
- a decoded event at or below the cutoff is rejected before business callbacks;
- no checkpoint can be persisted below the cutoff;
- the oldest-checkpoint calculation cannot retain a pre-cutoff internal key;
- a legacy checkpoint below the cutoff is replaced by the cutoff anchor rather
  than replayed.

If a reorg would require reading at or below the cutoff, the chain state moves
to `MANUAL_REVIEW` and ingestion stops. The bot does not cross the boundary to
find an older common ancestor.

An RPC error never installs a cutoff and never advances a checkpoint.

## 7. Startup order

The startup order becomes:

1. validate configuration and RPC router/factory/WBNB identity;
2. apply idempotent migrations;
3. apply the fresh-start cutoff transaction;
4. start the dashboard;
5. prepare canonical state bounded by the cutoff;
6. activate position monitoring for sessions created in this process lifetime;
7. activate `PairCreated` and per-pair `Swap` listeners;
8. start periodic runtime recovery for failures occurring after the cutoff.

The previous initial recovery call is removed from the startup path. Runtime
recovery remains useful during a running process, but a later restart
quarantines anything it left unfinished.

Listener activation is blocked until the cutoff transaction commits.

## 8. Dashboard ordering

The dashboard preserves historical rows and sorts them by the following stable
priority:

1. `MANUAL_REVIEW`;
2. `WAITING_FIRST_BUY` (“En attente du premier achat”);
3. other active statuses;
4. terminal statuses and discoveries without an active session.

Rows inside each group are ordered by most recent session or discovery update,
then by a deterministic address tie-breaker.

This ordering is applied in the repository query before `LIMIT`, so high
priority rows cannot be omitted by pagination.

The fresh-start diagnostic reason remains visible in token details. Quarantined
sessions are not admitted to automatic pair monitoring.

## 9. Failure handling and safety

- An unavailable or malformed confirmed head aborts startup.
- A database failure rolls back the complete cutoff.
- A second process cannot partially overwrite the first process cutoff.
- No blockchain transaction is issued by `FreshStartService`.
- No `TokenRiskReport` invariant is weakened for entries created after startup.
- `RISK_POLICY=allow-only` remains unchanged.
- A fresh-start change never activates live execution.
- Historical tables and migrations are never cleared automatically.

## 10. Tests

### Unit tests

- confirmed-head calculation uses configured confirmations;
- malformed RPC number or hash is rejected;
- startup invokes the cutoff before dashboard and listeners;
- initial crash reconciliation is not invoked;
- listener ranges and decoded events at or below the cutoff are rejected;
- a reorg crossing the cutoff produces `MANUAL_REVIEW`;
- dashboard priority is `MANUAL_REVIEW`, then `WAITING_FIRST_BUY`, then other
  statuses.

### PostgreSQL integration tests

- the migration is idempotent;
- all non-terminal statuses become `MANUAL_REVIEW`;
- terminal sessions are unchanged;
- session payload and status column remain consistent;
- `PENDING` and `EXECUTING` exit decisions become `MANUAL_REVIEW`;
- session, decision, checkpoint and audit changes commit atomically;
- an injected SQL failure leaves every table unchanged;
- concurrent startup attempts serialize and retain monotonic cutoffs;
- two successive launches create two audit rows and the newest cutoff wins;
- large block numbers remain exact.

### Full validation

Before commit and delivery:

```bash
npm run check
npm test
npm run build
npm run test:postgres
```

PostgreSQL tests may use a temporary isolated local instance when
`TEST_DATABASE_URL` is not provided.

## 11. Out of scope

- deleting historical tokens, sessions, events, reports or trades;
- reconciling transactions from a previous process lifetime;
- automatically selling quarantined positions;
- mempool or front-running;
- bypassing anti-bot protections;
- secret storage;
- automatic live-mode activation;
- a configurable legacy replay mode.
