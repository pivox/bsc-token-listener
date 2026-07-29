# Reset runtime database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a guarded command that clears all bot runtime data in one PostgreSQL transaction after the development process has stopped.

**Architecture:** Keep the destructive SQL in a small reusable TypeScript module. The CLI wrapper validates `--yes`, checks for a running `tsx watch src/app.ts` process, executes the reset through the existing `pg` dependency, and reports row counts. Configuration tables and schema metadata remain untouched.

**Tech Stack:** TypeScript strict ESM, Node `child_process`, `pg`, Node test runner, npm scripts.

---

### Task 1: Define reset behavior with tests

**Files:**
- Create: `tests/reset-runtime.test.ts`
- Create: `scripts/reset-runtime.ts`

- [x] **Step 1: Write failing tests for the guarded CLI helpers and deletion order**

Test that missing `--yes` returns a clear refusal, a matching development process is refused, and the generated deletion statements list dependent tables before `trades` and preserve configuration tables.

- [x] **Step 2: Run the focused test and verify it fails for the missing module**

Run: `node --import tsx --test tests/reset-runtime.test.ts`

Expected: FAIL because `scripts/reset-runtime.ts` does not yet export the tested helpers.

- [x] **Step 3: Implement pure helpers and the transactional reset function**

Export typed helpers for argument validation, process-line detection, and the ordered runtime table list. Implement a `resetRuntimeDatabase(database)` function that issues `BEGIN`, executes `DELETE FROM <table>` for each runtime table, commits, and rolls back/rethrows on error. Keep table names as a fixed internal allow-list; never interpolate user input.

- [x] **Step 4: Run the focused tests and verify they pass**

Run: `node --import tsx --test tests/reset-runtime.test.ts`

Expected: PASS.

### Task 2: Add the command-line entry point and npm script

**Files:**
- Modify: `package.json`
- Modify: `scripts/reset-runtime.ts`

- [x] **Step 1: Add the executable flow**

Load `dotenv/config`, require `--yes`, inspect `ps -ax -o command=` output for `tsx watch src/app.ts`, connect through `DATABASE_URL` using `pg.Pool`, run the transaction, print only table names and counts, and always close the pool. On failure set a non-zero exit code without printing environment variables.

- [x] **Step 2: Add the npm command**

Add `"db:reset-runtime": "tsx scripts/reset-runtime.ts"` to `package.json`.

- [x] **Step 3: Run the focused tests and type checks**

Run: `node --import tsx --test tests/reset-runtime.test.ts` and `npm run check`.

Expected: both commands exit 0.

### Task 3: Verify the repository and command safety

**Files:**
- No additional files.

- [x] **Step 1: Verify formatting and the complete test suite**

Run: `git diff --check` and `npm test`.

- [x] **Step 2: Verify production compilation**

Run: `npm run build`.

- [x] **Step 3: Inspect the final diff and confirm scope**

Run: `git status --short` and `git diff -- package.json scripts/reset-runtime.ts tests/reset-runtime.test.ts`.

Confirm no private key, secret, live-mode change, or unrelated database table is introduced.
