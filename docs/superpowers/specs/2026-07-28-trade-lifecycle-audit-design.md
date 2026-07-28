# Trade Lifecycle Audit Design

## Goal

Make every buy, approval, and sell auditable from intent through confirmation while
keeping dry-run deterministic and preparing crash reconciliation in issue #7.

## Architecture

`trades` remains the business aggregate for a buy or sell. A new
`trade_transactions` table records each on-chain `BUY`, `APPROVE`, or `SELL` step.
The executor depends on an injectable viem gateway and repository so transaction
lifecycle behavior can be tested without a live RPC.

For live execution, the gateway prepares a request with an explicit pending nonce,
signs it locally, and derives its hash. The repository persists hash, nonce, wallet,
step, and balance snapshots before `sendRawTransaction`. The signed transaction is
kept in memory only. Receipt and measurement updates transition both records
atomically where possible.

## State model

Trades use `CREATED`, `SUBMITTED`, `CONFIRMED`, `REVERTED`, `UNKNOWN`, `FAILED`,
or `SIMULATED`. Child transactions use `CREATED`, `SUBMITTED`, `CONFIRMED`,
`REVERTED`, or `UNKNOWN`.

An error before broadcast is `FAILED`. Any error after attempting
`sendRawTransaction`, including a receipt timeout, is `UNKNOWN`. A successful
receipt is `CONFIRMED`; a reverted receipt is `REVERTED`. A confirmed transaction
whose post-balance measurement fails remains confirmed, but real amount fields stay
empty and the session moves to manual review.

## Amounts and PnL

For a live buy, received tokens come from the token balance delta. Native principal
comes from the native balance delta minus confirmed gas. For a sell, the executor
sells exactly the position amount, never the whole wallet balance. A lower wallet
balance fails before broadcast; a higher balance is left untouched.

Allowance is read before selling. Sufficient allowance skips approval. Otherwise
the executor approves exactly the position amount. No automatic zero-reset approval
fallback is included.

Gas cost is `gasUsed * effectiveGasPrice`. Gross realized PnL is real sell proceeds
minus real buy principal. Net realized PnL subtracts buy, approval, and sell gas.
Quotes are retained separately and are never substituted for missing real values.

Dry-run creates a `SIMULATED` trade without a child on-chain transaction, nonce,
hash, receipt, or real amount.

## Data and compatibility

The idempotent migration adds explicit numeric audit columns to `trades` and creates
`trade_transactions`, with unique constraints on transaction hash and
`(wallet_address, nonce)`. Existing JSON payloads and historical rows remain
readable.

`EntryExecution` and `ExitExecution` gain trade identifiers, quoted values, and gas
costs while retaining existing fields for stored-session compatibility. The
dashboard distinguishes simulated values from live gross PnL, gas, and net PnL.

## Testing

Unit tests cover signed intent persistence before broadcast, buy tax, reverts,
ambiguous RPC failures, receipt timeouts, exact-position selling, insufficient
balances, sell tax, allowance paths, approval failure, gas and PnL, incomplete
measurements, and dry-run. An opt-in PostgreSQL suite verifies bigint round trips,
migration idempotence, and uniqueness constraints via `TEST_DATABASE_URL`.

## Boundaries

Issue #8 does not retry, replace, or rebroadcast uncertain transactions. Startup
and periodic reconciliation remain issue #7. The wallet is assumed dedicated to
one bot process; high-availability nonce coordination remains out of scope.
