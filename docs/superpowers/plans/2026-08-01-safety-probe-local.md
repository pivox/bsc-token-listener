# SafetyProbe Local EVM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the real `SafetyProbe` and `SafetyProbeService` against four deterministic token behaviours on an embedded local EVM.

**Architecture:** Hardhat 3 EDR runs inside the Node test process and is exposed to existing viem clients through a custom EIP-1193 transport. Solidity fixtures are compiled with the existing `solc` package and deployed with an unlocked ephemeral JSON-RPC account, so no private key or external service is required.

**Tech Stack:** TypeScript strict ESM, Node test runner, viem, Hardhat 3 EDR, solc 0.8.x, Solidity fixtures.

---

### Task 1: Record the approved design

**Files:**
- Create: `docs/superpowers/specs/2026-08-01-safety-probe-local-design.md`
- Create: `docs/superpowers/plans/2026-08-01-safety-probe-local.md`

- [ ] **Step 1: Verify the documents describe the bounded local-chain PR**

Run:

```bash
rg -n "embedded|Hardhat|normal token|taxed token|honeypot|non-standard|testnet" \
  docs/superpowers/specs/2026-08-01-safety-probe-local-design.md \
  docs/superpowers/plans/2026-08-01-safety-probe-local.md
```

Expected: every required local scenario appears and testnet is explicitly left
for the next PR.

- [ ] **Step 2: Commit the design and plan**

```bash
git add docs/superpowers/specs/2026-08-01-safety-probe-local-design.md \
  docs/superpowers/plans/2026-08-01-safety-probe-local.md
git commit -m "docs: design local SafetyProbe validation"
```

### Task 2: Prove the normal-token scenario in TDD order

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `tsconfig.json`
- Create: `hardhat.config.ts`
- Create: `contracts/fixtures/MockSafetyProbeRouter.sol`
- Create: `contracts/fixtures/MockStandardToken.sol`
- Create: `tests/fixtures/local-evm.ts`
- Create: `tests/safety-probe-local.test.ts`

- [ ] **Step 1: Write the failing normal-token test**

Create `tests/safety-probe-local.test.ts` with one test that imports
`deploySafetyProbeScenario` from the not-yet-existing fixture helper, invokes
the real service, and asserts:

```ts
assert.deepEqual(result, {
  buyTaxBps: 0,
  sellTaxBps: 0,
  roundTripLossBps: 0,
  quotedTokens: 10_000n,
  receivedTokens: 10_000n,
  quotedNative: 10_000n,
  recoveredNative: 10_000n,
});
```

Always close the returned local chain in `finally`.

- [ ] **Step 2: Run the test and observe RED**

```bash
npx tsx --import ./tests/setup-env.ts --test tests/safety-probe-local.test.ts
```

Expected: FAIL because `tests/fixtures/local-evm.ts` does not exist.

- [ ] **Step 3: Add the embedded runtime configuration**

Install the maintained embedded EVM:

```bash
npm install --save-dev hardhat@^3.12.0
```

Create `hardhat.config.ts`:

```ts
import { defineConfig } from 'hardhat/config';

export default defineConfig({
  defaultNetwork: 'local',
  networks: {
    local: {
      type: 'edr-simulated',
      chainType: 'l1',
    },
  },
});
```

Add `hardhat.config.ts` to `tsconfig.json#include`. Add this script to
`package.json` without changing `npm test`:

```json
"test:chain": "tsx --import ./tests/setup-env.ts --test tests/safety-probe-local.test.ts"
```

- [ ] **Step 4: Add the minimal router and standard token**

Create `MockSafetyProbeRouter.sol` with a 1:1 `getAmountsOut`, a payable buy
that calls `transfer`, and a sell that computes its token balance delta around
`transferFrom` before returning that many wei. Require the supplied deadline
not to be expired and require every standard token call and native transfer to
succeed.

Create `MockStandardToken.sol` with `balanceOf`, `allowance`, standard boolean
`approve`, `transfer` and `transferFrom`. Its constructor receives the router
and mints `type(uint128).max` units to it.

- [ ] **Step 5: Add the compiler, deployer and viem adapter**

Create `tests/fixtures/local-evm.ts` with these public shapes:

```ts
export interface LocalProbeScenario {
  service: SafetyProbeService;
  pair: PairInfo;
  close(): Promise<void>;
}

export async function deploySafetyProbeScenario(
  tokenContract: string,
  tokenArgs: readonly unknown[] = [],
): Promise<LocalProbeScenario>;
```

The helper must:

1. call `network.create({ network: 'local', chainType: 'l1' })`;
2. wrap `connection.provider` with viem `custom`;
3. read the first unlocked address using `eth_accounts`;
4. compile `SafetyProbe.sol`, the router and present token fixtures with solc;
5. deploy the router, then the selected token with `[router, ...tokenArgs]`;
6. deploy the production `SafetyProbe`;
7. construct `SafetyProbeService` with amount `10_000n`, a fixed clock and the
   ephemeral caller address;
8. close the connection if compilation or deployment fails.

Do not expose or log a private key.

- [ ] **Step 6: Run the focused test and observe GREEN**

```bash
npm run test:chain
```

Expected: 1 test passes.

- [ ] **Step 7: Commit the normal scenario**

```bash
git add package.json package-lock.json tsconfig.json hardhat.config.ts \
  contracts/fixtures/MockSafetyProbeRouter.sol \
  contracts/fixtures/MockStandardToken.sol tests/fixtures/local-evm.ts \
  tests/safety-probe-local.test.ts
git commit -m "test: run SafetyProbe on an embedded EVM"
```

### Task 3: Measure independent buy and sell taxes

**Files:**
- Create: `contracts/fixtures/MockTaxToken.sol`
- Modify: `tests/safety-probe-local.test.ts`

- [ ] **Step 1: Write the failing taxed-token test**

Add a test that requests `MockTaxToken` with constructor arguments `1000n` and
`2000n`, then asserts:

```ts
assert.deepEqual(result, {
  buyTaxBps: 1_000,
  sellTaxBps: 2_000,
  roundTripLossBps: 2_800,
  quotedTokens: 10_000n,
  receivedTokens: 9_000n,
  quotedNative: 9_000n,
  recoveredNative: 7_200n,
});
```

- [ ] **Step 2: Run and observe RED**

```bash
npm run test:chain
```

Expected: FAIL because `MockTaxToken` is not compiled.

- [ ] **Step 3: Implement the minimum taxed token**

Create `MockTaxToken.sol`. Its constructor accepts router, buy-tax basis points
and sell-tax basis points, rejects values above 10,000, and mints supply to the
router. `transfer` taxes when `msg.sender == router`; `transferFrom` taxes when
`to == router`; tax is burned by reducing total balances rather than credited
to another address. Allowance consumption remains based on the full requested
amount.

- [ ] **Step 4: Run and observe GREEN**

```bash
npm run test:chain
```

Expected: 2 tests pass with exact basis-point and amount assertions.

- [ ] **Step 5: Commit the tax scenario**

```bash
git add contracts/fixtures/MockTaxToken.sol tests/safety-probe-local.test.ts
git commit -m "test: measure SafetyProbe transfer taxes"
```

### Task 4: Fail closed for honeypot and non-standard tokens

**Files:**
- Create: `contracts/fixtures/MockHoneypotToken.sol`
- Create: `contracts/fixtures/MockNonStandardToken.sol`
- Modify: `tests/safety-probe-local.test.ts`

- [ ] **Step 1: Write and verify the failing honeypot test**

Add:

```ts
await assert.rejects(() => scenario.service.probe(scenario.pair));
```

for `MockHoneypotToken`, then run `npm run test:chain`.

Expected: FAIL because the contract is absent.

- [ ] **Step 2: Implement the honeypot fixture and observe GREEN**

Create a standard token whose `transferFrom` reverts with
`SellBlocked()` whenever `to == router`. Its buy path remains valid. Run
`npm run test:chain` and expect 3 passing tests.

- [ ] **Step 3: Write and verify the failing non-standard test**

Add the same rejection assertion for `MockNonStandardToken` and run
`npm run test:chain`.

Expected: FAIL because the contract is absent.

- [ ] **Step 4: Implement the non-standard fixture and observe GREEN**

Create a token with standard `balanceOf`, `transfer` and `transferFrom`, but an
`approve(address,uint256)` function that intentionally returns no value. Run:

```bash
npm run test:chain
```

Expected: 4 tests pass; the production probe rejects when decoding `approve`.

- [ ] **Step 5: Commit both fail-closed scenarios**

```bash
git add contracts/fixtures/MockHoneypotToken.sol \
  contracts/fixtures/MockNonStandardToken.sol tests/safety-probe-local.test.ts
git commit -m "test: reject unsafe SafetyProbe token behaviours"
```

### Task 5: Document and validate the complete local-chain layer

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Document commands and boundaries**

Add a `Tests chaîne locale` subsection that explains:

```markdown
`npm run test:chain` lance Hardhat EDR directement dans Node, compile et
déploie des fixtures déterministes, puis appelle le vrai `SafetyProbe` avec
viem. Les scénarios couvrent un token normal, des taxes achat/vente, un rejet à
la vente et un `approve` non standard. Aucun Docker, RPC public, secret ou
transaction sur un réseau public n'est utilisé.

Cette suite fait également partie de `npm test`. Le scénario BSC testnet reste
séparé et explicitement opt-in.
```

Update the issue #12 wording so only testnet remains after this PR.

- [ ] **Step 2: Run focused local validation**

```bash
npm run check
npm run test:chain
```

Expected: both exit 0 and exactly 4 chain tests pass.

- [ ] **Step 3: Run every repository gate**

```bash
npm run check
npm test
TEST_DATABASE_URL=postgresql://bscbot:bscbot@127.0.0.1:5432/bscbot npm run test:postgres
npm run build
```

Expected: every command exits 0; default tests include the four local-chain
scenarios and PostgreSQL integration remains green.

- [ ] **Step 4: Audit scope, secrets and default safety**

```bash
git diff origin/main...HEAD --check
git diff origin/main...HEAD --stat
git grep -nE '(mnemonic|seed phrase|0x[0-9a-fA-F]{64})' -- \
  ':!package-lock.json' ':!.env.example'
test "$(grep '^EXECUTION_MODE=' .env.example)" = 'EXECUTION_MODE=dry-run'
git status --short --branch
```

Expected: no embedded secret, no whitespace errors, the dry-run default is
unchanged, and only planned files are modified.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md
git commit -m "docs: explain embedded SafetyProbe tests"
```

### Task 6: Publish for review without closing issue #12

**Files:** none

- [ ] **Step 1: Push and create the PR**

```bash
git push -u origin test/issue-12-safety-probe-local
gh pr create \
  --base main \
  --head test/issue-12-safety-probe-local \
  --title "test: validate SafetyProbe on an embedded EVM" \
  --body $'## Summary\n- run a deterministic Hardhat EDR chain inside Node\n- validate normal and taxed SafetyProbe round trips with exact measurements\n- prove honeypot and non-standard token behaviours fail closed\n\n## Validation\n- npm run check\n- npm run test:chain\n- npm test\n- TEST_DATABASE_URL=... npm run test:postgres\n- npm run build\n\nPart of #12. The explicit opt-in BSC testnet scenario remains.'
```

- [ ] **Step 2: Request Codex review and wait for checks**

```bash
pr_number=$(gh pr view --json number --jq .number)
gh pr comment "$pr_number" --body '@codex please review this PR. Focus on fixture fidelity, exact tax math, fail-closed behaviour, secret safety, deterministic cleanup, and whether the production SafetyProbe is genuinely exercised.'
gh pr checks "$pr_number" --watch
gh pr view "$pr_number" --comments
```

Do not merge while checks fail or blocking feedback remains. After a clean
review, merge, fetch `origin/main`, and begin the separate opt-in testnet plan.

