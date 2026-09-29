# Quarantined Tests

A flaky test is a test whose result changes without the code changing. It is a
**bug report**, not a CI inconvenience.

## The rule

A single unreproduced failure is not yet a flake. Log it as `watching`; a second
occurrence, or any occurrence on CI, promotes it to `quarantined`.

When a test is confirmed flaky:

1. **Quarantine it** — skip it in the suite and set the row's status to `quarantined`.
2. **File a kernel issue** for the underlying cause and put the id in the row.
3. **Never** re-run CI until it goes green, and **never** wrap it in a retry.

A retried flaky test still fails in production; it just stops telling you. This
repo has no auto-retry mechanism in CI and must not grow one — if a lane needs
retries to pass, the lane is broken.

A quarantined test is unblocked work, not resolved work: the row leaves this file
only when the issue is closed and the test has been un-skipped.

## Registry

| Test | Status | First seen | Issue | Notes |
| --- | --- | --- | --- | --- |
| `test/patch-intent.test.js` | watching | 2026-08-16 | `b7a20a71` | ENOTCONN under load in the **local** full suite; kills the suite mid-run with no failing-test output. One occurrence, never on CI, so it stays in the suite until it recurs. |
| `test/pr-monitor/journal.test.js` › withJournalLock (cross-process serialization) › heartbeat keeps a contender out after the original stale window | quarantined (darwin only) | 2026-09-28 | `8d54c27a` | macOS CI (Node 22) failure on PR #590 run 36457747077: the contender acquired the lock (the promise resolved instead of rejecting) at 6530ms. It's a wall-clock heartbeat vs stale-window race under runner load; the fix is to drive the heartbeat and stale window with an injected clock. |
| `test/e2e/memory-recall-holdout.test.js` › foreign rows cannot crowd an unseen local memory out of additionalContext | quarantined (win32 only) | 2026-09-27 | `635695bc` | Windows CI (Node 22) timeout, 20051ms vs 15000ms, on the first case of the file (run 36345257796); the same memory-recall family timed out on CI before; suspected cold-start setup inside the case. |
| `test/kernel/watch-owner-transaction.test.js` › watch owner dedicated SQLite transaction › Bun and Node contenders commit exactly one generation | quarantined (darwin only) | 2026-09-29 | `4416c96c` | macOS CI (Node 26) timeout, 20008ms vs 20000ms, on PR #598 run 36549230672; six Bun/Node contender subprocesses on a loaded runner. The fix is to size the contender count or budget to subprocess cost. |

<!-- Add a row above. Keep it one line per test; details belong in the issue. -->
