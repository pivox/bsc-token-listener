# Trade Lifecycle Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist and expose the complete, real transaction lifecycle for buys,
approvals, and sells.

**Architecture:** Keep `trades` as business aggregates and add child on-chain
transactions. Prepare and sign with viem before broadcast so hash and nonce can be
persisted first. Isolate RPC and PostgreSQL behind injectable interfaces.

**Tech Stack:** TypeScript strict ESM, viem, PostgreSQL, Node test runner.

---

### Task 1: Domain model and accounting

**Files:** `src/types/domain.ts`, `src/execution/trade-accounting.ts`,
`tests/trade-accounting.test.ts`

- [ ] Write failing tests for gas, principal, proceeds, gross PnL, and net PnL.
- [ ] Run `npm test -- tests/trade-accounting.test.ts` and verify the missing API failure.
- [ ] Add explicit trade/transaction statuses, audit records, and bigint-only calculations.
- [ ] Run the focused test and `npm run check`.
- [ ] Commit the domain/accounting change.

### Task 2: PostgreSQL lifecycle repository

**Files:** `migrations/005_trade_lifecycle.sql`, `src/storage/repositories.ts`,
`tests/trade-repository.test.ts`

- [ ] Write failing repository tests for prepared, submitted, receipt, unknown, and failed transitions.
- [ ] Verify the tests fail because lifecycle methods are absent.
- [ ] Add the idempotent schema and atomic parent/child repository methods.
- [ ] Verify focused tests and type checking.
- [ ] Commit the persistence change.

### Task 3: Signed transaction gateway

**Files:** `src/execution/viem-execution.gateway.ts`,
`src/execution/execution.types.ts`, `tests/viem-execution-gateway.test.ts`

- [ ] Write a failing test proving hash and nonce are derived before broadcast.
- [ ] Verify the red state.
- [ ] Implement preparation, local signing, hash derivation, raw broadcast, receipt waits,
  quotes, allowance reads, and balance reads without logging signed bytes.
- [ ] Verify focused tests and type checking.
- [ ] Commit the gateway.

### Task 4: Audited buy and sell

**Files:** `src/execution/trade-executor.ts`, `src/abi/erc20.abi.ts`,
`tests/trade-executor.test.ts`

- [ ] Add failing tests for all issue #8 buy scenarios.
- [ ] Implement the minimal buy lifecycle and verify green.
- [ ] Add failing tests for exact-position sell and allowance scenarios.
- [ ] Implement approval and sell lifecycles and verify green.
- [ ] Add failing tests for ambiguous RPC and incomplete measurements.
- [ ] Implement typed errors and terminal persistence, then run the full suite.
- [ ] Commit the executor.

### Task 5: Session and dashboard integration

**Files:** `src/strategy/session-engine.ts`, `src/dashboard/dashboard.ts`,
`src/dashboard/dashboard.page.ts`, corresponding tests

- [ ] Write failing tests for manual review on uncertain execution.
- [ ] Implement the session transition without automatic redispatch.
- [ ] Write failing dashboard tests for gross PnL, gas, net PnL, and simulation labels.
- [ ] Update repository queries, snapshot types, and rendering.
- [ ] Run focused and full tests.
- [ ] Commit the integration.

### Task 6: PostgreSQL integration and documentation

**Files:** `tests/postgres-trade-lifecycle.test.ts`, `package.json`, `README.md`

- [ ] Add an opt-in `test:postgres` command using `TEST_DATABASE_URL`.
- [ ] Test migration execution twice, bigint round trips, and unique constraints.
- [ ] Document lifecycle states, audit queries, PnL, test command, and #7 boundary.
- [ ] Run all available verification commands.
- [ ] Commit documentation and integration coverage.

### Task 7: Final verification

- [ ] Run `npm run check`.
- [ ] Run `npm test`.
- [ ] Run `npm run test:postgres` when `TEST_DATABASE_URL` is available.
- [ ] Run `npm run build`.
- [ ] Review the diff against issue #8 and the design.
- [ ] Request code review and address all critical or important feedback.
