# SafetyProbe Local EVM Design

**Date:** 2026-08-01
**Issue:** #12
**Status:** Approved — embedded EVM selected

## Objective

Prove that the production `SafetyProbe` and `SafetyProbeService` correctly
measure a deterministic buy/sell round trip without Docker, a public RPC, or a
private key stored in the repository. Cover the four contract behaviours named
by issue #12: normal token, taxed token, sell honeypot and non-standard token.

## Scope

This PR adds the local-chain layer only. It does not change risk policy,
execution behaviour, deployment scripts, database data or the default
`EXECUTION_MODE=dry-run`. The opt-in BSC testnet scenario remains a following
PR so that local deterministic validation and public-network validation keep
separate failure modes.

## Runtime

Use Hardhat 3's EDR network in-process through `network.create()`. The test
wraps its EIP-1193 provider in viem's `custom` transport, obtains an unlocked
ephemeral address through `eth_accounts`, and uses that address as a JSON-RPC
account. No account private key, mnemonic or secret is read, written or logged.

The test compiles contracts with the repository's existing `solc` dependency
and deploys them with viem. It does not depend on Hardhat artifacts or replace
the repository's Node test runner. `npm test` therefore keeps its existing
shape and simply discovers the new root-level test file.

## Fixture contracts

- `MockSafetyProbeRouter` quotes native/token amounts 1:1. A buy transfers
  tokens held by the router; a sell measures the tokens actually received and
  returns the same amount of native currency. This makes transfer taxes visible
  without reproducing PancakeSwap's full AMM.
- `MockStandardToken` mints deterministic supply to the router and returns
  standard boolean values. It produces no loss.
- `MockTaxToken` applies independently configured buy and sell tax rates based
  on whether the router is sender or recipient. A 10% buy tax and 20% sell tax
  must produce 1000, 2000 and 2800 basis points for buy, sell and total loss.
- `MockHoneypotToken` permits the buy but reverts when the router is the
  recipient of `transferFrom`, proving that a blocked sale fails the probe.
- `MockNonStandardToken` has an `approve` function with no return value. The
  production probe's standard `returns (bool)` call must fail closed after the
  buy instead of treating the token as safe.

## Test lifecycle

Each test creates its own isolated EDR chain, compiles the fixture sources,
deploys the router, token and real `SafetyProbe`, constructs the real
`SafetyProbeService`, and calls `probe()` through `eth_call`. The chain
connection is always closed in `finally`.

The service receives only the pair fields used by the probe; all other
`PairInfo` fields use deterministic zero-like addresses and hashes. A fixed
clock makes the deadline reproducible.

## Acceptance

- `npm run test:chain` passes the four scenarios without Docker or public RPC.
- `npm test` includes the same scenarios by default.
- Normal and taxed results are asserted exactly.
- Honeypot and non-standard approvals reject.
- No private key, mnemonic or public network endpoint is added.
- `npm run check`, `npm test`, `npm run test:postgres` and `npm run build` pass.
