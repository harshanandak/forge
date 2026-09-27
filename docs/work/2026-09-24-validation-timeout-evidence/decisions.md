# Decisions

## 2026-09-24

Independent Claude review disproved the previous interpretation of five JUnit
files as a finished run waiting for shutdown: 17 exclusive files were required,
only the first completed, and the second was still running at timeout. Stdout
containing the lane inventory was dropped by the timeout return path.

Repair this evidence-loss defect separately from dependency-ripple duplicate
lookup optimization. Reuse existing result fields and output helpers; avoid a
new instrumentation framework. Root owns the proved lease as
`delivery-reliability-root-20260924`.

## Focused implementation evidence

Six nonempty-output timeout cases failed before the fix. Afterward, all nine
focused cases passed; the command file had 84 pass, 13 pre-existing skips and
0 failures. Strict lint passed. Both ETIMEDOUT and killed SIGTERM preserve
available stdout/stderr while remaining failures with zero partial counts;
the receipt predicate still rejects completion. Ordinary failure rendering is
unchanged. Raw evidence is in ignored `test-results/validation-timeout-evidence/`.

Root accepts an internal `timedOut: true` flag rather than matching error prose
or expanding rendering to every failure. No CLI surface, scheduler, deadline,
or gate was changed. Independent specification and quality review are still
required before canonical validation. No successful receipt is claimed.

## Independent review and landing selection

Separate Claude Opus 5.5 specification and quality reviewers approved both
modified files with no blockers. The repeated budget line is accepted to keep
captured output intact without adding presentation filtering. The existing
SIGTERM classification can also label a maxBuffer termination as a timeout;
that predates this change and requires a separate follow-up.

This branch is the next validation candidate because it preserves useful
failure evidence. A fresh fetch found zero commits behind origin/master.
Canonical validation remains pending: three brief Windows CIM samples at
13:47:34-37 UTC reported 100 percent CPU and 1.32-1.41 GiB free physical memory.
This is not a diagnosis of previous failures. Keep the supported budget choice
explicit; the prior budget of two serialized subprocess shards and exhausted
the deadline before most exclusive files could run.
