# Memory holdout execution decisions

## Decision 1: Start with diagnostics

Date: 2026-09-20. Task: observe the existing holdout.
User approved the saved diagnostic-first plan. Reuse the test's helpers and the
existing CI artifact path. Do not change the production driver, runner, workflow,
test budget, fixture semantics or assertions. The preserved batching patch stays
untouched until measured evidence supports it. Status: RESOLVED.

## Decision 2: Test instrumentation verification

Date: 2026-09-20. Task: observe the existing holdout.
The patch modifies an existing test only. Verify missing artifact before the
change, then existing behavioral tests plus artifact shape/count/privacy checks
afterward; no new product API or artificial production regression is introduced.
Root will review this evidence before canonical validation. Status: RESOLVED.

## Decision 3: Measure unaccounted time without more hooks

Date: 2026-09-20. Task: observe the existing holdout.
Add total case wall/CPU time through cleanup, before artifact serialization.
Comparing that with database phases reveals time outside the measured calls
without wrapping more production methods or global filesystem functions. Remove
per-store restoration bookkeeping because stores are isolated and discarded at
cleanup. Preserve the explicit 20-second performance-case timeout and the
15-second default. Status: RESOLVED.

## Focused execution evidence

The finalized probe passed 10 cases and 177 assertions in 3.17 seconds with
`bun test --timeout 15000 test/e2e/memory-recall-holdout.test.js`. Focused ESLint
exited 0. The local JSON contained 10 case totals, no recording-error flag, and
only finite nonnegative durations and positive counts. Root independently read
the artifact and checked its counts. Source review remains a separate gate.

Artifact: `test-results/memory-recall-holdout-timing-2400-1789914896437.json`.
SHA-256: `055cd51a7b08b92c9e4ceb065d1204442ad4eefef7aba9cc30e1460c6bd42fec`.

Identity case: 76.679 ms total, first write 43.870 ms, four later writes
25.106 ms, two searches 2.736 ms. Single-write harness case: 45.079 ms total.
These are local diagnostic measurements, not proof of improved CI reliability
or a reproduced root cause. Windows CPU accounting is coarse; a reported zero
does not prove that an operation consumed no CPU.

## Decision 4: Make missing diagnostic evidence visible

Date: 2026-09-20. Task: observe the existing holdout.
Spec review identified that a failed final artifact write cannot persist its own
error flag. Emit a fixed content-free warning on that failure, without exception
text, paths or fixture values. Keep the original test/cleanup failure intact.
This changes only diagnostic visibility. Status: RESOLVED.

The warning change passed the original 10 cases / 177 assertions in 3.04 seconds
and focused lint. Spec re-review passed. Root also executed the actual helper and
cleanup source in an isolated VM with artifact output and stderr both throwing:
the original cleanup error remained the thrown object, warning text stayed
content-free, and synchronous operation return/error identity was preserved.
No real filesystem operations were performed by that failure-path check.

Independent Luna spec review and subsequent Sol quality/final review both
passed. The final review included the driver lifecycle and repository coding
standards. No blocking findings remain for this diagnostic-only change. Canonical
validation and the hosted Windows exposure remain separate evidence steps.
