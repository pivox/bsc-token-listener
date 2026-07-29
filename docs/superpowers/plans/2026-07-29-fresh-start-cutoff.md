# Fresh-Start Cutoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every bot launch quarantine all previous non-terminal work, install the current confirmed BSC head as an immutable ingestion cutoff, and process only events strictly after that cutoff.

**Architecture:** A focused `FreshStartService` reads and validates the confirmed canonical header, then a PostgreSQL repository atomically quarantines sessions and exit decisions, re-anchors every listener checkpoint, replaces the canonical journal with the cutoff header, and writes an audit row. The returned cutoff is injected into `CanonicalChainCoordinator` as a hard range and reorg boundary; startup no longer invokes initial crash reconciliation. Dashboard SQL gives `MANUAL_REVIEW` and `WAITING_FIRST_BUY` deterministic priority before applying its row limit.

**Tech Stack:** TypeScript strict ESM, viem, PostgreSQL/pg, Node test runner through tsx, bigint-safe JSON helpers.

---

## File map

### New files

- `migrations/009_fresh_start_cutoff.sql` — idempotent audit schema and indexes.
- `src/runtime/fresh-start.types.ts` — cutoff input/result types and stable reason constants.
- `src/runtime/fresh-start.repository.ts` — the single atomic PostgreSQL cutoff transaction.
- `src/runtime/fresh-start.service.ts` — confirmed-head RPC validation and repository orchestration.
- `tests/fresh-start-repository.test.ts` — repository SQL contract and fail-closed unit tests.
- `tests/fresh-start-service.test.ts` — confirmed-head and malformed-RPC unit tests.
- `tests/postgres/fresh-start-cutoff.test.ts` — real PostgreSQL atomicity, concurrency and restart coverage.

### Modified files

- `src/chain/canonical-chain.coordinator.ts` — enforce cutoff for ranges, checkpoints, journal preparation and reorg ancestor search.
- `src/app.ts` — apply cutoff before dashboard/listeners and remove `reconcileInitial()` from startup.
- `src/dashboard/dashboard.ts` — deterministic status priority before `LIMIT`.
- `tests/canonical-chain-coordinator.test.ts` — lower-bound and cutoff-crossing reorg coverage.
- `tests/startup-order.test.ts` — startup ordering contract.
- `tests/dashboard-metrics.test.ts` or a new focused `tests/dashboard-order.test.ts` — dashboard SQL priority contract.
- `README.md` — mandatory fresh-start semantics and manual-review consequences.
- `docs/strategy.md` — ingestion boundary and restart behavior.

## Task 1: Define and migrate the persisted cutoff model

**Files:**
- Create: `migrations/009_fresh_start_cutoff.sql`
- Create: `src/runtime/fresh-start.types.ts`
- Create: `tests/fresh-start-repository.test.ts`

- [ ] **Step 1: Write the failing migration and type contract tests**

Create `tests/fresh-start-repository.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { Hash } from 'viem';
import {
  FRESH_START_REASON,
  type FreshStartCutoff,
} from '../src/runtime/fresh-start.types.js';

const HASH = `0x${'1'.repeat(64)}` as Hash;
const PARENT_HASH = `0x${'2'.repeat(64)}` as Hash;

test('définit une raison stable et un cutoff bigint hash-aware', () => {
  const cutoff: FreshStartCutoff = {
    number: 9_007_199_254_740_993n,
    hash: HASH,
    parentHash: PARENT_HASH,
  };
  assert.equal(FRESH_START_REASON, 'FRESH_START_CUTOFF');
  assert.equal(cutoff.number, 9_007_199_254_740_993n);
});

test('la migration fresh-start est idempotente et bigint-safe', async () => {
  const sql = await readFile('migrations/009_fresh_start_cutoff.sql', 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS fresh_start_runs/u);
  assert.match(sql, /cutoff_block_number NUMERIC\(78,\s*0\)/u);
  assert.match(sql, /cutoff_block_hash TEXT NOT NULL/u);
  assert.match(sql, /cutoff_parent_hash TEXT NOT NULL/u);
  assert.match(sql, /quarantined_sessions INTEGER NOT NULL/u);
  assert.match(sql, /quarantined_decisions INTEGER NOT NULL/u);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS/u);
});
```

- [ ] **Step 2: Run the test and verify the red state**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test tests/fresh-start-repository.test.ts
```

Expected: FAIL because `fresh-start.types.ts` and migration 009 do not exist.

- [ ] **Step 3: Add the minimal strict types**

Create `src/runtime/fresh-start.types.ts`:

```ts
import type { Hash } from 'viem';

export const FRESH_START_REASON = 'FRESH_START_CUTOFF';

export interface FreshStartCutoff {
  readonly number: bigint;
  readonly hash: Hash;
  readonly parentHash: Hash;
}

export interface FreshStartRun {
  readonly id: string;
  readonly cutoff: FreshStartCutoff;
  readonly appliedAtMs: number;
  readonly quarantinedSessions: number;
  readonly quarantinedDecisions: number;
}
```

- [ ] **Step 4: Add the idempotent migration**

Create `migrations/009_fresh_start_cutoff.sql`:

```sql
CREATE TABLE IF NOT EXISTS fresh_start_runs (
  run_id TEXT PRIMARY KEY,
  cutoff_block_number NUMERIC(78, 0) NOT NULL
    CHECK (cutoff_block_number >= 0),
  cutoff_block_hash TEXT NOT NULL,
  cutoff_parent_hash TEXT NOT NULL,
  quarantined_sessions INTEGER NOT NULL
    CHECK (quarantined_sessions >= 0),
  quarantined_decisions INTEGER NOT NULL
    CHECK (quarantined_decisions >= 0),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fresh_start_runs_latest
  ON fresh_start_runs(applied_at DESC, run_id DESC);
```

- [ ] **Step 5: Run the focused test**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test tests/fresh-start-repository.test.ts
```

Expected: 2 tests pass.

- [ ] **Step 6: Run required validation and commit**

Run:

```bash
npm run check
npm test
npm run build
git diff --check
```

Expected: all commands exit 0.

Commit:

```bash
git add migrations/009_fresh_start_cutoff.sql \
  src/runtime/fresh-start.types.ts \
  tests/fresh-start-repository.test.ts
git commit -m "feat: define fresh-start cutoff"
```

## Task 2: Implement the atomic PostgreSQL cutoff repository

**Files:**
- Create: `src/runtime/fresh-start.repository.ts`
- Modify: `tests/fresh-start-repository.test.ts`

- [ ] **Step 1: Add failing repository transaction tests**

Extend `tests/fresh-start-repository.test.ts` with a recording database. The
test must assert both ordering and parameter safety:

```ts
import { FreshStartRepository } from '../src/runtime/fresh-start.repository.js';

test('applique session, décision, checkpoints, journal et audit dans une transaction', async () => {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const client = {
    query: async <T = Record<string, unknown>>(
      sql: string,
      values?: unknown[],
    ): Promise<{ rows: T[] }> => {
      calls.push({ sql, values });
      if (sql.includes('UPDATE token_sessions')) {
        return { rows: [{ pair_address: '0x1' }] as T[] };
      }
      if (sql.includes('UPDATE position_exit_decisions')) {
        return { rows: [{ decision_id: 'decision-1' }] as T[] };
      }
      if (sql.includes('INSERT INTO fresh_start_runs')) {
        return {
          rows: [{
            run_id: 'run-1',
            cutoff_block_number: '9007199254740993',
            cutoff_block_hash: HASH,
            cutoff_parent_hash: PARENT_HASH,
            quarantined_sessions: 1,
            quarantined_decisions: 1,
            applied_at: new Date(1),
          }] as T[],
        };
      }
      return { rows: [] as T[] };
    },
    release(): void {},
  };
  const repository = new FreshStartRepository({
    connect: async () => client,
  });

  const result = await repository.apply({
    number: 9_007_199_254_740_993n,
    hash: HASH,
    parentHash: PARENT_HASH,
  }, 1);

  assert.equal(result.cutoff.number, 9_007_199_254_740_993n);
  assert.deepEqual(
    calls.filter(({ sql }) => ['BEGIN', 'COMMIT'].includes(sql)).map(({ sql }) => sql),
    ['BEGIN', 'COMMIT'],
  );
  assert.ok(calls.some(({ sql }) => /pg_advisory_xact_lock/u.test(sql)));
  assert.ok(calls.some(({ sql }) => /UPDATE token_sessions/u.test(sql)));
  assert.ok(calls.some(({ sql }) => /UPDATE position_exit_decisions/u.test(sql)));
  assert.ok(calls.some(({ sql }) => /UPDATE listener_checkpoints/u.test(sql)));
  assert.ok(calls.some(({ sql }) => /DELETE FROM canonical_blocks/u.test(sql)));
  assert.ok(calls.some(({ sql }) => /INSERT INTO fresh_start_runs/u.test(sql)));
});

test('rollback toute la transaction si une étape échoue', async () => {
  const calls: string[] = [];
  const repository = new FreshStartRepository({
    connect: async () => ({
      query: async <T>(sql: string): Promise<{ rows: T[] }> => {
        calls.push(sql);
        if (sql.includes('UPDATE position_exit_decisions')) {
          throw new Error('decision update failed');
        }
        return { rows: [] };
      },
      release(): void {},
    }),
  });

  await assert.rejects(
    repository.apply({ number: 10n, hash: HASH, parentHash: PARENT_HASH }, 1),
    /decision update failed/u,
  );
  assert.equal(calls.includes('ROLLBACK'), true);
  assert.equal(calls.includes('COMMIT'), false);
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test tests/fresh-start-repository.test.ts
```

Expected: FAIL because `FreshStartRepository` is absent.

- [ ] **Step 3: Implement row mapping and the transaction**

Create `src/runtime/fresh-start.repository.ts` with these public boundaries:

```ts
import { randomUUID } from 'node:crypto';
import { isHash } from 'viem';
import { pool } from '../storage/database.js';
import { FRESH_START_REASON } from './fresh-start.types.js';
import type {
  FreshStartCutoff,
  FreshStartRun,
} from './fresh-start.types.js';

interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
}

interface Client extends Queryable {
  release(): void;
}

interface Database {
  connect(): Promise<Client>;
}

interface RunRow {
  run_id: string;
  cutoff_block_number: string;
  cutoff_block_hash: string;
  cutoff_parent_hash: string;
  quarantined_sessions: number;
  quarantined_decisions: number;
  applied_at: Date | string;
}

const ACTIVE_STATUSES = [
  'WAITING_FIRST_BUY',
  'RISK_CHECKING',
  'BUY_PENDING',
  'HOLDING',
  'SELL_PENDING',
  'MANUAL_REVIEW',
] as const;

function mapRun(row: RunRow | undefined): FreshStartRun {
  if (row === undefined) {
    throw new Error('Audit fresh-start absent après insertion.');
  }
  const number = BigInt(row.cutoff_block_number);
  const appliedAtMs = new Date(row.applied_at).getTime();
  if (
    number < 0n
    || !isHash(row.cutoff_block_hash)
    || !isHash(row.cutoff_parent_hash)
    || !Number.isInteger(row.quarantined_sessions)
    || row.quarantined_sessions < 0
    || !Number.isInteger(row.quarantined_decisions)
    || row.quarantined_decisions < 0
    || !Number.isFinite(appliedAtMs)
  ) {
    throw new Error('Audit fresh-start invalide.');
  }
  return {
    id: row.run_id,
    cutoff: {
      number,
      hash: row.cutoff_block_hash,
      parentHash: row.cutoff_parent_hash,
    },
    appliedAtMs,
    quarantinedSessions: row.quarantined_sessions,
    quarantinedDecisions: row.quarantined_decisions,
  };
}

export class FreshStartRepository {
  constructor(private readonly database: Database = pool as unknown as Database) {}

  async apply(cutoff: FreshStartCutoff, nowMs: number): Promise<FreshStartRun> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtext('fresh-start-cutoff'))`,
      );
      const latest = await client.query<RunRow>(
        `SELECT * FROM fresh_start_runs
         ORDER BY applied_at DESC, run_id DESC
         LIMIT 1 FOR UPDATE`,
      );
      const previous = latest.rows[0];
      if (
        previous
        && (
          cutoff.number < BigInt(previous.cutoff_block_number)
          || (
            cutoff.number === BigInt(previous.cutoff_block_number)
            && cutoff.hash.toLowerCase()
              !== previous.cutoff_block_hash.toLowerCase()
          )
        )
      ) {
        throw new Error('Cutoff fresh-start antérieur ou divergent.');
      }

      const reason =
        `${FRESH_START_REASON}: bloc confirmé ${cutoff.number}.`;
      const sessions = await client.query<{ pair_address: string }>(
        `UPDATE token_sessions SET
           status = 'MANUAL_REVIEW',
           payload = jsonb_set(
             jsonb_set(
               jsonb_set(payload, '{status}', '"MANUAL_REVIEW"'::jsonb),
               '{rejectionReason}', to_jsonb($2::text), TRUE
             ),
             '{updatedAtMs}', to_jsonb($3::bigint), TRUE
           ),
           recovery_owner = NULL,
           recovery_lease_until = NULL,
           recovery_error = $2,
           updated_at = to_timestamp($3 / 1000.0)
         WHERE status = ANY($1::text[])
         RETURNING pair_address`,
        [[...ACTIVE_STATUSES], reason, nowMs],
      );
      const decisions = await client.query<{ decision_id: string }>(
        `UPDATE position_exit_decisions SET
           status = 'MANUAL_REVIEW',
           error_type = $1,
           updated_at = to_timestamp($2 / 1000.0)
         WHERE status IN ('PENDING', 'EXECUTING')
         RETURNING decision_id`,
        [FRESH_START_REASON, nowMs],
      );
      await client.query(
        `UPDATE listener_checkpoints SET
           block_number = $1,
           block_hash = $2,
           updated_at = to_timestamp($3 / 1000.0)`,
        [cutoff.number.toString(), cutoff.hash.toLowerCase(), nowMs],
      );
      await client.query(
        `INSERT INTO listener_checkpoints(
           listener_key, block_number, block_hash, updated_at
         ) VALUES ('pair-created', $1, $2, to_timestamp($3 / 1000.0))
         ON CONFLICT (listener_key) DO UPDATE SET
           block_number = EXCLUDED.block_number,
           block_hash = EXCLUDED.block_hash,
           updated_at = EXCLUDED.updated_at`,
        [cutoff.number.toString(), cutoff.hash.toLowerCase(), nowMs],
      );
      await client.query('DELETE FROM canonical_blocks');
      await client.query(
        `INSERT INTO canonical_blocks(
           block_number, block_hash, parent_hash, observed_at
         ) VALUES ($1, $2, $3, to_timestamp($4 / 1000.0))`,
        [
          cutoff.number.toString(),
          cutoff.hash.toLowerCase(),
          cutoff.parentHash.toLowerCase(),
          nowMs,
        ],
      );
      const runId = randomUUID();
      const inserted = await client.query<RunRow>(
        `INSERT INTO fresh_start_runs(
           run_id, cutoff_block_number, cutoff_block_hash,
           cutoff_parent_hash, quarantined_sessions,
           quarantined_decisions, applied_at
         ) VALUES ($1, $2, $3, $4, $5, $6, to_timestamp($7 / 1000.0))
         RETURNING *`,
        [
          runId,
          cutoff.number.toString(),
          cutoff.hash.toLowerCase(),
          cutoff.parentHash.toLowerCase(),
          sessions.rows.length,
          decisions.rows.length,
          nowMs,
        ],
      );
      const run = mapRun(inserted.rows[0]);
      await client.query('COMMIT');
      return run;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
```

The mapper deliberately runs before `COMMIT`: malformed database output must
roll back the whole cutoff transaction instead of returning a partially
validated audit.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test tests/fresh-start-repository.test.ts
```

Expected: all repository tests pass.

- [ ] **Step 5: Run required validation and commit**

Run:

```bash
npm run check
npm test
npm run build
git diff --check
```

Commit:

```bash
git add src/runtime/fresh-start.repository.ts \
  tests/fresh-start-repository.test.ts
git commit -m "feat: persist atomic fresh-start cutoff"
```

## Task 3: Read and validate the confirmed cutoff header

**Files:**
- Create: `src/runtime/fresh-start.service.ts`
- Create: `tests/fresh-start-service.test.ts`

- [ ] **Step 1: Write failing service tests**

Create `tests/fresh-start-service.test.ts`:

```ts
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
      { apply: async () => { throw new Error('unexpected'); } },
      5,
    );
    await assert.rejects(service.apply(), /header.*invalide/iu);
  }
});
```

- [ ] **Step 2: Run tests and verify the missing implementation failure**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test tests/fresh-start-service.test.ts
```

Expected: FAIL because `FreshStartService` does not exist.

- [ ] **Step 3: Implement the service**

Create `src/runtime/fresh-start.service.ts`:

```ts
import { isHash } from 'viem';
import type { CanonicalBlockReader } from '../chain/canonical-chain.types.js';
import { confirmedHead } from '../chain/confirmed-blocks.js';
import type { FreshStartRepository } from './fresh-start.repository.js';
import type { FreshStartRun } from './fresh-start.types.js';

export class FreshStartService {
  constructor(
    private readonly reader: CanonicalBlockReader,
    private readonly repository: Pick<FreshStartRepository, 'apply'>,
    private readonly confirmations: number,
    private readonly now: () => number = Date.now,
  ) {}

  async apply(): Promise<FreshStartRun> {
    const latest = await this.reader.getBlockNumber();
    const number = confirmedHead(latest, this.confirmations);
    if (number === null) {
      throw new Error('Aucun bloc BSC suffisamment confirmé pour le fresh-start.');
    }
    const header = await this.reader.getBlock(number);
    if (
      header.number !== number
      || !isHash(header.hash)
      || !isHash(header.parentHash)
    ) {
      throw new Error(`Header fresh-start invalide pour le bloc ${number}.`);
    }
    return this.repository.apply(
      {
        number,
        hash: header.hash,
        parentHash: header.parentHash,
      },
      this.now(),
    );
  }
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test tests/fresh-start-service.test.ts
```

Expected: all service tests pass.

- [ ] **Step 5: Run required validation and commit**

Run the required trio and commit:

```bash
npm run check
npm test
npm run build
git diff --check
git add src/runtime/fresh-start.service.ts tests/fresh-start-service.test.ts
git commit -m "feat: resolve confirmed fresh-start head"
```

## Task 4: Enforce the cutoff inside the canonical coordinator

**Files:**
- Modify: `src/chain/canonical-chain.coordinator.ts`
- Modify: `tests/canonical-chain-coordinator.test.ts`

- [ ] **Step 1: Add cutoff support to the test subject**

In `tests/canonical-chain-coordinator.test.ts`, extend the local `coordinator`
options with:

```ts
cutoff?: CanonicalBlock;
```

and pass it into `new CanonicalChainCoordinator` when defined.

- [ ] **Step 2: Write failing range-boundary tests**

Add:

```ts
test('ne traite jamais le cutoff ni un checkpoint plus ancien', async () => {
  const cutoff = block(100n);
  const checkpoints = new MemoryCheckpoints();
  checkpoints.values.set('pairs', {
    blockNumber: 10n,
    blockHash: hash(11n),
  });
  const ranges: Array<[bigint, bigint]> = [];
  const subject = coordinator(
    new MemoryBlockReader(110n),
    new MemoryCanonicalStore([cutoff]),
    checkpoints,
    { confirmations: 5, cutoff },
  );

  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 0n,
    processChunk: async (from, to, headers) => {
      ranges.push([from, to]);
      assert.ok(headers.every(({ number }) => number > cutoff.number));
      return true;
    },
  });

  assert.deepEqual(ranges, [[101n, 105n]]);
  assert.ok(
    checkpoints.writes.every(
      ({ checkpoint }) => checkpoint.blockNumber >= cutoff.number,
    ),
  );
});

test('ne rappelle pas processChunk tant que le head confirmé égale le cutoff', async () => {
  const cutoff = block(100n);
  let chunks = 0;
  const subject = coordinator(
    new MemoryBlockReader(105n),
    new MemoryCanonicalStore([cutoff]),
    new MemoryCheckpoints(),
    { confirmations: 5, cutoff },
  );
  await subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 0n,
    processChunk: async () => {
      chunks += 1;
      return true;
    },
  });
  assert.equal(chunks, 0);
});
```

- [ ] **Step 3: Write the failing cutoff-crossing reorg test**

Create `cutoff = block(100n)`. Seed the canonical store with the original
headers 100 through 103, configure the reader with divergent headers 100
through 105, and record every requested block number. Make the reader's block
100 hash differ from the stored cutoff hash so there is no common ancestor at
or above the boundary. Assert:

```ts
await assert.rejects(
  subject.reconcile({
    listenerKey: 'pairs',
    startBlock: 0n,
    processChunk: async () => true,
  }),
  /cutoff fresh-start/iu,
);
assert.equal(subject.currentStatus.state, 'MANUAL_REVIEW');
assert.equal(
  reader.reads.some((number) => number < cutoff.number),
  false,
);
```

The reorg handler fixture must return
`{ depth: null, orphanedEvents: 0, replayedEvents: 0, requiresManualReview: true }`
when the boundary is crossed.

- [ ] **Step 4: Run the focused coordinator tests and verify red**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test tests/canonical-chain-coordinator.test.ts
```

Expected: the new cutoff tests fail because the coordinator has no cutoff
option.

- [ ] **Step 5: Implement cutoff validation and range clamping**

In `CanonicalChainCoordinatorOptions`, add:

```ts
cutoff?: CanonicalBlock;
```

In the class, validate and store a defensive cutoff copy:

```ts
private readonly cutoff: CanonicalBlock | null;

this.cutoff = options.cutoff === undefined
  ? null
  : structuredClone(validateHeader(options.cutoff, options.cutoff.number));
```

In `execute()`:

```ts
const storedCheckpoint = await this.checkpoints.get(request.listenerKey);
const checkpoint =
  this.cutoff !== null
  && (
    storedCheckpoint === null
    || storedCheckpoint.blockNumber < this.cutoff.number
  )
    ? {
        blockNumber: this.cutoff.number,
        blockHash: this.cutoff.hash,
      }
    : storedCheckpoint;

const requestedFromBlock = checkpoint
  ? checkpoint.blockNumber + 1n
  : request.bootstrap === 'confirmed-head'
    ? head
    : request.startBlock;
const fromBlock = this.cutoff === null
  ? requestedFromBlock
  : requestedFromBlock > this.cutoff.number
    ? requestedFromBlock
    : this.cutoff.number + 1n;
```

If the stored checkpoint is below the cutoff, persist the cutoff anchor before
scanning. If `fromBlock > head`, return without `processChunk`.

Clamp `journalStart` to at least `cutoff.number`, ensuring
`getOldestBlockNumber()` cannot make the canonical spool cross the boundary.
Before each `processChunk`, assert `chunkStart > cutoff.number` and every
prepared header is above it. Reject any attempted checkpoint write below it.

- [ ] **Step 6: Stop reorg ancestor search at the cutoff**

Add and use:

```ts
export class FreshStartBoundaryError extends CanonicalChainContinuityError {
  constructor() {
    super('La reorg traverse le cutoff fresh-start.');
    this.name = 'FreshStartBoundaryError';
  }
}
```

In `reconcileDivergence`, filter the validated descending window to headers
whose number is greater than or equal to `cutoff.number`. Never call
`blockReader.getBlock` below the cutoff. When no ancestor is found in that
bounded window, install a `MANUAL_REVIEW` reorg summary with
`requiresManualReview: true`, invoke the existing reorg handler with
`ancestor: null`, and throw `FreshStartBoundaryError`.

An ancestor exactly equal to the cutoff is allowed: replay starts at
`cutoff + 1`. A mismatch of the cutoff header itself crosses the boundary and
is refused.

- [ ] **Step 7: Run focused and full validation**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/canonical-chain-coordinator.test.ts \
  tests/canonical-chain-repository.test.ts \
  tests/listener-confirmations.test.ts
npm run check
npm test
npm run build
git diff --check
```

Expected: all commands exit 0 and the existing RPC-error checkpoint tests
remain green.

- [ ] **Step 8: Commit**

```bash
git add src/chain/canonical-chain.coordinator.ts \
  tests/canonical-chain-coordinator.test.ts
git commit -m "feat: bound canonical ingestion by fresh start"
```

## Task 5: Integrate fresh-start into application startup

**Files:**
- Modify: `src/app.ts`
- Modify: `tests/startup-order.test.ts`
- Modify: `tests/position-exit-runtime.test.ts`

- [ ] **Step 1: Write failing source-order regression tests**

Extend `tests/startup-order.test.ts`:

```ts
import { readFile } from 'node:fs/promises';

test('applique le fresh-start avant dashboard et listeners sans recovery initiale', async () => {
  const source = await readFile('src/app.ts', 'utf8');
  const cutoff = source.indexOf('await freshStartService.apply()');
  const dashboard = source.indexOf('await dashboard?.start()');
  const listeners = source.indexOf('await pairListener.start()');

  assert.ok(cutoff >= 0);
  assert.ok(cutoff < dashboard);
  assert.ok(dashboard < listeners);
  assert.equal(source.includes('await recovery.reconcileInitial()'), false);
});

test('injecte le cutoff engagé dans le coordinateur canonique', async () => {
  const source = await readFile('src/app.ts', 'utf8');
  assert.match(source, /new CanonicalChainCoordinator\(\{[\s\S]*cutoff:\s*freshStartRun\.cutoff/u);
});
```

- [ ] **Step 2: Run tests and verify red**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/startup-order.test.ts \
  tests/position-exit-runtime.test.ts
```

Expected: new startup tests fail.

- [ ] **Step 3: Wire one shared canonical block reader**

In `src/app.ts`, define one `CanonicalBlockReader` adapter after migrations and
reuse it for fresh-start and `CanonicalChainCoordinator`:

```ts
const canonicalBlockReader = {
  getBlockNumber: () => publicClient.getBlockNumber(),
  getBlock: async (blockNumber: bigint) => {
    const block = await publicClient.getBlock({ blockNumber });
    if (
      block.number === null
      || block.hash === null
      || block.number !== blockNumber
    ) {
      throw new Error(`Header RPC incomplet pour le bloc ${blockNumber}.`);
    }
    return {
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
    };
  },
};
```

- [ ] **Step 4: Apply fresh-start before runtime construction**

Import and instantiate:

```ts
const freshStartRun = await new FreshStartService(
  canonicalBlockReader,
  new FreshStartRepository(),
  config.blockConfirmations,
).apply();

logger.warn(
  {
    cutoffBlock: freshStartRun.cutoff.number.toString(),
    cutoffHash: freshStartRun.cutoff.hash,
    quarantinedSessions: freshStartRun.quarantinedSessions,
    quarantinedDecisions: freshStartRun.quarantinedDecisions,
  },
  'Fresh-start appliqué; historique antérieur placé en revue manuelle.',
);
```

This call must occur after migrations and before the dashboard, monitor
admission, canonical synchronization or listener activation. Pass
`canonicalBlockReader` and `cutoff: freshStartRun.cutoff` to
`CanonicalChainCoordinator`.

- [ ] **Step 5: Remove initial crash recovery**

Delete:

```ts
const initialRecovery = await recovery.reconcileInitial();
logger.info(
  { processedSessions: initialRecovery.processedSessions },
  'Réconciliation initiale terminée.',
);
```

Keep `recovery.start()` after listeners so runtime failures occurring after
the new cutoff can still be reconciled during this process lifetime.

Do not call `positionExitMonitor.reconcilePendingDecisions()` on quarantined
old decisions; the repository has already transitioned them to
`MANUAL_REVIEW`. The existing position runtime may still reconcile decisions
created after cutoff before scheduler activation.

- [ ] **Step 6: Run startup and broader tests**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/startup-order.test.ts \
  tests/position-exit-runtime.test.ts \
  tests/recovery-coordinator.test.ts \
  tests/session-monitor-policy.test.ts
npm run check
npm test
npm run build
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/app.ts \
  tests/startup-order.test.ts \
  tests/position-exit-runtime.test.ts
git commit -m "feat: start runtime from current confirmed head"
```

## Task 6: Prioritize manual review and first-buy sessions in dashboard

**Files:**
- Modify: `src/dashboard/dashboard.ts`
- Create: `tests/dashboard-order.test.ts`

- [ ] **Step 1: Write the failing SQL ordering test**

Create `tests/dashboard-order.test.ts`:

```ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('trie MANUAL_REVIEW puis WAITING_FIRST_BUY avant LIMIT', async () => {
  const source = await readFile('src/dashboard/dashboard.ts', 'utf8');
  const manual = source.indexOf("WHEN s.status = 'MANUAL_REVIEW' THEN 0");
  const firstBuy = source.indexOf("WHEN s.status = 'WAITING_FIRST_BUY' THEN 1");
  const limit = source.indexOf('LIMIT $1');

  assert.ok(manual >= 0);
  assert.ok(firstBuy > manual);
  assert.ok(limit > firstBuy);
  assert.match(
    source,
    /COALESCE\(s\.updated_at,\s*d\.updated_at\) DESC,\s*d\.token_address ASC/u,
  );
});
```

- [ ] **Step 2: Run the test and verify red**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test tests/dashboard-order.test.ts
```

Expected: FAIL because the query uses the old grouped ordering.

- [ ] **Step 3: Implement deterministic SQL priority**

Replace the dashboard `ORDER BY` with:

```sql
ORDER BY
  CASE
    WHEN s.status = 'MANUAL_REVIEW' THEN 0
    WHEN s.status = 'WAITING_FIRST_BUY' THEN 1
    WHEN s.status IN (
      'RISK_CHECKING', 'BUY_PENDING', 'HOLDING', 'SELL_PENDING'
    ) THEN 2
    ELSE 3
  END,
  COALESCE(s.updated_at, d.updated_at) DESC,
  d.token_address ASC
LIMIT $1
```

Do not sort in JavaScript after the query: priority must be applied before
pagination.

- [ ] **Step 4: Run dashboard and full validation**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/dashboard-order.test.ts \
  tests/dashboard-page.test.ts \
  tests/dashboard-metrics.test.ts
npm run check
npm test
npm run build
git diff --check
```

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/dashboard.ts tests/dashboard-order.test.ts
git commit -m "feat: prioritize dashboard review states"
```

## Task 7: Prove atomicity and restart semantics with PostgreSQL

**Files:**
- Create: `tests/postgres/fresh-start-cutoff.test.ts`
- Modify: `src/runtime/fresh-start.repository.ts` only when the real
  PostgreSQL assertions expose a repository defect

- [ ] **Step 1: Build an isolated PostgreSQL test harness**

Follow `tests/postgres/position-exit-policy.test.ts`: require
`TEST_DATABASE_URL`, create a unique schema with `schemaName`, set
`search_path`, apply migrations 001, 005, 006, 007, 008 and 009, and always
drop the schema in `finally`.

Construct `FreshStartRepository` with a schema-scoped database whose
`connect()` returns a real `pg.Client`.

- [ ] **Step 2: Add the all-status quarantine scenario**

Insert one valid `TokenSession` payload for every session status. Apply cutoff
100 with a real hash and assert:

```ts
const rows = await client.query<{
  status: string;
  payload_status: string;
  reason: string | null;
}>(`
  SELECT
    status,
    payload->>'status' AS payload_status,
    payload->>'rejectionReason' AS reason
  FROM token_sessions
  ORDER BY pair_address
`);

for (const row of rows.rows.filter(({ status }) => status === 'MANUAL_REVIEW')) {
  assert.equal(row.payload_status, 'MANUAL_REVIEW');
  assert.match(row.reason ?? '', /FRESH_START_CUTOFF/u);
}
```

Explicitly assert `CLOSED`, `REJECTED` and `EXPIRED` payloads and status columns
are unchanged.

- [ ] **Step 3: Add decision, checkpoint, journal and bigint assertions**

Insert `PENDING`, `EXECUTING`, `EXECUTED` and `FAILED` exit decisions, multiple
listener checkpoints below the candidate, and canonical blocks below it.
Apply cutoff `9_007_199_254_740_993n`. Assert:

- only `PENDING` and `EXECUTING` decisions are `MANUAL_REVIEW`;
- every checkpoint equals the exact cutoff and hash;
- `pair-created` exists;
- `canonical_blocks` contains exactly the cutoff header;
- the run row returns the exact numeric text;
- the stored quarantined counts match changed rows.

- [ ] **Step 4: Add rollback injection**

Wrap the schema-scoped database so `query()` throws when SQL contains
`UPDATE position_exit_decisions`. Capture table snapshots before the call,
assert rejection, then capture them again and assert deep equality for
sessions, decisions, checkpoints, canonical blocks and fresh-start runs.

- [ ] **Step 5: Add concurrent and successive launch coverage**

Run two repository instances concurrently with the same cutoff. Assert:

- exactly one operation succeeds and retains the session-level runtime lock;
- the other operation refuses to start without mutating any table;
- closing the first repository releases the lock;
- a later launch can then apply a monotonic cutoff without counting an already
  quarantined session or decision twice.

Then apply a strictly newer cutoff and assert it wins. Attempt an older cutoff
and a same-height different hash; both must reject without mutation.

- [ ] **Step 6: Run all PostgreSQL tests on a temporary instance**

When `TEST_DATABASE_URL` is absent:

```bash
task_pg_dir=$(mktemp -d /tmp/bsc-fresh-start-pg.XXXXXX)
/opt/homebrew/bin/initdb -D "$task_pg_dir/data" --auth=trust --no-locale
/opt/homebrew/bin/pg_ctl -D "$task_pg_dir/data" \
  -o "-p 55439 -h 127.0.0.1" -w start
/opt/homebrew/bin/createdb -h 127.0.0.1 -p 55439 bsc_listener_test
TEST_DATABASE_URL=postgresql://127.0.0.1:55439/bsc_listener_test \
  npm run test:postgres
/opt/homebrew/bin/pg_ctl -D "$task_pg_dir/data" -m fast -w stop
```

Expected: every PostgreSQL test passes, including fresh-start concurrency,
rollback and exact bigint scenarios.

- [ ] **Step 7: Run required validation and commit**

```bash
npm run check
npm test
npm run build
git diff --check
git add tests/postgres/fresh-start-cutoff.test.ts \
  src/runtime/fresh-start.repository.ts
git commit -m "test: cover fresh-start persistence"
```

## Task 8: Document operations and run final verification

**Files:**
- Modify: `README.md`
- Modify: `docs/strategy.md`
- Modify: focused source/test files from Tasks 1–7 only when final validation
  exposes a defect

- [ ] **Step 1: Add operator documentation**

Document these exact points in `README.md`:

- every launch starts at the current confirmed head;
- old blocks are never replayed;
- all prior non-terminal sessions become `MANUAL_REVIEW`;
- the bot never automatically resumes an old buy, approval or sell;
- history remains in PostgreSQL;
- a reorg crossing the cutoff blocks ingestion;
- `MANUAL_REVIEW` and `WAITING_FIRST_BUY` are pinned first in the dashboard;
- `EXECUTION_MODE=dry-run` remains the default.

Update `docs/strategy.md` with the ingestion rule:

```text
processable block number > latest committed fresh-start cutoff block number
```

and explain that runtime recovery applies only within the current process
lifetime; the next launch quarantines unfinished work.

- [ ] **Step 2: Run the focused feature suite**

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/fresh-start-repository.test.ts \
  tests/fresh-start-service.test.ts \
  tests/canonical-chain-coordinator.test.ts \
  tests/startup-order.test.ts \
  tests/position-exit-runtime.test.ts \
  tests/dashboard-order.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 3: Run mandatory project validation**

```bash
npm run check
npm test
npm run build
git diff --check
```

Expected: TypeScript strict check exits 0, all unit tests pass with 0 failures,
build exits 0 and diff check emits no output.

- [ ] **Step 4: Run mandatory PostgreSQL validation**

Run `npm run test:postgres` using `TEST_DATABASE_URL` or the temporary isolated
PostgreSQL procedure from Task 7.

Expected: all PostgreSQL tests pass with 0 failures.

- [ ] **Step 5: Perform the safety review**

Inspect:

```bash
git diff origin/main...HEAD
rg -n "PRIVATE_KEY|EXECUTION_MODE|RISK_POLICY|sendTransaction|writeContract" \
  src/runtime src/app.ts migrations/009_fresh_start_cutoff.sql
```

Verify:

- no secret is introduced;
- no live-mode default changes;
- cutoff code never calls a wallet client;
- session quarantine and checkpoints are in one transaction;
- no RPC error advances a checkpoint;
- no event at or below cutoff reaches a business callback;
- no previous-lifetime execution is resumed.

- [ ] **Step 6: Commit documentation or final corrections**

After rerunning `npm run check`, `npm test` and `npm run build`:

```bash
git add README.md docs/strategy.md
git commit -m "docs: explain mandatory fresh-start behavior"
```

- [ ] **Step 7: Confirm branch state**

```bash
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: only the user's pre-existing untracked `.idea/` and
`package-lock.json` may remain; all feature files are committed.
