# Memory holdout diagnostic execution

Issue: `5e085fe5-21ff-4d2b-9615-44098d79f492`
User approved the diagnostic-first plan with "Then lets work on it".

## Task 1: Observe the existing holdout without changing its behavior

Owner: Sol implementer. File: `test/e2e/memory-recall-holdout.test.js` only.
Root owns the work documents, issue, commits and publication coordination.

Read the complete test and the existing local preload before editing. Add
temporary test-local timing for first record (including lazy initialization),
later records, search, close and cleanup. Retain all original fixture values,
assertions, timeouts, synchronous/async returns and thrown errors. Capture only
stable case labels, counts and wall/CPU durations. No SQL, query strings, memory
values, paths, environment data or production driver edits.

Flush one bounded JSON summary atomically after each test under `test-results/`
with a process-unique filename. Reuse the current workflow's artifact upload;
do not modify workflow, scheduler or public CLI. Capture partial evidence through
ordinary test failure without masking the failure. A hard process kill may lose
the currently running case; document this limit. Keep measurement overhead out
of the measured operation where possible. Do not apply the old batching patch.

Validation: retain the original 10 test cases; demonstrate that the unmodified
file emits no phase artifact, then run the instrumented file at 15000ms and
inspect the artifact's counts, duration fields and absence of fixture secrets or
absolute paths. Run focused lint. Review exception/cleanup behavior explicitly.
This is test instrumentation, not production behavior requiring a synthetic new
product test suite. No canonical full suite from the implementer.

## Task 2: Review, publish and expose the diagnostic head

Root obtains spec review followed by quality review, preserves the probe and
baseline evidence, commits the scoped patch, and performs normal validation.
Run at most one broad suite locally. Use the personal GitHub binding and normal
receipt-reusing push. Invoke the existing Tests workflow_dispatch on the exact
published branch, verify the resolved SHA, and collect both Windows Node 22/24
artifacts from the normal full-matrix path. This diagnostic head is not a final
reliability fix to merge merely because it passes.

## Task 3: Select the measured repair

Root compares phase evidence across cases/runtimes. Reuse the preserved fixture
batching patch only if later writes/commits explain the extra cost. If another
phase dominates, scope the root repair to that phase before implementation. A
passing exposure without recurrence leaves the cause unproven; no rerun loop.
Remove temporary instrumentation before final landing and preserve evidence.
Keep the resource-budget and prior SQLite-driver work separate.
