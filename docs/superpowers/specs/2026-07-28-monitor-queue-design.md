# Monitor Queue Design

## Goal

Never leave an eligible token session indefinitely without a swap monitor when
`MAX_ACTIVE_PAIR_MONITORS` is saturated.

## Queue model

The queue is reconstructed from `token_sessions`; no second source of truth is
introduced. A session is eligible when its state is monitorable and it does not
already own an in-process monitor.

Priority is deterministic and safety-first:

1. `HOLDING` sessions, oldest first, because an open position must be watched;
2. `WAITING_FIRST_BUY` sessions, oldest first (FIFO by `createdAtMs`);
3. pair address as the final stable tie-breaker.

`RISK_CHECKING`, `BUY_PENDING` and `SELL_PENDING` are not newly admitted, but an
existing monitor keeps its reservation while one of these in-flight
transitions completes. `MANUAL_REVIEW`, ignored assets and terminal sessions
are not admitted.

## Scheduling

`MonitorScheduler.reconcile()` is serialized. It:

1. reloads active sessions from PostgreSQL;
2. stops monitors whose sessions are no longer monitorable;
3. expires every unmonitored queued `WAITING_FIRST_BUY` older than the
   configured TTL; active listeners serialize their own expiry with swap
   processing;
4. removes ignored assets through the existing ignore workflow;
5. sorts remaining candidates with the policy above;
6. admits candidates while capacity remains;
7. continues with the next candidate if one listener fails to start.

A failed `WAITING_FIRST_BUY` admission does not reserve capacity, so the next
waiting candidate is attempted. A failed `HOLDING` admission reserves its slot
for the pass: an open position can never lose safety priority to a lower
priority observation.

If an unmonitored `HOLDING` session appears while capacity is already occupied,
the scheduler deterministically preempts the lowest-priority active
`WAITING_FIRST_BUY` observation, drains its in-flight work, then admits the open
position.

The scheduler reserves a pair before awaiting listener startup. This prevents
two local monitor starts for the same pair. Listener termination releases the
reservation and triggers another serialized pass.

On restart, the first pass reconstructs the queue from PostgreSQL and admits it
using the same policy.

## Diagnostics

The scheduler exposes:

- total capacity;
- active monitors;
- queued sessions;
- failed admissions in the latest pass ("abandoned");
- age of the oldest queued session.

Heartbeat and dashboard consume this snapshot. Logs cover admission, waiting,
expiration, ignored removal, startup failure and capacity release.

## Failure rules

- A listener startup error never blocks the next candidate.
- Failed candidates remain persisted and become retryable on a later pass.
- Ignored decisions reload the persisted session under the pair lock before
  mutating it, so an in-flight entry cannot be overwritten by a stale snapshot.
- Every candidate is reloaded and rechecked for status, ignore state and
  expiration immediately before admission. Swap processing also reloads the
  persisted session under the pair lock.
- Expiration is persisted before admission.
- No RPC failure advances a blockchain checkpoint.
- The monitor cap is never increased automatically.
- Shutdown disables new admissions and drains the current scheduler pass before
  listeners and storage are closed.
