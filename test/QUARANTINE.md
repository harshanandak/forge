# Quarantined Tests

A flaky test is a test whose result changes without the code changing. It is a
**bug report**, not a CI inconvenience.

## The rule

When a test is observed flaky:

1. **Quarantine it** — skip it in the suite and add a row below.
2. **File a kernel issue** for the underlying cause and put the id in the row.
3. **Never** re-run CI until it goes green, and **never** wrap it in a retry.

A retried flaky test still fails in production; it just stops telling you. This
repo has no auto-retry mechanism in CI and must not grow one — if a lane needs
retries to pass, the lane is broken.

A quarantined test is unblocked work, not resolved work: the row leaves this file
only when the issue is closed and the test has been un-skipped.

## Registry

| Test | First seen | Issue | Notes |
| --- | --- | --- | --- |
| `test/patch-intent.test.js` | 2026-08-16 | `b7a20a71` | ENOTCONN under load in the **local** full suite; kills the suite mid-run with no failing-test output. Not reproduced on CI runners. Not skipped yet — tracked here so the next occurrence is recognised rather than re-diagnosed. |

<!-- Add a row above. Keep it one line per test; details belong in the issue. -->
