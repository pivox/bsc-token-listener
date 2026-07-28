# Monitor Queue Implementation Plan

1. Add a pure, deterministic monitor priority policy and unit tests.
2. Add a serialized `MonitorScheduler` with capacity, duplicate prevention,
   expiration, ignored-asset removal, startup-failure continuation and restart
   reconstruction tests.
3. Integrate scheduler ownership with `SwapListener` lifecycle and recovery
   synchronization in `app.ts`.
4. Extend heartbeat snapshots with monitor capacity, queue depth, failed
   admissions and oldest waiting age.
5. Render the queue diagnostics in the dashboard and update page tests.
6. Document the priority, saturation, retry and expiration behavior.
7. Run TypeScript checks, unit tests, build and PostgreSQL integration tests.

