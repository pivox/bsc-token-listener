# Configurable Position Exit Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, configurable, continuously evaluated position-exit policy with safe dashboard editing, crash recovery, and one locked sale path.

**Architecture:** A pure evaluator consumes immutable settings, persisted per-position state, and read-only metrics. A serialized monitor collects metrics and submits idempotent decisions to `SessionEngine`, which remains the only component allowed to mutate sessions or call `TradeExecutor.sell`. PostgreSQL stores settings revisions, change audit, and exit-decision lifecycle; the local dashboard exposes previewed, revision-safe overrides.

**Tech Stack:** TypeScript strict ESM, viem, PostgreSQL idempotent SQL migrations, Node test runner, existing runtime recovery barrier, action dashboard, `SessionEngine`, and `TradeExecutor`.

---

## File Map

### New production files

- `src/strategy/position-exit-settings.ts` — settings shape, environment defaults, strict parsing, and cross-field validation.
- `src/strategy/position-exit.types.ts` — evaluator, metrics, state, decision, and audit types.
- `src/strategy/position-exit-evaluator.ts` — pure bigint rule evaluation.
- `src/strategy/position-metrics.service.ts` — read-only quote, liquidity, fee, probe, and gas collection.
- `src/strategy/position-exit.repository.ts` — settings, audit, and decision persistence.
- `src/strategy/position-exit-settings.provider.ts` — environment fallback, immutable effective revision, and post-commit publication.
- `src/strategy/position-exit-monitor.ts` — serialized periodic monitoring.
- `src/security/safety-probe.service.ts` — reusable read-only SafetyProbe adapter.
- `src/dashboard/exit-policy-controls.ts` — CSP-safe form HTML/CSS/JavaScript injection.
- `src/dashboard/exit-policy.service.ts` — preview, revision-safe update/reset, and dashboard settings DTOs.
- `src/runtime/position-exit-runtime.ts` — monitor lifecycle and shutdown drain helper.
- `migrations/008_position_exit_policy.sql` — idempotent settings/audit/decision schema.

### Existing production files to modify

- `src/config/env.ts`
- `src/types/domain.ts`
- `src/types/domain-validation.ts`
- `src/security/token-risk.service.ts`
- `src/storage/repositories.ts`
- `src/strategy/session-engine.ts`
- `src/app.ts`
- `src/runtime/runtime-shutdown.ts`
- `src/dashboard/action-dashboard.ts`
- `src/dashboard/dashboard.ts`
- `src/dashboard/dashboard.page.ts`
- `.env.example`
- `README.md`
- `docs/strategy.md`

### New test files

- `tests/position-exit-settings.test.ts`
- `tests/position-exit-evaluator.test.ts`
- `tests/position-exit-repository.test.ts`
- `tests/position-metrics-service.test.ts`
- `tests/position-exit-engine.test.ts`
- `tests/position-exit-monitor.test.ts`
- `tests/position-exit-runtime.test.ts`
- `tests/exit-policy-dashboard.test.ts`
- `tests/postgres/position-exit-policy.test.ts`

---

### Task 1: Strict Exit-Policy Settings

**Files:**
- Create: `src/strategy/position-exit-settings.ts`
- Create: `tests/position-exit-settings.test.ts`
- Modify: `src/config/env.ts`

- [ ] **Step 1: Write failing settings tests**

Cover defaults, every range, unknown fields, decimal basis points, probe
interval shorter than monitor interval, trailing drawdown greater than or equal
to activation, and immutable returned snapshots.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultPositionExitSettings,
  parsePositionExitSettings,
} from '../src/strategy/position-exit-settings.js';

test('expose le profil très prudent validé', () => {
  const value = defaultPositionExitSettings();
  assert.equal(value.monitorIntervalSeconds, 15);
  assert.equal(value.maxHoldingMinutes, 30);
  assert.equal(value.stopLossBps, 1_000);
  assert.equal(value.takeProfitBps, 2_000);
  assert.equal(value.liquidityDropBps, 2_000);
  assert.equal(value.probeIntervalSeconds, 60);
  assert.equal(value.trailingEnabled, false);
  assert.equal(value.trailingActivationBps, 2_000);
  assert.equal(value.trailingDrawdownBps, 500);
  assert.equal(value.maxGasValueBps, 1_000);
  assert.equal(value.emergencyMaxGasWei, 10_000_000_000_000_000n);
  assert.equal(value.approvalGasUnits, 80_000n);
  assert.equal(value.sellGasUnits, 350_000n);
  assert.equal(value.targetBuysAfterEntry, 3);
});

test('rejette un payload inconnu ou incohérent', () => {
  assert.throws(
    () => parsePositionExitSettings({
      ...defaultPositionExitSettings(),
      unknown: true,
    }),
    /inconnu/u,
  );
  assert.throws(
    () => parsePositionExitSettings({
      ...defaultPositionExitSettings(),
      monitorIntervalSeconds: 60,
      probeIntervalSeconds: 15,
    }),
    /probe/u,
  );
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-exit-settings.test.ts
```

Expected: FAIL because `position-exit-settings.ts` does not exist.

- [ ] **Step 3: Implement the complete settings contract**

Define this exact public shape and return defensive frozen snapshots:

```ts
export interface PositionExitSettings {
  monitorIntervalSeconds: number;
  maxHoldingMinutes: number;
  stopLossBps: number;
  takeProfitBps: number;
  liquidityDropBps: number;
  probeIntervalSeconds: number;
  quoteBufferBps: number;
  maxGasValueBps: number;
  emergencyMaxGasWei: bigint;
  approvalGasUnits: bigint;
  sellGasUnits: bigint;
  trailingEnabled: boolean;
  trailingActivationBps: number;
  trailingDrawdownBps: number;
  targetBuysAfterEntry: number;
}

export function defaultPositionExitSettings(): Readonly<PositionExitSettings>;
export function parsePositionExitSettings(
  value: unknown,
): Readonly<PositionExitSettings>;
```

In `src/config/env.ts`, parse the documented `EXIT_*` variables and pass the
result through `parsePositionExitSettings`. Keep
`EXECUTION_MODE=dry-run` unchanged.

```ts
const positionExitSettings = parsePositionExitSettings({
  monitorIntervalSeconds: readInteger('EXIT_MONITOR_INTERVAL_SECONDS', 15, 5, 300),
  maxHoldingMinutes: readInteger('EXIT_MAX_HOLDING_MINUTES', 30, 1, 10_080),
  stopLossBps: readInteger('EXIT_STOP_LOSS_BPS', 1_000, 1, 10_000),
  takeProfitBps: readInteger('EXIT_TAKE_PROFIT_BPS', 2_000, 1, 100_000),
  liquidityDropBps: readInteger('EXIT_LIQUIDITY_DROP_BPS', 2_000, 1, 10_000),
  probeIntervalSeconds: readInteger(
    'EXIT_SAFETY_PROBE_INTERVAL_SECONDS',
    60,
    15,
    3_600,
  ),
  quoteBufferBps: readInteger('EXIT_QUOTE_BUFFER_BPS', 1_500, 0, 5_000),
  maxGasValueBps: readInteger('EXIT_MAX_GAS_VALUE_BPS', 1_000, 1, 10_000),
  emergencyMaxGasWei: parseEther(read('EXIT_EMERGENCY_MAX_GAS_BNB', '0.01')),
  approvalGasUnits: BigInt(
    readInteger('EXIT_APPROVAL_GAS_UNITS', 80_000, 21_000, 1_000_000),
  ),
  sellGasUnits: BigInt(
    readInteger('EXIT_SELL_GAS_UNITS', 350_000, 21_000, 2_000_000),
  ),
  trailingEnabled: readBoolean('EXIT_TRAILING_STOP_ENABLED', false),
  trailingActivationBps: readInteger(
    'EXIT_TRAILING_ACTIVATION_BPS',
    2_000,
    1,
    100_000,
  ),
  trailingDrawdownBps: readInteger(
    'EXIT_TRAILING_DRAWDOWN_BPS',
    500,
    1,
    10_000,
  ),
  targetBuysAfterEntry: readInteger('TARGET_BUYS_AFTER_ENTRY', 3, 1, 1_000),
});
```

- [ ] **Step 4: Run targeted tests and type checking**

Run:

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-exit-settings.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config/env.ts src/strategy/position-exit-settings.ts tests/position-exit-settings.test.ts
git commit -m "feat: validate position exit settings"
```

---

### Task 2: Pure Bigint Exit Evaluator

**Files:**
- Create: `src/strategy/position-exit.types.ts`
- Create: `src/strategy/position-exit-evaluator.ts`
- Create: `tests/position-exit-evaluator.test.ts`

- [ ] **Step 1: Write one failing test per rule and priority**

Use bigint-only fixtures. Cover `HOLD`, stop-loss reached/not reached,
take-profit, maximum duration, liquidity drop, probe blocked/unknown, gas ratio,
emergency absolute gas, trailing arm/peak/drawdown, simultaneous rules, and
input immutability.

```ts
test('un probe inconnu prime sur toutes les ventes', () => {
  const result = evaluatePositionExit({
    settings: settings(),
    state: state(),
    metrics: metrics({
      probeStatus: 'UNKNOWN',
      netExitValueWei: 1n,
      currentLiquidityWbnbWei: 1n,
    }),
  });
  assert.equal(result.action, 'MANUAL_REVIEW');
  assert.equal(result.primaryRule, 'SELLABILITY_UNCERTAIN');
  assert.deepEqual(
    result.triggeredRules,
    ['SELLABILITY_UNCERTAIN', 'LIQUIDITY_DROP', 'STOP_LOSS'],
  );
});

test('le trailing attend un recul de cinq pour cent après armement', () => {
  const armed = evaluatePositionExit({
    settings: settings({ trailingEnabled: true }),
    state: state(),
    metrics: metrics({ netExitValueWei: 1_200n, entryCostWei: 1_000n }),
  });
  assert.equal(armed.action, 'HOLD');
  assert.equal(armed.state.peakNetValueWei, 1_200n);

  const drawdown = evaluatePositionExit({
    settings: settings({ trailingEnabled: true }),
    state: armed.state,
    metrics: metrics({ netExitValueWei: 1_140n, entryCostWei: 1_000n }),
  });
  assert.equal(drawdown.primaryRule, 'TRAILING_STOP');
  assert.equal(drawdown.action, 'SELL');
});
```

- [ ] **Step 2: Verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-exit-evaluator.test.ts
```

Expected: FAIL because the evaluator is missing.

- [ ] **Step 3: Define evaluator types**

```ts
export type ExitRuleCode =
  | 'SELLABILITY_UNCERTAIN'
  | 'SELLABILITY_BLOCKED'
  | 'LIQUIDITY_DROP'
  | 'STOP_LOSS'
  | 'MAX_HOLDING_TIME'
  | 'TRAILING_STOP'
  | 'TAKE_PROFIT'
  | 'TARGET_BUYS'
  | 'GAS_RATIO_EXCEEDED'
  | 'EMERGENCY_GAS_EXCEEDED';

export type ExitPolicyAction =
  | 'HOLD'
  | 'SELL'
  | 'EMERGENCY_SELL'
  | 'MANUAL_REVIEW';

export type SellabilityStatus = 'SAFE' | 'BLOCKED' | 'UNKNOWN';

export interface PositionExitState {
  referenceLiquidityWbnbWei?: bigint;
  latestNetValueWei?: bigint;
  peakNetValueWei?: bigint;
  lastEvaluatedAtMs?: number;
  lastProbeAtMs?: number;
  nextEvaluationAtMs?: number;
  trailingArmedAtMs?: number;
  lastProbeStatus?: SellabilityStatus;
  pendingDecisionId?: string;
  lastPrimaryRule?: ExitRuleCode;
  lastReason?: string;
  staleReason?: string;
  settingsRevision?: number;
}

export type PositionExitDecisionStatus =
  | 'PENDING'
  | 'EXECUTING'
  | 'EXECUTED'
  | 'MANUAL_REVIEW'
  | 'FAILED'
  | 'SUPERSEDED';

export interface EffectivePositionExitSettings {
  settings: Readonly<PositionExitSettings>;
  revision: number;
  source: 'ENV' | 'DATABASE';
  updatedAt: string | null;
}

export interface PositionExitDecision {
  id: string;
  idempotencyKey: string;
  pair: Address;
  token: Address;
  settingsRevision: number;
  primaryRule: ExitRuleCode;
  triggeredRules: ExitRuleCode[];
  action: Exclude<ExitPolicyAction, 'HOLD'>;
  status: PositionExitDecisionStatus;
  metrics: PositionMetricsSnapshot;
  reason: string;
  errorType?: string;
  relatedTradeId?: string;
  createdAtMs: number;
  executionStartedAtMs?: number;
  updatedAtMs: number;
}

export type NewPositionExitDecision = Omit<
  PositionExitDecision,
  'id' | 'status' | 'createdAtMs' | 'executionStartedAtMs' | 'updatedAtMs'
>;
```

Also define `PositionMetricsSnapshot`, `ExitEvaluationInput`, and
`ExitEvaluationResult` with no `number` fields for on-chain amounts.

- [ ] **Step 4: Implement the pure evaluator**

Implement:

```ts
export function prudentNetExitValue(input: {
  quoteWei: bigint;
  sellTaxBps: number;
  quoteBufferBps: number;
  estimatedExitGasWei: bigint;
}): bigint;

export function evaluatePositionExit(
  input: ExitEvaluationInput,
): ExitEvaluationResult;
```

Collect every matching rule first, then select the primary rule in the
specification order. When trailing is enabled, take-profit only arms trailing
and never directly sells.

- [ ] **Step 5: Verify GREEN**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-exit-evaluator.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/strategy/position-exit.types.ts src/strategy/position-exit-evaluator.ts tests/position-exit-evaluator.test.ts
git commit -m "feat: evaluate position exit rules"
```

---

### Task 3: Idempotent PostgreSQL Schema and Repositories

**Files:**
- Create: `migrations/008_position_exit_policy.sql`
- Create: `src/strategy/position-exit.repository.ts`
- Create: `src/strategy/position-exit-settings.provider.ts`
- Create: `tests/position-exit-repository.test.ts`
- Modify: `src/types/domain.ts`
- Modify: `src/types/domain-validation.ts`
- Modify: `src/storage/repositories.ts`

- [ ] **Step 1: Write repository and domain validation tests**

Cover strict session `exitPolicy` parsing, environment fallback, malformed DB
payload fail-closed, optimistic setting conflicts, atomic settings audit,
idempotent decision creation, valid lifecycle transitions, and loading only
`HOLDING` sessions.

```ts
test('une révision périmée ne remplace pas les réglages courants', async () => {
  const repository = new PositionExitRepository(databaseAtRevision(4));
  await assert.rejects(
    repository.saveSettings(settings(), 3, 'DASHBOARD'),
    /révision/u,
  );
  assert.equal(database.commits, 0);
});

test('une même clé idempotente retourne la décision existante', async () => {
  const first = await repository.createDecision(decision('pair:entry:STOP_LOSS'));
  const second = await repository.createDecision(decision('pair:entry:STOP_LOSS'));
  assert.equal(second.id, first.id);
});
```

- [ ] **Step 2: Verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-exit-repository.test.ts
```

Expected: FAIL because migration and repository are absent.

- [ ] **Step 3: Create the idempotent migration**

The migration must create these exact tables and constraints:

```sql
CREATE TABLE IF NOT EXISTS strategy_settings (
  setting_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision > 0),
  setting_value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS strategy_settings_audit (
  audit_id TEXT PRIMARY KEY,
  setting_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  previous_value JSONB,
  next_value JSONB NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('DASHBOARD', 'ENV_RESET')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(setting_key, revision)
);

CREATE TABLE IF NOT EXISTS position_exit_decisions (
  decision_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  pair_address TEXT NOT NULL,
  token_address TEXT NOT NULL,
  settings_revision INTEGER NOT NULL CHECK (settings_revision >= 0),
  primary_rule TEXT NOT NULL,
  triggered_rules JSONB NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN ('SELL', 'EMERGENCY_SELL', 'MANUAL_REVIEW')
  ),
  status TEXT NOT NULL CHECK (
    status IN (
      'PENDING', 'EXECUTING', 'EXECUTED',
      'MANUAL_REVIEW', 'FAILED', 'SUPERSEDED'
    )
  ),
  metrics JSONB NOT NULL,
  reason TEXT NOT NULL,
  error_type TEXT,
  related_trade_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  execution_started_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_position_exit_decisions_pair_status
  ON position_exit_decisions(pair_address, status, created_at DESC);
```

- [ ] **Step 4: Add domain state and repository APIs**

Add `exitPolicy?: PositionExitState` and `pendingExitDecisionId?: string` to
`TokenSession`, then validate all optional fields strictly.

Implement:

```ts
export class PositionExitRepository {
  getSettings(): Promise<EffectivePositionExitSettings>;
  saveSettings(
    value: PositionExitSettings,
    expectedRevision: number,
    source: 'DASHBOARD',
  ): Promise<EffectivePositionExitSettings>;
  resetSettings(
    expectedRevision: number,
    defaults: PositionExitSettings,
  ): Promise<EffectivePositionExitSettings>;
  createDecision(input: NewPositionExitDecision): Promise<PositionExitDecision>;
  findDecision(id: string): Promise<PositionExitDecision | null>;
  transitionDecision(
    id: string,
    expected: PositionExitDecisionStatus,
    next: PositionExitDecisionStatus,
    patch?: { relatedTradeId?: string; errorType?: string },
  ): Promise<boolean>;
  listRecoverableDecisions(): Promise<PositionExitDecision[]>;
}
```

Add `SessionRepository.loadHolding()` using `WHERE status = 'HOLDING'`.
Serialize every settings and metrics payload with the existing bigint-safe
`stringifyJson`/`parseJson` helpers; direct `JSON.stringify` is forbidden for
on-chain amounts.

Implement the provider separately from SQL:

```ts
export class PositionExitSettingsProvider {
  get(): Promise<EffectivePositionExitSettings>;
  update(
    value: PositionExitSettings,
    expectedRevision: number,
  ): Promise<EffectivePositionExitSettings>;
  reset(expectedRevision: number): Promise<EffectivePositionExitSettings>;
}
```

The provider publishes a new frozen in-memory snapshot only after the
repository transaction commits. Revision `0` represents environment defaults.

- [ ] **Step 5: Verify GREEN**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-exit-repository.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add migrations/008_position_exit_policy.sql src/strategy/position-exit.repository.ts src/strategy/position-exit-settings.provider.ts src/types/domain.ts src/types/domain-validation.ts src/storage/repositories.ts tests/position-exit-repository.test.ts
git commit -m "feat: persist position exit policy"
```

---

### Task 4: Reusable SafetyProbe and Read-only Metrics

**Files:**
- Create: `src/security/safety-probe.service.ts`
- Create: `src/strategy/position-metrics.service.ts`
- Create: `tests/position-metrics-service.test.ts`
- Modify: `src/security/token-risk.service.ts`

- [ ] **Step 1: Write failing probe and metrics tests**

Cover exact token position quoting, WBNB reserve selection, sell tax from the
latest successful probe, quote buffer, current fee multiplied by conservative
gas units, due/not-due probe, probe revert as `UNKNOWN`, and no transaction
send.

```ts
test('calcule le gas prudent depuis les unités configurées', async () => {
  const service = subject({
    feesPerGas: 2_000_000_000n,
    approvalGasUnits: 80_000n,
    sellGasUnits: 350_000n,
  });
  const metrics = await service.collect(session(), settings(), state(), 1_000);
  assert.equal(metrics.estimatedExitGasWei, 860_000_000_000_000n);
});

test('un probe RPC en échec devient UNKNOWN sans transaction', async () => {
  const gateway = gatewayThatRejectsProbe();
  const metrics = await subject(gateway).collect(
    session(),
    settings(),
    state({ lastProbeAtMs: 0 }),
    61_000,
  );
  assert.equal(metrics.probeStatus, 'UNKNOWN');
  assert.equal(gateway.sentTransactions, 0);
});
```

- [ ] **Step 2: Verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-metrics-service.test.ts
```

Expected: FAIL because services are absent.

- [ ] **Step 3: Extract the reusable probe service**

Move the existing `simulateContract` SafetyProbe logic from
`TokenRiskService.runProbe` into:

```ts
export interface SafetyProbeResult {
  buyTaxBps: number;
  sellTaxBps: number;
  roundTripLossBps: number;
  quotedTokens: bigint;
  receivedTokens: bigint;
  quotedNative: bigint;
  recoveredNative: bigint;
}

export class SafetyProbeService {
  probe(pair: PairInfo): Promise<SafetyProbeResult>;
}
```

Inject the same service into `TokenRiskService`; do not duplicate ABI calls.

- [ ] **Step 4: Implement metrics collection**

Define a narrow injectable gateway:

```ts
export interface PositionMetricsGateway {
  quotePosition(session: TokenSession): Promise<bigint>;
  readLiquidityWbnb(session: TokenSession): Promise<bigint>;
  readFeePerGas(): Promise<bigint>;
  probeSellability(session: TokenSession): Promise<SafetyProbeResult>;
}
```

`PositionMetricsService.collect` must return `UNKNOWN` for probe errors but
throw a typed stale-metrics error for quote, liquidity, or fee RPC failures.

- [ ] **Step 5: Verify GREEN**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-metrics-service.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/security/safety-probe.service.ts src/security/token-risk.service.ts src/strategy/position-metrics.service.ts tests/position-metrics-service.test.ts
git commit -m "feat: collect position exit metrics"
```

---

### Task 5: One Locked and Audited Exit Path

**Files:**
- Create: `tests/position-exit-engine.test.ts`
- Modify: `src/strategy/session-engine.ts`
- Modify: `src/strategy/position-exit.repository.ts`

- [ ] **Step 1: Write failing engine concurrency and safety tests**

Cover immediate quote/probe/gas revalidation, stale decision, duplicate
decision, concurrent periodic/Swap/manual exits, normal gas ratio,
emergency absolute gas, probe unknown, pending persistence before executor,
trade ID linkage, and ambiguous execution.

```ts
test('trois demandes concurrentes ne vendent qu’une fois', async () => {
  const { engine, session, decisions, executor } = subject();
  const results = await Promise.allSettled([
    engine.requestPolicyExit(session, decisions.stopLoss),
    engine.onSwap(session, targetBuyEvent()),
    engine.sellManually(session),
  ]);
  assert.equal(executor.sellCalls, 1);
  assert.equal(session.status, 'CLOSED');
  assert.equal(results.filter((result) => result.status === 'fulfilled').length >= 1, true);
});

test('persiste SELL_PENDING et EXECUTING avant l’executor', async () => {
  const order: string[] = [];
  await subject({ order }).engine.requestPolicyExit(
    session(),
    decision('STOP_LOSS'),
  );
  assert.deepEqual(
    order.slice(0, 3),
    ['decision:EXECUTING', 'session:SELL_PENDING', 'executor:sell'],
  );
});
```

- [ ] **Step 2: Verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-exit-engine.test.ts
```

Expected: FAIL because `requestPolicyExit` is absent.

- [ ] **Step 3: Refactor the existing sale primitive**

Keep the current pair lock and execution failure policy. Introduce:

```ts
async requestPolicyExit(
  session: TokenSession,
  decision: PositionExitDecision,
): Promise<TokenSession>;

private async performLockedExit(input: {
  session: TokenSession;
  reason: string;
  sourceEventId?: string;
  decision?: PositionExitDecision;
  mode: 'NORMAL' | 'EMERGENCY' | 'MANUAL';
  rethrowFailure: boolean;
}): Promise<void>;
```

Route target-buy and manual exits through `performLockedExit`. For policy
decisions, re-run metrics inside the lock and reject any decision whose session,
settings revision, gas, or probe is no longer admissible.

Inject `PositionExitSettingsProvider` into the engine. At the start of every
monitorable Swap operation, read its immutable cached snapshot, copy the
effective `targetBuysAfterEntry` into the session when the revision changed,
and persist it before evaluating `TARGET_BUYS`. This makes dashboard changes
apply to open positions without bypassing the pair lock.

- [ ] **Step 4: Preserve recovery references**

When the executor returns an unresolved hash/nonce reference, keep
`unreconciledExecution`, `pendingExitDecisionId`, and decision `EXECUTING`.
Never transition it back to `PENDING` until recovery proves no transaction was
sent.

- [ ] **Step 5: Verify GREEN**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-exit-engine.test.ts tests/session-monitor-policy.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/strategy/session-engine.ts src/strategy/position-exit.repository.ts tests/position-exit-engine.test.ts
git commit -m "feat: serialize audited position exits"
```

---

### Task 6: Serialized Monitor and Restart Recovery

**Files:**
- Create: `src/strategy/position-exit-monitor.ts`
- Create: `tests/position-exit-monitor.test.ts`
- Modify: `src/recovery/recovery-intent.service.ts`
- Modify: `src/recovery/session-reconciler.ts`

- [ ] **Step 1: Write failing monitor tests**

Cover serialized passes, only `HOLDING` sessions, per-pair error isolation,
stale RPC state without sale, new liquidity reference, persisted peak, decision
idempotency, pending restart, executing restart, and no rebroadcast before
transaction reconciliation.

```ts
test('deux ticks ne se chevauchent jamais', async () => {
  const monitor = subjectWithBlockedFirstPass();
  const first = monitor.reconcileNow();
  const second = monitor.reconcileNow();
  assert.equal(monitor.currentStatus.running, true);
  releaseFirstPass();
  await Promise.all([first, second]);
  assert.equal(maxConcurrentPasses, 1);
});

test('un RPC de marché indisponible persiste STALE sans décision', async () => {
  await subjectWithQuoteFailure().reconcileNow();
  assert.equal(savedSession.exitPolicy?.staleReason, 'MARKET_RPC_ERROR');
  assert.equal(createdDecisions.length, 0);
  assert.equal(sellCalls, 0);
});
```

- [ ] **Step 2: Verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-exit-monitor.test.ts
```

Expected: FAIL because the monitor is absent.

- [ ] **Step 3: Implement monitor lifecycle**

```ts
export class PositionExitMonitor {
  start(): void;
  stop(): void;
  reconcileNow(): Promise<void>;
  waitForIdle(): Promise<void>;
  get currentStatus(): {
    running: boolean;
    lastCompletedAtMs: number | null;
    lastErrorType: string | null;
  };
}
```

Run every pass inside `RuntimeRecoveryBarrier.runListener`. Coalesce ticks,
persist state before actionable decision creation, and await
`SessionEngine.requestPolicyExit` before marking a pair complete.

- [ ] **Step 4: Integrate decision recovery**

Extend recovery so `SELL_PENDING` plus `pendingExitDecisionId` updates the
matching decision after the existing trade result is reconciled. The decision
must never create a second trade itself.

- [ ] **Step 5: Verify GREEN**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-exit-monitor.test.ts tests/session-reconciler.test.ts tests/recovery-intent.service.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/strategy/position-exit-monitor.ts src/recovery/recovery-intent.service.ts src/recovery/session-reconciler.ts tests/position-exit-monitor.test.ts
git commit -m "feat: monitor open position exits"
```

---

### Task 7: Runtime Startup, Recovery Barrier, and Shutdown

**Files:**
- Create: `src/runtime/position-exit-runtime.ts`
- Create: `tests/position-exit-runtime.test.ts`
- Modify: `src/runtime/runtime-shutdown.ts`
- Modify: `src/app.ts`

- [ ] **Step 1: Write failing runtime-order tests**

Assert:

```text
migrate
→ crash reconciliation
→ canonical recovery
→ monitor scheduler/listener activation
→ position-exit recovery
→ position-exit monitor start
```

Also assert shutdown order:

```text
disable exit ticks
→ stop recovery
→ drain exit monitor
→ drain monitor scheduler
→ drain canonical coordinator
→ drain exit monitor again
→ close listeners/dashboard/database
```

- [ ] **Step 2: Verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-exit-runtime.test.ts
```

Expected: FAIL because runtime wiring is absent.

- [ ] **Step 3: Add the runtime helper**

```ts
export async function startPositionExitRuntime(input: {
  reconcilePendingDecisions: () => Promise<void>;
  reconcileNow: () => Promise<void>;
  start: () => void;
}): Promise<void> {
  await input.reconcilePendingDecisions();
  await input.reconcileNow();
  input.start();
}
```

Extend `drainRuntimeForShutdown` with `stopPositionExits` and
`waitForPositionExitIdle`, preserving the existing canonical double-drain.

- [ ] **Step 4: Wire production dependencies in `app.ts`**

Instantiate settings repository/provider, reusable probe, metrics service,
decision repository, and monitor once. Start it only after initial crash and
canonical reconciliation. Inject the same engine, barrier, and repositories;
do not create a second sale executor or transaction queue.

- [ ] **Step 5: Verify GREEN**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-exit-runtime.test.ts tests/runtime-shutdown.test.ts tests/startup-order.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/runtime/position-exit-runtime.ts src/runtime/runtime-shutdown.ts src/app.ts tests/position-exit-runtime.test.ts tests/runtime-shutdown.test.ts tests/startup-order.test.ts
git commit -m "feat: integrate position exit runtime"
```

---

### Task 8: Dashboard Position Policy State

**Files:**
- Modify: `src/dashboard/dashboard.ts`
- Modify: `src/dashboard/dashboard.page.ts`
- Modify: `tests/dashboard-page.test.ts`
- Modify: `tests/dashboard-metrics.test.ts`

- [ ] **Step 1: Write failing DTO and rendering tests**

Assert that open positions expose and render:

```ts
{
  nextEvaluationAt: string | null;
  remainingHoldingSeconds: number | null;
  netValueBnb: string | null;
  economicPnlPercent: string | null;
  referenceLiquidityBnb: string | null;
  currentLiquidityBnb: string | null;
  stopLossPercent: string;
  takeProfitPercent: string;
  trailingEnabled: boolean;
  trailingArmed: boolean;
  peakNetValueBnb: string | null;
  lastProbeStatus: 'SAFE' | 'BLOCKED' | 'UNKNOWN' | null;
  lastProbeAt: string | null;
  lastReason: string | null;
  staleReason: string | null;
  settingsRevision: number | null;
}
```

- [ ] **Step 2: Verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/dashboard-page.test.ts tests/dashboard-metrics.test.ts
```

Expected: FAIL because the DTO fields are absent.

- [ ] **Step 3: Extend dashboard DTO and page**

Use persisted state and effective settings. Do not issue extra RPC calls from
the renderer; valuation RPC remains inside `DashboardService` and exit policy
state uses its last persisted metrics.

- [ ] **Step 4: Verify GREEN**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/dashboard-page.test.ts tests/dashboard-metrics.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/dashboard.ts src/dashboard/dashboard.page.ts tests/dashboard-page.test.ts tests/dashboard-metrics.test.ts
git commit -m "feat: expose position exit status"
```

---

### Task 9: Revision-safe Dashboard Form and Preview

**Files:**
- Create: `src/dashboard/exit-policy-controls.ts`
- Create: `src/dashboard/exit-policy.service.ts`
- Create: `tests/exit-policy-dashboard.test.ts`
- Modify: `src/dashboard/action-dashboard.ts`
- Modify: `src/app.ts`

- [ ] **Step 1: Write failing service and HTTP tests**

Cover GET, preview, PUT, DELETE, read-only mode, loopback restriction, existing
`DASHBOARD_ACTIONS_ENABLED` and live confirmation lock, strict content type and
origin, unknown fields, confirmation header, optimistic conflict, and preview
without DB/session mutation.

```ts
test('refuse une écriture lorsque les actions dashboard sont désactivées', async () => {
  const response = await request(server, {
    method: 'PUT',
    path: '/api/dashboard/exit-policy',
    body: validPayload(),
  });
  assert.equal(response.status, 403);
  assert.equal(repository.writes, 0);
});

test('la prévisualisation ne persiste ni ne vend', async () => {
  const preview = await service.preview(candidate(), 4);
  assert.equal(preview.settings.stopLossBps, 1_000);
  assert.deepEqual(preview.affectedPositions, [PAIR]);
  assert.equal(repository.writes, 0);
  assert.equal(executor.sellCalls, 0);
});
```

- [ ] **Step 2: Verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/exit-policy-dashboard.test.ts
```

Expected: FAIL because form service and routes are absent.

- [ ] **Step 3: Implement the dashboard settings service**

```ts
export class ExitPolicyDashboardService {
  get(): Promise<ExitPolicySettingsView>;
  preview(
    candidate: unknown,
    expectedRevision: number,
  ): Promise<ExitPolicyPreview>;
  update(
    candidate: unknown,
    expectedRevision: number,
  ): Promise<ExitPolicySettingsView>;
  reset(expectedRevision: number): Promise<ExitPolicySettingsView>;
}
```

Preview evaluates current persisted metrics only. It must not refresh probes,
persist state, or call the engine.

- [ ] **Step 4: Add routes and controls**

Add:

```text
GET    /api/dashboard/exit-policy
POST   /api/dashboard/exit-policy/preview
PUT    /api/dashboard/exit-policy
DELETE /api/dashboard/exit-policy
```

Require `X-Exit-Policy-Confirmation: APPLY_EXIT_POLICY` for PUT and
`RESET_EXIT_POLICY` for DELETE. Reuse `validateWritableRequest`, including live
confirmation. Increase the bounded JSON body size only enough for the strict
settings payload.

The CSP-nonce form must show env/default/effective values, preview affected
positions, ask confirmation, submit the current revision, handle HTTP 409, and
render read-only when writes are disabled.

- [ ] **Step 5: Verify GREEN**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/exit-policy-dashboard.test.ts
npm run check
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/dashboard/exit-policy-controls.ts src/dashboard/exit-policy.service.ts src/dashboard/action-dashboard.ts src/app.ts tests/exit-policy-dashboard.test.ts
git commit -m "feat: configure exit policy from dashboard"
```

---

### Task 10: Environment and Strategy Documentation

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/strategy.md`

- [ ] **Step 1: Write failing documentation guards**

Add assertions to a new section of `tests/position-exit-settings.test.ts` for
every environment key, dry-run default, form write lock, net formula,
`MANUAL_REVIEW`, trailing semantics, and gas emergency ceiling.

- [ ] **Step 2: Verify RED**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-exit-settings.test.ts
```

Expected: FAIL because the keys and documentation are absent.

- [ ] **Step 3: Update documentation**

Document every variable and range from Task 1. Explain:

- 30-minute/10%/20%/20% defaults;
- 15-second metrics and 60-second probe cadence;
- immediate pre-sale probe;
- economic net formula;
- fixed take-profit versus enabled trailing;
- normal gas ratio and emergency absolute ceiling;
- settings preview/revision/reset;
- dashboard action write lock;
- restart and hash/nonce reconciliation;
- `EXECUTION_MODE=dry-run` default and separate live decision.

- [ ] **Step 4: Verify GREEN**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/position-exit-settings.test.ts
git diff --check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .env.example README.md docs/strategy.md tests/position-exit-settings.test.ts
git commit -m "docs: document position exit policy"
```

---

### Task 11: PostgreSQL Integration and Full Verification

**Files:**
- Create: `tests/postgres/position-exit-policy.test.ts`
- Modify: `.github/workflows/ci.yml` only if PostgreSQL is already provisioned by issue #12 before this task is executed

- [ ] **Step 1: Add isolated PostgreSQL scenarios**

Following the existing schema helper, cover:

1. migration 008 twice;
2. settings save plus audit in one transaction;
3. stale revision leaves both tables unchanged;
4. duplicate decision idempotency;
5. pending decision resumed after repository restart;
6. executing decision linked to an existing sell trade without rebroadcast;
7. trailing peak and liquidity reference survive restart;
8. transaction failure rolls back session, decision, and audit together where
   the operation contract requires atomicity;
9. settings reset restores environment defaults and appends audit;
10. malformed JSON fails closed.

Each scenario creates and drops its own normalized schema and awaits all client
closures before cleanup.

- [ ] **Step 2: Run PostgreSQL tests**

```bash
npm run test:postgres
```

Expected: PASS when `TEST_DATABASE_URL` is available. If absent, record the
exact connection/configuration error in the PR and do not claim PostgreSQL
verification.

- [ ] **Step 3: Run focused regression suites**

```bash
npx tsx --import ./tests/setup-env.ts --test \
  tests/position-exit-settings.test.ts \
  tests/position-exit-evaluator.test.ts \
  tests/position-exit-repository.test.ts \
  tests/position-metrics-service.test.ts \
  tests/position-exit-engine.test.ts \
  tests/position-exit-monitor.test.ts \
  tests/position-exit-runtime.test.ts \
  tests/exit-policy-dashboard.test.ts \
  tests/session-monitor-policy.test.ts \
  tests/session-reconciler.test.ts \
  tests/runtime-shutdown.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run mandatory validation**

```bash
npm run check
npm test
npm run build
git diff --check origin/main...HEAD
git status --short
```

Expected: every command exits zero and the worktree is clean after the final
commit.

- [ ] **Step 5: Perform the final safety review**

Inspect `origin/main...HEAD` specifically for:

- any automatic live activation;
- missing persisted `TokenRiskReport` invariant;
- float/`number` conversion of on-chain amounts;
- sale execution outside the `SessionEngine` pair lock;
- negative or unknown probe triggering a transaction;
- database/RPC failure converted into a sell;
- gas ratio masking liquidity emergency without applying the absolute ceiling;
- pending transaction rebroadcast without hash/nonce recovery;
- dashboard setting writes without loopback, origin, action lock, revision, and
  confirmation;
- monitor work surviving shutdown or bypassing the recovery barrier;
- unrelated secret, mempool, anti-bot, or front-running changes.

- [ ] **Step 6: Commit final integration tests**

```bash
git add tests/postgres/position-exit-policy.test.ts
git commit -m "test: cover position exit recovery"
```

Skip `.github/workflows/ci.yml` unless PostgreSQL is already provisioned there.

---

## Completion Checklist

- [ ] Every entered position has a maximum holding time and stop-loss.
- [ ] Fixed take-profit and optional trailing semantics match the approved design.
- [ ] Liquidity emergency requires an immediate successful probe.
- [ ] Unknown or blocked sellability results in `MANUAL_REVIEW`.
- [ ] Normal and emergency gas policies are distinct and audited.
- [ ] All environment defaults are strictly validated.
- [ ] Dashboard overrides are previewed, revision-safe, audited, and write-locked.
- [ ] Settings, liquidity reference, trailing peak, and pending decisions survive restart.
- [ ] Periodic, target-buy, and manual exits share one session lock.
- [ ] No transaction is rebroadcast without existing recovery.
- [ ] Dry-run remains the default and follows the same policy decisions as live.
- [ ] `npm run check`, `npm test`, and `npm run build` pass.
