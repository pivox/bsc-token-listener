# Crash Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile interrupted risk checks, buys, approvals, and sells before listeners start and every 30 seconds without ever broadcasting an ambiguous transaction twice.

**Architecture:** A PostgreSQL-backed `RecoveryCoordinator` claims sessions with expiring leases and delegates deterministic decisions to a focused `SessionReconciler`. A read-only viem gateway observes transactions, receipts, and balances; short SQL transactions atomically apply session/trade/transaction/audit changes after RPC calls complete.

**Tech Stack:** TypeScript strict ESM, Node test runner, viem, PostgreSQL 16, existing repositories and trade-accounting helpers.

---

## File structure

- Create `migrations/006_crash_reconciliation.sql`: idempotent lease and audit schema.
- Create `src/recovery/recovery.types.ts`: snapshots, decisions, gateway and repository interfaces.
- Create `src/recovery/reconciliation-policy.ts`: pure state/receipt decision helpers.
- Create `src/recovery/viem-reconciliation.gateway.ts`: read-only viem adapter.
- Create `src/recovery/reconciliation.repository.ts`: PostgreSQL lock, lease, snapshot, atomic apply and audit.
- Create `src/recovery/session-reconciler.ts`: one-session orchestration and amount reconstruction.
- Create `src/recovery/recovery-coordinator.ts`: startup barrier and non-overlapping timer.
- Modify `src/types/domain.ts`: persistent recovery diagnostic types.
- Modify `src/storage/repositories.ts`: recovery-safe trade/risk lookup helpers.
- Modify `src/execution/execution.types.ts`: receipt lookup shape shared with recovery.
- Modify `src/execution/trade-executor.ts`: explicit methods for resuming proven transaction-free intentions.
- Modify `src/strategy/session-engine.ts`: expose guarded recovery entry points without listener events.
- Modify `src/config/env.ts`: configurable 30-second recovery interval and lease.
- Modify `src/app.ts`: initial barrier, post-recovery reload, periodic loop, shutdown ordering.
- Modify `src/heartbeat/heartbeat.ts` and `src/dashboard/dashboard.ts`: recovery diagnostics.
- Modify `README.md`: operator recovery procedure.
- Create `tests/reconciliation-policy.test.ts`.
- Create `tests/session-reconciler.test.ts`.
- Create `tests/recovery-coordinator.test.ts`.
- Create `tests/postgres/crash-reconciliation.test.ts`.
- Modify `tests/trade-executor.test.ts`, `tests/heartbeat.test.ts`, and `tests/dashboard-page.test.ts`.

### Task 1: Add the idempotent recovery schema

**Files:**
- Create: `migrations/006_crash_reconciliation.sql`
- Create: `tests/postgres/crash-reconciliation.test.ts`

- [ ] **Step 1: Write the failing PostgreSQL migration test**

Create a temporary schema with minimal `token_sessions`, `trades`, and
`trade_transactions` tables. Run migration 006 twice and assert:

```ts
const columns = await client.query<{ column_name: string }>(`
  SELECT column_name
  FROM information_schema.columns
  WHERE table_schema = $1 AND table_name = 'token_sessions'
`, [schema]);
assert.deepEqual(
  new Set(columns.rows.map((row) => row.column_name)),
  new Set([
    'pair_address', 'token_address', 'status', 'payload', 'created_at', 'updated_at',
    'recovery_owner', 'recovery_lease_until', 'recovery_attempts',
    'recovery_error', 'last_reconciled_at',
  ]),
);
const decisions = await client.query(`
  SELECT 1 FROM information_schema.tables
  WHERE table_schema = $1 AND table_name = 'reconciliation_decisions'
`, [schema]);
assert.equal(decisions.rowCount, 1);
```

- [ ] **Step 2: Run the PostgreSQL test and verify it fails**

Run:

```bash
TEST_DATABASE_URL=postgresql://bscbot:bscbot@127.0.0.1:55432/bscbot \
  npm run test:postgres
```

Expected: FAIL because `migrations/006_crash_reconciliation.sql` does not exist.

- [ ] **Step 3: Add the migration**

Create:

```sql
ALTER TABLE token_sessions ADD COLUMN IF NOT EXISTS recovery_owner TEXT;
ALTER TABLE token_sessions ADD COLUMN IF NOT EXISTS recovery_lease_until TIMESTAMPTZ;
ALTER TABLE token_sessions
  ADD COLUMN IF NOT EXISTS recovery_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE token_sessions ADD COLUMN IF NOT EXISTS recovery_error TEXT;
ALTER TABLE token_sessions ADD COLUMN IF NOT EXISTS last_reconciled_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_token_sessions_recovery
  ON token_sessions(status, recovery_lease_until);

CREATE TABLE IF NOT EXISTS reconciliation_decisions (
  decision_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  pair_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  status_before TEXT NOT NULL,
  status_after TEXT NOT NULL,
  action TEXT NOT NULL,
  trade_id TEXT,
  transaction_hash TEXT,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_decisions_pair
  ON reconciliation_decisions(pair_address, created_at);
```

- [ ] **Step 4: Re-run the PostgreSQL test**

Expected: PASS, including the second migration execution.

- [ ] **Step 5: Commit**

```bash
git add migrations/006_crash_reconciliation.sql tests/postgres/crash-reconciliation.test.ts
git commit -m "feat: add crash reconciliation schema"
```

### Task 2: Define recovery contracts and pure decisions

**Files:**
- Create: `src/recovery/recovery.types.ts`
- Create: `src/recovery/reconciliation-policy.ts`
- Create: `tests/reconciliation-policy.test.ts`
- Modify: `src/types/domain.ts`

- [ ] **Step 1: Write failing policy tests**

Cover transaction-free resume, pending, success, revert, absent and RPC error:

```ts
assert.deepEqual(
  decideTransactionRecovery({ hasTransaction: false, observation: null }),
  { kind: 'RESUME_INTENT' },
);
assert.deepEqual(
  decideTransactionRecovery({
    hasTransaction: true,
    observation: { kind: 'PENDING' },
  }),
  { kind: 'WAIT', reason: 'Transaction encore pending.' },
);
assert.deepEqual(
  decideTransactionRecovery({
    hasTransaction: true,
    observation: { kind: 'ABSENT' },
  }),
  { kind: 'MANUAL_REVIEW', reason: 'Hash absent du RPC.' },
);
assert.deepEqual(
  decideTransactionRecovery({
    hasTransaction: true,
    observation: { kind: 'RPC_ERROR', errorType: 'HttpRequestError' },
  }),
  { kind: 'MANUAL_REVIEW', reason: 'Lecture RPC impossible (HttpRequestError).' },
);
```

- [ ] **Step 2: Run the unit test and verify it fails**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test tests/reconciliation-policy.test.ts
```

Expected: FAIL because the policy module is missing.

- [ ] **Step 3: Define the contracts**

Add recovery diagnostics to `TokenSession`:

```ts
export interface SessionRecoveryDiagnostic {
  attempts: number;
  lastAction: string;
  lastReason: string;
  lastAttemptAtMs: number;
}

export interface TokenSession {
  // existing fields
  recovery?: SessionRecoveryDiagnostic;
}
```

Define focused types:

```ts
export type ChainObservation =
  | { kind: 'PENDING' }
  | { kind: 'ABSENT' }
  | { kind: 'RPC_ERROR'; errorType: string }
  | { kind: 'RECEIPT'; receipt: ExecutionReceipt };

export type TransactionRecoveryDecision =
  | { kind: 'RESUME_INTENT' }
  | { kind: 'WAIT'; reason: string }
  | { kind: 'MEASURE'; receipt: ExecutionReceipt }
  | { kind: 'REVERT'; receipt: ExecutionReceipt }
  | { kind: 'MANUAL_REVIEW'; reason: string };

export interface ReconciliationGateway {
  observeTransaction(hash: Hash): Promise<ChainObservation>;
  getNativeBalance(wallet: Address): Promise<bigint>;
  getTokenBalance(token: Address, wallet: Address): Promise<bigint>;
}
```

- [ ] **Step 4: Implement the pure policy**

```ts
export function decideTransactionRecovery(input: {
  hasTransaction: boolean;
  observation: ChainObservation | null;
}): TransactionRecoveryDecision {
  if (!input.hasTransaction) return { kind: 'RESUME_INTENT' };
  if (!input.observation) {
    return { kind: 'MANUAL_REVIEW', reason: 'Observation on-chain manquante.' };
  }
  if (input.observation.kind === 'PENDING') {
    return { kind: 'WAIT', reason: 'Transaction encore pending.' };
  }
  if (input.observation.kind === 'ABSENT') {
    return { kind: 'MANUAL_REVIEW', reason: 'Hash absent du RPC.' };
  }
  if (input.observation.kind === 'RPC_ERROR') {
    return {
      kind: 'MANUAL_REVIEW',
      reason: `Lecture RPC impossible (${input.observation.errorType}).`,
    };
  }
  return input.observation.receipt.status === 'success'
    ? { kind: 'MEASURE', receipt: input.observation.receipt }
    : { kind: 'REVERT', receipt: input.observation.receipt };
}
```

- [ ] **Step 5: Run tests and commit**

Expected: policy test and `npm run check` PASS.

```bash
git add src/types/domain.ts src/recovery tests/reconciliation-policy.test.ts
git commit -m "feat: define deterministic recovery decisions"
```

### Task 3: Add the read-only viem observation gateway

**Files:**
- Create: `src/recovery/viem-reconciliation.gateway.ts`
- Create: `tests/viem-reconciliation-gateway.test.ts`
- Modify: `src/execution/execution.types.ts`

- [ ] **Step 1: Write failing adapter tests**

Inject a fake public client and cover a receipt, a pending transaction, not found,
and a transport failure:

```ts
const gateway = new ViemReconciliationGateway(fakeClient);
assert.equal((await gateway.observeTransaction(HASH)).kind, 'RECEIPT');
assert.equal((await pendingGateway.observeTransaction(HASH)).kind, 'PENDING');
assert.equal((await absentGateway.observeTransaction(HASH)).kind, 'ABSENT');
assert.deepEqual(
  await failingGateway.observeTransaction(HASH),
  { kind: 'RPC_ERROR', errorType: 'HttpRequestError' },
);
```

- [ ] **Step 2: Run the adapter test and verify it fails**

Expected: FAIL because `ViemReconciliationGateway` does not exist.

- [ ] **Step 3: Implement receipt conversion and safe error classification**

```ts
export class ViemReconciliationGateway implements ReconciliationGateway {
  constructor(private readonly client: ReconciliationPublicClient = publicClient) {}

  async observeTransaction(hash: Hash): Promise<ChainObservation> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash });
      return {
        kind: 'RECEIPT',
        receipt: {
          status: receipt.status,
          blockNumber: receipt.blockNumber,
          transactionIndex: receipt.transactionIndex,
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
        },
      };
    } catch (receiptError) {
      if (!isTransactionNotFound(receiptError)) {
        return { kind: 'RPC_ERROR', errorType: safeErrorType(receiptError) };
      }
    }
    try {
      await this.client.getTransaction({ hash });
      return { kind: 'PENDING' };
    } catch (transactionError) {
      return isTransactionNotFound(transactionError)
        ? { kind: 'ABSENT' }
        : { kind: 'RPC_ERROR', errorType: safeErrorType(transactionError) };
    }
  }

  getNativeBalance(wallet: Address): Promise<bigint> {
    return this.client.getBalance({ address: wallet });
  }

  getTokenBalance(token: Address, wallet: Address): Promise<bigint> {
    return this.client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [wallet],
    });
  }
}
```

Use viem's `TransactionReceiptNotFoundError` and `TransactionNotFoundError`
classes for absence checks. Persist only `error.name`, never `error.message`.

- [ ] **Step 4: Run adapter tests, check, and commit**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/viem-reconciliation-gateway.test.ts
npm run check
git add src/recovery/viem-reconciliation.gateway.ts \
  src/execution/execution.types.ts tests/viem-reconciliation-gateway.test.ts
git commit -m "feat: observe transactions for reconciliation"
```

### Task 4: Implement PostgreSQL claims, snapshots, and atomic decisions

**Files:**
- Create: `src/recovery/reconciliation.repository.ts`
- Create: `tests/reconciliation-repository.test.ts`
- Extend: `tests/postgres/crash-reconciliation.test.ts`
- Modify: `src/storage/repositories.ts`

- [ ] **Step 1: Write failing repository tests**

Use a recording database fake to verify:

```ts
const claimed = await repository.claimNext('worker-1', 30_000);
assert.equal(claimed?.session.status, 'BUY_PENDING');
assert.match(database.calls[0]?.sql ?? '', /FOR UPDATE SKIP LOCKED/u);
assert.match(database.calls[0]?.sql ?? '', /recovery_lease_until/u);

await repository.applyDecision(claimed!, decision);
assert.ok(database.calls.some((call) => /reconciliation_decisions/u.test(call.sql)));
assert.ok(database.calls.some((call) => /recovery_owner = \\$2/u.test(call.sql)));
```

The PostgreSQL test starts two claims concurrently and asserts only one receives
the same pair.

- [ ] **Step 2: Run repository and PostgreSQL tests and verify failures**

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement claim and snapshot loading**

The claim transaction must use:

```sql
WITH candidate AS (
  SELECT pair_address
  FROM token_sessions
  WHERE status IN ('RISK_CHECKING', 'BUY_PENDING', 'SELL_PENDING', 'MANUAL_REVIEW')
    AND (recovery_lease_until IS NULL OR recovery_lease_until < NOW())
  ORDER BY updated_at
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
UPDATE token_sessions s
SET recovery_owner = $1,
    recovery_lease_until = NOW() + ($2::text || ' milliseconds')::interval,
    recovery_attempts = recovery_attempts + 1
FROM candidate
WHERE s.pair_address = candidate.pair_address
RETURNING s.payload, s.status;
```

Load trades ordered by `created_at`, then transactions ordered by
`created_at`, parsing their JSON payloads with `parseJson`.

- [ ] **Step 4: Implement guarded atomic application**

Within `BEGIN`/`COMMIT`:

```sql
UPDATE token_sessions
SET status = $3,
    payload = $4::jsonb,
    recovery_owner = NULL,
    recovery_lease_until = NULL,
    recovery_error = $5,
    last_reconciled_at = NOW(),
    updated_at = NOW()
WHERE pair_address = $1
  AND recovery_owner = $2
  AND status = $6
RETURNING pair_address;
```

Require exactly one returned row before saving any trade/transaction update and
insert the audit with `ON CONFLICT (idempotency_key) DO NOTHING`.

- [ ] **Step 5: Add advisory pass locking**

Expose:

```ts
async tryAcquirePassLock(): Promise<boolean>;
async releasePassLock(): Promise<void>;
```

using `pg_try_advisory_lock(707_007_007)` and
`pg_advisory_unlock(707_007_007)` on the same checked-out client.

- [ ] **Step 6: Run tests and commit**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/reconciliation-repository.test.ts
TEST_DATABASE_URL=postgresql://bscbot:bscbot@127.0.0.1:55432/bscbot \
  npm run test:postgres
npm run check
git add src/recovery/reconciliation.repository.ts src/storage/repositories.ts \
  tests/reconciliation-repository.test.ts tests/postgres/crash-reconciliation.test.ts
git commit -m "feat: claim and persist recovery decisions"
```

### Task 5: Reconcile existing BUY, APPROVE, and SELL transactions

**Files:**
- Create: `src/recovery/session-reconciler.ts`
- Create: `tests/session-reconciler.test.ts`
- Modify: `src/execution/trade-accounting.ts`

- [ ] **Step 1: Write failing reconciler tests**

Build in-memory repository/gateway fakes and assert:

```ts
await reconciler.reconcile(buyPendingWithConfirmedBuy);
assert.equal(repository.applied.at(-1)?.session.status, 'HOLDING');
assert.equal(repository.applied.at(-1)?.session.entry?.transactionHash, BUY_HASH);

await reconciler.reconcile(sellPendingWithConfirmedSell);
assert.equal(repository.applied.at(-1)?.session.status, 'CLOSED');
assert.equal(repository.applied.at(-1)?.session.exit?.transactionHash, SELL_HASH);

await reconciler.reconcile(unknownSell);
assert.equal(repository.applied.at(-1)?.session.status, 'MANUAL_REVIEW');
assert.equal(execution.sellCalls, 0);
```

Also test BUY revert → `REJECTED`, SELL revert → `HOLDING`, pending → unchanged,
confirmed receipt with failed balance read → `MANUAL_REVIEW`, and approval
success/revert/ambiguous before SELL.

- [ ] **Step 2: Run tests and verify they fail**

Expected: FAIL because `SessionReconciler` is missing.

- [ ] **Step 3: Implement transaction selection**

Select the latest trade for the session side. For SELL, order transaction steps
and reconcile `APPROVE` before `SELL`. A transaction record always disables
automatic re-preparation for that same step.

```ts
const transaction = snapshot.transactions
  .filter((candidate) => candidate.tradeId === trade.id)
  .sort((left, right) => left.createdAtMs - right.createdAtMs)
  .at(-1);
const observation = transaction
  ? await this.gateway.observeTransaction(transaction.transactionHash)
  : null;
const decision = decideTransactionRecovery({
  hasTransaction: transaction !== undefined,
  observation,
});
```

- [ ] **Step 4: Implement BUY reconstruction**

After a success receipt, read native/token balances and reuse:

```ts
const gasCostWei = calculateGasCost(receipt.gasUsed, receipt.effectiveGasPrice);
const amountOutToken =
  tokenBalanceAfter - requireBalance(transaction.tokenBalanceBefore, 'token before');
const amountInWei = calculateBuyPrincipal(
  requireBalance(transaction.nativeBalanceBefore, 'native before'),
  nativeBalanceAfter,
  gasCostWei,
);
```

Update receipt fields, actual trade amounts, gas, `session.entry`, status
`HOLDING`, and clear `unreconciledExecution`.

- [ ] **Step 5: Implement SELL reconstruction**

```ts
const sellGasWei = calculateGasCost(receipt.gasUsed, receipt.effectiveGasPrice);
const amountInToken =
  requireBalance(transaction.tokenBalanceBefore, 'token before') - tokenBalanceAfter;
const amountOutWei = calculateSellProceeds(
  requireBalance(transaction.nativeBalanceBefore, 'native before'),
  nativeBalanceAfter,
  sellGasWei,
);
```

Add confirmed approval gas from the same trade, update `session.exit`, and set
`CLOSED`.

- [ ] **Step 6: Implement safe failure transitions**

- BUY revert: `REJECTED`.
- SELL revert: `HOLDING`.
- pending: preserve current status and diagnostic.
- absent/RPC failure/invalid balance delta: `MANUAL_REVIEW` with
  `ExecutionReconciliationReference`.
- Never call an execution method when a transaction exists.

- [ ] **Step 7: Run tests and commit**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/session-reconciler.test.ts
npm run check
git add src/recovery/session-reconciler.ts src/execution/trade-accounting.ts \
  tests/session-reconciler.test.ts
git commit -m "feat: reconcile persisted blockchain transactions"
```

### Task 6: Resume proven transaction-free intentions and risk checks

**Files:**
- Modify: `src/recovery/session-reconciler.ts`
- Modify: `src/strategy/session-engine.ts`
- Modify: `src/storage/repositories.ts`
- Test: `tests/session-reconciler.test.ts`
- Test: `tests/trade-executor.test.ts`

- [ ] **Step 1: Add failing resume tests**

Assert:

```ts
await reconciler.reconcile(riskChecking);
assert.equal(risk.analyzeCalls, 1);
assert.equal(reports.saved[0]?.verdict, 'ALLOW');
assert.equal(execution.buyCalls, 1);

await reconciler.reconcile(buyPendingWithoutTransaction);
assert.equal(execution.buyCalls, 1);

await reconciler.reconcile(buyPendingWithCreatedTransaction);
assert.equal(execution.buyCalls, 0);

await reconciler.reconcile(sellPendingWithoutTransaction);
assert.equal(execution.sellCalls, 1);
```

Add a negative test proving `allow-only` rejects a non-ALLOW report before
calling buy.

- [ ] **Step 2: Run tests and verify failures**

Expected: FAIL because recovery entry points do not exist.

- [ ] **Step 3: Add guarded engine methods**

Expose methods that do not depend on a listener event:

```ts
async resumeRiskAndBuy(session: TokenSession): Promise<void>;
async resumeBuy(session: TokenSession, report: TokenRiskReport): Promise<void>;
async resumeSell(session: TokenSession): Promise<void>;
```

Each method:

- requires the expected session status;
- requires a persisted report ID and `ALLOW` for entry under `allow-only`;
- calls the existing amount service/executor paths;
- persists normal success/failure states;
- does not accept a caller-provided hash, nonce, or serialized transaction.

- [ ] **Step 4: Make report/session persistence atomic for recovery**

Add a repository transaction that saves the risk report and changes
`RISK_CHECKING` → `BUY_PENDING` under the active lease. Do not call buy until
this transaction commits.

- [ ] **Step 5: Implement dry-run idempotence**

When a matching `SIMULATED` trade exists, rebuild `entry` or `exit` from its
payload. Only call dry-run execution when no matching simulated trade exists.

- [ ] **Step 6: Run tests and commit**

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/session-reconciler.test.ts tests/trade-executor.test.ts
npm run check
git add src/recovery/session-reconciler.ts src/strategy/session-engine.ts \
  src/storage/repositories.ts tests/session-reconciler.test.ts \
  tests/trade-executor.test.ts
git commit -m "feat: resume transaction-free trade intentions"
```

### Task 7: Add the startup barrier and periodic coordinator

**Files:**
- Create: `src/recovery/recovery-coordinator.ts`
- Create: `tests/recovery-coordinator.test.ts`
- Modify: `src/config/env.ts`
- Modify: `src/app.ts`

- [ ] **Step 1: Write failing coordinator tests**

Use deferred promises to prove ordering:

```ts
const initial = coordinator.reconcileInitial();
assert.equal(listeners.started, false);
reconcileDeferred.resolve();
await initial;
await startListeners();
assert.equal(listeners.started, true);
```

Use a fake clock/timer to trigger two ticks while the first is running and
assert `maxConcurrentPasses === 1`. Verify `stop()` cancels future passes.

- [ ] **Step 2: Run tests and verify failures**

Expected: FAIL because the coordinator is missing.

- [ ] **Step 3: Implement the coordinator**

```ts
export class RecoveryCoordinator {
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  async reconcileInitial(): Promise<void> {
    await this.runPass();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runPass().catch((error: unknown) => {
        logger.error({ errorType: safeErrorType(error) }, 'Réconciliation périodique échouée.');
      });
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async runPass(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.executePass();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }
}
```

`executePass` acquiert le verrou global, réclame jusqu'à épuisement, puis libère
le verrou dans `finally`.

- [ ] **Step 4: Add configuration**

```ts
recoveryIntervalSeconds: readInteger(
  'RECOVERY_INTERVAL_SECONDS',
  30,
  5,
  300,
),
recoveryLeaseSeconds: readInteger(
  'RECOVERY_LEASE_SECONDS',
  60,
  15,
  600,
),
```

- [ ] **Step 5: Integrate the startup barrier**

In `app.ts`, after constructing services and before `sessions.loadActive()`:

```ts
await recovery.reconcileInitial();
const restored = await sessions.loadActive();
for (const session of restored) await startMonitor(session);
await pairListener.start();
recovery.start();
```

During shutdown:

```ts
recovery.stop();
clearInterval(heartbeatInterval);
pairListener.stop();
```

- [ ] **Step 6: Run tests and commit**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/recovery-coordinator.test.ts
npm run check
npm test
git add src/recovery/recovery-coordinator.ts src/config/env.ts src/app.ts \
  tests/recovery-coordinator.test.ts
git commit -m "feat: reconcile before starting listeners"
```

### Task 8: Expose diagnostics and document operations

**Files:**
- Modify: `src/heartbeat/heartbeat.ts`
- Modify: `src/dashboard/dashboard.ts`
- Modify: `src/dashboard/dashboard.page.ts`
- Modify: `tests/heartbeat.test.ts`
- Modify: `tests/dashboard-page.test.ts`
- Modify: `README.md`

- [ ] **Step 1: Write failing heartbeat/dashboard tests**

Assert recovery data is exposed:

```ts
assert.deepEqual(snapshot.recovery, {
  running: false,
  pendingSessions: 2,
  manualReviewSessions: 1,
  lastCompletedAt: '2026-07-28T10:00:00.000Z',
});
assert.match(renderDashboardPage('nonce', 5), /recovery-pending/u);
assert.match(renderDashboardPage('nonce', 5), /recovery-manual-review/u);
```

- [ ] **Step 2: Run tests and verify failures**

Expected: FAIL because recovery heartbeat fields are absent.

- [ ] **Step 3: Add coordinator status projection**

Expose a read-only status object:

```ts
export interface RecoveryStatus {
  running: boolean;
  pendingSessions: number;
  manualReviewSessions: number;
  lastCompletedAt: string | null;
  lastErrorType: string | null;
}
```

Inject a getter into heartbeat/dashboard services. Do not expose lease owner or
raw errors.

- [ ] **Step 4: Update the README**

Document:

- mandatory startup barrier;
- 30-second default and environment variables;
- state-by-state recovery behavior;
- how to inspect a hash before manual action;
- explicit prohibition on rediffusing an ambiguous hash;
- dry-run behavior and PostgreSQL audit query.

- [ ] **Step 5: Run tests and commit**

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/heartbeat.test.ts tests/dashboard-page.test.ts
npm run check
git add src/heartbeat src/dashboard README.md tests/heartbeat.test.ts \
  tests/dashboard-page.test.ts
git commit -m "docs: expose and document crash recovery"
```

### Task 9: Complete end-to-end verification

**Files:**
- Modify as required by failures only.

- [ ] **Step 1: Run all static and unit validation**

```bash
npm run check
npm test
npm run build
```

Expected: all commands exit 0 and all unit tests pass.

- [ ] **Step 2: Run PostgreSQL 16 integration from a fresh container**

```bash
docker run --rm -d --name bsc-token-listener-issue7-postgres \
  -e POSTGRES_DB=bscbot \
  -e POSTGRES_USER=bscbot \
  -e POSTGRES_PASSWORD=bscbot \
  -p 55432:5432 postgres:16-alpine
TEST_DATABASE_URL=postgresql://bscbot:bscbot@127.0.0.1:55432/bscbot \
  npm run test:postgres
docker stop bsc-token-listener-issue7-postgres
```

Expected: migration idempotence, lease concurrency, atomic decisions, and audit
deduplication all pass.

- [ ] **Step 3: Verify safety invariants**

```bash
rg -n "serializedTransaction|PRIVATE_KEY|seed phrase" \
  src/recovery tests README.md
git diff --check
git status --short
```

Expected: `serializedTransaction` appears only in negative assertions or
documentation explaining that it is prohibited; no secret value exists; diff
check is clean.

- [ ] **Step 4: Commit final verification fixes**

If verification required changes:

```bash
git add src tests migrations README.md
git commit -m "test: complete crash recovery coverage"
```

If no changes were needed, do not create an empty commit.

- [ ] **Step 5: Prepare the PR**

Push `feat/crash-reconciliation`, create a PR with `Closes #7`, list every crash
window tested, request `@codex` review, address all blocking threads, and merge
only with green checks and no unresolved review thread.
