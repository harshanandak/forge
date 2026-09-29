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
| `test/eval/eval-runner.test.js` › eval-runner › executeCommand › sets FORGE_EVAL=1 in subprocess environment | quarantined (darwin only) | 2026-09-28 | `2390754b` | macOS CI (Node 26) timeout, 15002ms vs 15000ms, on PR #601 run 36482604003; `executeCommand` returned exit 1 after its 10s budget. It is the first subprocess spawn in the block, so a cold `node` start on a loaded runner is the suspect. PR #601 does not touch eval code. |
| `test/kernel/watch-owner-transaction.test.js` › watch owner dedicated SQLite transaction › Bun and Node contenders commit exactly one generation | quarantined (darwin only) | 2026-09-29 | `4416c96c` | macOS CI (Node 26) timeout, 20008ms vs 20000ms, on PR #598 run 36549230672; six Bun/Node contender subprocesses on a loaded runner. The fix is to size the contender count or budget to subprocess cost. |

| `test/structural/skills-sync-drift.test.js` › each harness dir regenerates byte-identically from skills/ | watching | 2026-09-29 | `fadbba10` | Local only, not seen on CI, so not skipped: two local Windows Bun 1.4.2 timeouts: 34267ms during merge reconciliation and 21067ms after reconciliation with no concurrent test run, against the explicit 20000ms budget; test and implementation unchanged from master. |

| `test/bun-workflow-pins.test.js` › accepts only complete same-version staged test workflow projections | watching | 2026-09-29 | `5dc2ac03` | First local Windows Git subprocess failure at 20333ms against the test's 20000ms budget during concurrent focused suites; unchanged test and same-version validation path. |

<!-- Add a row above. Keep it one line per test; details belong in the issue. -->
| `test/commands/init-hooks-onboarding.test.js` > a bare git repo is HOOKS_NOT_ACTIVE before any init (sanity) | quarantined (win32 only) | 2026-09-29 | `a8dc2c86` | PR #601 Windows Node 26 CI run 36606854498, job 109538024448: 15535ms against 15000ms; test and init implementation unchanged from master; investigate runtime-health cold probes. |
| `test/flow/src/bounded-loop.test.js` > accepts the configured 256-event ceiling with fixed-size seen-event digests | watching | 2026-09-29 | `4399035a` | Local Windows Bun 1.4.2 focused run: 7324ms against 5000ms; no CI evidence, no skip or timeout increase. |
