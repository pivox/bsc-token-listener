# Position Exit Policy Design

## Context

The current strategy keeps an entered session in `HOLDING` until the configured
number of subsequent buys is reached or a human requests a sale from the local
dashboard. It has no maximum holding duration, net stop-loss, take-profit,
trailing stop, periodic liquidity check, or recurring sellability probe.

Issue #9 adds continuous position supervision without weakening the existing
transaction-recovery guarantees. Exit signals must remain separate from trade
execution, all monetary calculations must use `bigint`, and live execution must
remain explicitly locked behind the existing execution mode and risk controls.

The user will clear application tables before using this feature, while
retaining migration history. The implementation must nevertheless keep every
new migration idempotent and safe for an existing populated database.

## Goals

- Evaluate every open `HOLDING` position periodically.
- Guarantee a maximum holding duration and a maximum-loss policy.
- Support fixed take-profit and an optional trailing stop.
- Detect material WBNB liquidity degradation.
- Re-run a read-only sellability probe periodically and immediately before any
  automatic sale.
- Keep exit evaluation deterministic and independent from execution.
- Persist the metrics, triggered rules, selected action, and execution outcome.
- Prevent concurrent sales from periodic, Swap-driven, and manual paths.
- Reconcile an interrupted exit before any possible rebroadcast.
- Expose all effective settings and position exit state in the dashboard.
- Allow local dashboard configuration through the existing explicit write lock.

## Non-goals

- Enabling live execution automatically.
- Sending transactions from the settings preview.
- Bypassing honeypot, anti-bot, tax, or gas protections.
- Mempool monitoring, front-running, or private transaction routing.
- Replacing transaction hash and nonce reconciliation.
- Automatically selling when sellability is unknown.

## Selected Policy

The selected policy is deliberately conservative:

- market evaluation every 15 seconds;
- maximum holding duration of 30 minutes;
- net stop-loss at 10% below economic entry cost;
- fixed take-profit at 20% above economic entry cost;
- abnormal liquidity drop at 20% below the entry reference;
- sellability probe every 60 seconds and immediately before a sale;
- normal exits rejected when estimated gas exceeds 10% of net position value;
- emergency exits ignore the relative gas ratio but retain an absolute
  `0.01 BNB` gas ceiling;
- trailing stop disabled by default;
- when enabled, trailing arms at +20% and sells after a 5% drawdown from the
  persisted peak;
- a liquidity emergency may sell only after a successful immediate probe;
- a negative or indeterminate probe always moves the session to
  `MANUAL_REVIEW`.

All values are strict environment defaults and editable through the local
dashboard form.

## Configuration

The following environment variables provide validated defaults:

| Variable | Default | Validation |
| --- | ---: | --- |
| `EXIT_MONITOR_INTERVAL_SECONDS` | `15` | integer, 5–300 |
| `EXIT_MAX_HOLDING_MINUTES` | `30` | integer, 1–10080 |
| `EXIT_STOP_LOSS_BPS` | `1000` | integer, 1–10000 |
| `EXIT_TAKE_PROFIT_BPS` | `2000` | integer, 1–100000 |
| `EXIT_LIQUIDITY_DROP_BPS` | `2000` | integer, 1–10000 |
| `EXIT_SAFETY_PROBE_INTERVAL_SECONDS` | `60` | integer, 15–3600 |
| `EXIT_QUOTE_BUFFER_BPS` | `1500` | integer, 0–5000 |
| `EXIT_MAX_GAS_VALUE_BPS` | `1000` | integer, 1–10000 |
| `EXIT_EMERGENCY_MAX_GAS_BNB` | `0.01` | positive decimal BNB |
| `EXIT_APPROVAL_GAS_UNITS` | `80000` | integer, 21000–1000000 |
| `EXIT_SELL_GAS_UNITS` | `350000` | integer, 21000–2000000 |
| `EXIT_TRAILING_STOP_ENABLED` | `false` | strict boolean |
| `EXIT_TRAILING_ACTIVATION_BPS` | `2000` | integer, 1–100000 |
| `EXIT_TRAILING_DRAWDOWN_BPS` | `500` | integer, 1–10000 |
| `TARGET_BUYS_AFTER_ENTRY` | `3` | integer, 1–1000 |

Cross-field validation rejects:

- a trailing drawdown greater than or equal to its activation gain;
- a probe interval shorter than the market evaluation interval;
- a zero or negative holding duration or gas ceiling;
- percentages outside their documented ranges;
- non-integer basis-point values;
- unknown fields in persisted or submitted settings.

Environment values are the immutable fallback. A PostgreSQL singleton override
has precedence. Resetting the form deletes the override and immediately
restores the environment defaults.

The existing target-buy value is part of the same dashboard form and settings
revision. The effective revision applies to open positions at their next
evaluation or Swap. The legacy `TokenSession.targetBuysAfterEntry` field is
updated to the effective value when the session is next persisted so existing
dashboard and recovery projections remain coherent.

## Architecture

### `ExitPolicySettingsProvider`

This component parses environment defaults, validates PostgreSQL overrides,
returns an immutable effective settings snapshot, and exposes its revision.
Every evaluation and preview uses one settings snapshot for its full duration.

### `PositionMetricsService`

This read-only service collects:

- current router quote for the exact token position;
- configured quote/slippage buffer;
- persisted or freshly measured sell tax;
- estimated approval and sell gas;
- current WBNB reserve and total pair liquidity;
- entry liquidity reference;
- last and current sellability-probe results;
- entry principal and confirmed entry gas.

It never mutates a session and never sends a transaction.

Exit gas is estimated from the current RPC fee recommendation and the
configured conservative approval/sell gas-unit budgets. This keeps dry-run and
live policy decisions equivalent without requiring a funded wallet merely to
evaluate a rule. The actual live transaction remains subject to the execution
gateway and its normal RPC validation.

### `ExitPolicyEvaluator`

This is a pure function accepting settings, persisted policy state, current
time, and a metrics snapshot. It returns:

- updated monitoring state;
- every rule that currently matches;
- one primary rule selected by deterministic priority;
- one action: `HOLD`, `SELL`, `EMERGENCY_SELL`, or `MANUAL_REVIEW`;
- an explicit explanation suitable for audit and dashboard display.

The evaluator performs no RPC, database, logging, or execution work.

### `PositionExitMonitor`

The monitor runs a serialized pass at the configured interval. It loads only
`HOLDING` sessions, evaluates each pair independently, persists updated
monitoring state, and submits actionable decisions to the engine. One pair
failure does not overlap or corrupt another pair, but database failures remain
visible and do not produce an execution.

The monitor participates in the existing runtime recovery barrier. Shutdown
stops new passes and drains the active pass before listeners and PostgreSQL are
closed.

### `SessionEngine.requestPolicyExit`

The engine remains the only path allowed to mutate a session and call
`TradeExecutor.sell`. `requestPolicyExit`:

1. enters the existing per-pair lock and runtime barrier;
2. reloads the session and decision;
3. rejects stale, duplicate, superseded, or already-exited requests;
4. performs the immediate probe, quote, and gas revalidation;
5. moves to `MANUAL_REVIEW` on unknown or negative sellability;
6. enforces normal or emergency gas policy;
7. marks the decision and session pending before calling the executor;
8. delegates transaction execution to the existing sell and recovery paths;
9. persists the final decision outcome.

The Swap buy-count rule and manual dashboard sale are routed through the same
locked exit primitive. This prevents two concurrent sales without duplicating
transaction logic.

## Economic Calculation

All calculations use integer wei and basis points.

Economic entry cost is:

```text
entryCostWei = entry.amountInWei + confirmedEntryGasWei
```

For dry-run or legacy entries without confirmed gas, entry gas is zero and the
dashboard marks the calculation as simulated or partial.

Prudent net exit value is:

```text
afterTaxWei = quoteWei × (10000 - sellTaxBps) / 10000
afterBufferWei = afterTaxWei × (10000 - quoteBufferBps) / 10000
netExitWei = max(0, afterBufferWei - estimatedExitGasWei)
```

Stop-loss and take-profit compare `netExitWei` to `entryCostWei`. No conversion
to JavaScript `number` is allowed for on-chain amounts.

Liquidity-drop comparison uses a WBNB reference persisted when the entry is
confirmed. The entry `TokenRiskReport` supplies the preferred reference. If it
has no usable liquidity value, the first successful post-entry measurement
becomes the reference; no liquidity emergency can fire before a reference is
known.

## Rule Semantics and Priority

All matching rules are retained in the audit. The primary rule and action use
this order:

1. `SELLABILITY_UNCERTAIN` or `SELLABILITY_BLOCKED` → `MANUAL_REVIEW`;
2. `LIQUIDITY_DROP` with a successful immediate probe →
   `EMERGENCY_SELL`;
3. `STOP_LOSS` → `SELL`;
4. `MAX_HOLDING_TIME` → `SELL`;
5. `TRAILING_STOP` → `SELL`;
6. `TAKE_PROFIT` → `SELL` when trailing is disabled;
7. `TARGET_BUYS` → `SELL`.

When trailing is enabled, reaching +20% arms it and updates the persisted peak;
it does not immediately execute the fixed take-profit. A subsequent 5%
drawdown from that peak triggers `TRAILING_STOP`.

Normal stop-loss, duration, take-profit, trailing, and target-buy exits obey
the 10% gas/value ratio. If this ratio is exceeded, the decision is persisted
as blocked and the session moves to `MANUAL_REVIEW`; it is never silently
ignored.

Liquidity emergency exits ignore the relative ratio, but an estimated gas cost
above `0.01 BNB` moves the session to `MANUAL_REVIEW`.

## Persistence Model

Migration `008_position_exit_policy.sql` is idempotent and creates:

### `strategy_settings`

- singleton key `position-exit-policy`;
- strictly validated JSON payload;
- monotonically increasing revision;
- creation and update timestamps.

### `strategy_settings_audit`

- immutable revision history;
- previous and next payloads;
- source `DASHBOARD` or `ENV_RESET`;
- creation timestamp.

### `position_exit_decisions`

- decision ID and unique idempotency key;
- pair and token addresses;
- settings revision;
- primary rule and all triggered rules;
- action and lifecycle status;
- full metrics snapshot with bigint-safe JSON encoding;
- reason and optional error type;
- optional related sell trade ID;
- creation, execution, and update timestamps.

Decision lifecycle statuses are:

- `PENDING`;
- `EXECUTING`;
- `EXECUTED`;
- `MANUAL_REVIEW`;
- `FAILED`;
- `SUPERSEDED`.

The `TokenSession` JSON payload gains an optional `exitPolicy` object:

- reference liquidity;
- latest and peak net value;
- latest evaluation and probe timestamps;
- next evaluation timestamp;
- trailing armed timestamp;
- last probe status;
- pending decision ID;
- latest primary rule and reason;
- stale/error indicator.

All new domain fields are covered by strict runtime validation. Malformed
persisted settings, decisions, or policy state fail closed.

## Crash and Restart Behaviour

- A `PENDING` decision is safe to evaluate again through its unique
  idempotency key.
- An `EXECUTING` decision with a `SELL_PENDING` session is reconciled through
  the existing trade hash/nonce recovery before any new action.
- A confirmed wallet sale is never reverted or replayed.
- An ambiguous transaction remains `MANUAL_REVIEW`.
- A recovered successful sale marks both session and decision complete.
- A reverted or provably undispatched sale returns through the existing
  recovery policy before another evaluation may decide whether to retry.
- Persisted trailing peak and liquidity reference survive restart.
- Startup completes transaction recovery before starting the exit monitor.

## Dashboard Form and API

The dashboard adds a “Politique de sortie” section with:

- every configurable setting and its unit;
- environment default, persisted override, and effective value;
- current settings revision;
- client-side range feedback;
- server-side strict validation;
- a preview button;
- an explicit confirmation before save;
- a reset-to-environment button.

The preview is read-only. It returns the validated candidate configuration and
the currently open positions whose existing metrics would match a rule. It
does not persist state, run a wallet transaction, or trigger a sale.

The API uses:

- `GET /api/dashboard/exit-policy`;
- `POST /api/dashboard/exit-policy/preview`;
- `PUT /api/dashboard/exit-policy`;
- `DELETE /api/dashboard/exit-policy`.

`PUT` and `DELETE` require the existing dashboard write-action lock and a
loopback-bound dashboard. They use optimistic revision matching; stale form
submissions return a conflict instead of overwriting newer settings. When
writes are disabled, the form remains visible but read-only.

Each accepted change persists an audit row in the same transaction as the
singleton update. The in-memory provider publishes the new immutable revision
only after commit.

## Dashboard Position State

Each open position exposes:

- next evaluation time;
- remaining maximum holding time;
- prudent net value and economic PnL;
- liquidity reference and current liquidity;
- stop-loss and take-profit levels;
- trailing enabled, armed state, and peak;
- last probe status and age;
- last matching rules and primary reason;
- settings revision used by the last evaluation;
- stale or manual-review diagnostic.

## Failure Handling

- Market quote, liquidity, or gas RPC failure records a stale policy state and
  performs no action.
- Periodic probe failure records `MANUAL_REVIEW`; it never becomes an automatic
  sale.
- Immediate pre-sale probe failure also records `MANUAL_REVIEW`.
- Database failure before decision commit produces no execution.
- Database failure after transaction submission preserves the existing
  unreconciled execution reference and is handled by crash recovery.
- Invalid settings never replace the last valid revision.
- One failing position does not overlap another position or hide the error.
- Shutdown drains the exit monitor and active engine operations.

## Test Strategy

### Unit tests

- strict environment and form settings validation;
- bigint net-value and PnL calculations;
- maximum holding expiry;
- stop-loss reached and not reached;
- fixed take-profit;
- trailing arm, peak update, drawdown, and restart state;
- liquidity reference initialization and drop;
- probe success, blocked, unknown, and interval scheduling;
- simultaneous rules and deterministic priority;
- normal gas ratio and emergency absolute ceiling;
- pure evaluator immutability and deterministic output.

### Engine and runtime tests

- periodic exit, Swap target-buy exit, and manual exit share one pair lock;
- two simultaneous decisions cannot execute two sales;
- stale decision is superseded after session reload;
- immediate quote/probe/gas revalidation occurs before sale;
- recovery barrier blocks evaluations during canonical recovery;
- shutdown stops and drains monitoring;
- restart resumes pending decisions without rebroadcast;
- transaction ambiguity results in `MANUAL_REVIEW`.

### Dashboard tests

- read-only rendering when writes are disabled;
- successful preview without mutation;
- strict server validation and unknown-field rejection;
- optimistic revision conflict;
- atomic save and reset audit;
- all effective values and position policy fields rendered.

### PostgreSQL tests

- migration 008 applied twice;
- singleton revision concurrency;
- settings and audit atomicity;
- decision idempotency;
- crash boundaries around pending/executing decisions;
- bigint-safe metrics persistence;
- recovery of a rule already triggered before restart.

### Required validation

```bash
npm run check
npm test
npm run build
```

PostgreSQL integration remains opt-in locally through `TEST_DATABASE_URL` and
must be reported honestly when unavailable.

## Documentation

`.env.example`, `README.md`, and `docs/strategy.md` document:

- every default and allowed range;
- the economic net-value formula;
- rule priority;
- trailing semantics;
- gas behavior for normal and emergency exits;
- sellability uncertainty and `MANUAL_REVIEW`;
- form write-lock behavior;
- restart and transaction-reconciliation guarantees;
- dry-run as the default and live activation as a separate human decision.

## Acceptance Criteria

- Every entered position has a maximum duration and stop-loss.
- Every actionable exit is persisted with metrics and triggered rules.
- Unknown sellability never causes an automatic transaction.
- Emergency liquidity exit requires a successful immediate probe.
- Gas policy cannot silently hide an emergency.
- Trailing peak, pending decisions, and settings survive restart.
- Periodic, Swap-driven, and manual exits cannot create concurrent sales.
- Form changes are strictly validated, revisioned, audited, and protected by
  the existing dashboard write lock.
- Dry-run and live evaluate the same rules.
- Live remains disabled by default.
- Check, tests, and build pass.
