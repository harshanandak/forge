# Recurring memory holdout timeout: diagnosis and proposed plan

Issue: `5e085fe5-21ff-4d2b-9615-44098d79f492`

Status: diagnostic-first plan approved after independent Sol review; temporary
test instrumentation in development. The cause and plan were explained before
the user authorized implementation with "Then lets work on it".
Base: `9dac015783200221ea652c378c7cada9da808a8b` (merged PR #573).

## Purpose and limits

Make the real memory-recall holdout reliable without concealing slow work or
weakening its assertions. Preserve fresh isolated databases, production memory
read/write paths, privacy, trust, ranking, identity, locking, fail-open behavior,
and the existing 15-second deadline. Preserve the separate resource-budget
branch and the earlier SQLite incident; similar symptoms do not prove one cause.

This is a partial planning invocation: evidence gathering, synthesis and an
independent challenge. A new feature interview, external vendor research, broad
baseline suite and implementation handoff are unnecessary or not reached.

## What happened in CI

[Tests run 35508915897](https://github.com/harshanandak/forge/actions/runs/35508915897)
ran the same merge with Bun 1.4.2 on Windows. Node versions were 24.20.0 and
22.23.2. The Node 24 job failed one test; the Node 22 sibling passed.

| Holdout case | Node 24 | Node 22 |
| --- | ---: | ---: |
| Foreign rows / unseen local memory | 1,801.64 ms | 793.79 ms |
| Suggested authority precedence | 446.84 ms | 276.09 ms |
| Shadow evidence fail-open | 2.09 ms | 2.80 ms |
| Locked SQLite prompt recall | 1,825.78 ms | 1,593.74 ms |
| 26 stronger seen rows excluded | 118.39 ms | 31.45 ms |
| Foreign/suggested superseders | 594.23 ms | 258.25 ms |
| Duplicate recall / oversized hit | 7,956.53 ms | 214.58 ms |
| Common-directory identity | **17,647.41 ms (timeout)** | 296.37 ms |
| Assembled 1,000-row recall | 2,180.15 ms | 375.12 ms |
| Harness rendering | 8,286.64 ms | 160.55 ms |

Node 24 file result: 9 pass, 1 fail, 177 assertions, 40.99 seconds. Full-suite
result: 8,748 passed, 1 failed, 33 skipped, no errors (8,782 tests).

Sources:

- [Node 24 job 106073313172](https://github.com/harshanandak/forge/actions/runs/35508915897/job/106073313172)
- [Node 22 job 106073313190](https://github.com/harshanandak/forge/actions/runs/35508915897/job/106073313190)
- JUnit artifact IDs: Node 24 `10604669221`; Node 22 `10604684125`.

The readiness check changed in PR #573 passed on the failing runner in 173.87 ms;
its manifest-read regression passed in 69.11 ms. The failing holdout file was
unchanged by that PR.

## What the previous fix did

[PR #553](https://github.com/harshanandak/forge/pull/553) moved the holdout into
the exclusive resource lane and added scheduler coverage. Both current jobs
reported `exclusive: files=21, shards=21, concurrency=1, nominal=1, cost=2,
budget=3`. The failed file was exclusive shard 12.

At the exact base, `scripts/test-full-suite.js:581-599` waits for both immediate
and deferred shared lanes before starting exclusive work. Intended overlap with
ordinary suite workers is therefore excluded by the scheduler's control flow.
Surviving descendants or unrelated host activity are not ruled out by that fact;
the retained CI evidence does not measure them.

## Local phase evidence

One baseline run used the original test file and deadline:

```text
bun test --preload <artifact>/preload.js test/e2e/memory-recall-holdout.test.js --timeout 15000
```

Exact base, Bun 1.4.2, Node 24.18.0: **10 tests passed in 3.76 seconds**, command
wall time 3.816 seconds. The host went from 48% to 82% reported CPU and 5.53 to
6.01 GiB free RAM during the sample. This is not identical CI hardware/runtime.

The previously failing case took 100.96 ms locally:

- Five memory writes: 91.793 ms total; first/maximum write: 71.075 ms.
- Two ranked searches: 2.964 ms total.
- Close: 0.229 ms.
- All eleven recursive removals across the file: 10.778 ms total.

The first write to each fresh database costs roughly 40-71 ms locally and
includes lazy open, schema/FTS initialization and insertion. The profiler does
not separate those internal phases. The only profiled native operation over
100 ms was the intentionally locked database read: 1,808.936 ms wall / 16 ms CPU.
It is part of an existing locking/fail-open scenario, not evidence of this stall.

Retained local artifacts:

```text
C:/Users/harsha_befach/AppData/Local/Temp/forge-memory-holdout-profile-20260920-sol/
  preload.js
  phase-profile.json
  bun-test.log
  run-metadata.json
```

## What we can and cannot conclude

Confirmed: several operations became much slower in the failed CI job; the
problem is not confined to one assertion. The local run did not reproduce it.
Node major version alone is not established as the cause: both jobs execute
the holdout through the same Bun version, and older evidence has also shown
Node 22 slower than Node 24.

Multi-row fixtures incur avoidable autocommit boundaries. However, the three
slow late cases use two, five and **one** writes respectively. Repeated per-row
commits alone cannot explain the single-write case's 8.29-second duration.
Neither SQLite durability, schema initialization, host scheduling, orphan
processes nor filesystem latency is yet established as the cause of the CI stall.

## Preserve and assess existing work

The old `fix/memory-holdout-transaction` worktree is preserved at `de3e383b` with
uncommitted changes only to `CHANGELOG.md` and the holdout test. It has no unique
commits and no PR; its base is 16 commits behind this plan's base. The original
holdout test is byte-identical between those bases.

That patch extracts an existing `BEGIN` / `COMMIT` / `ROLLBACK` fixture pattern
into `writeMemoryBatch`, batches multi-row setup and keeps real assertions.
It is a candidate optimization to reuse, not proof that the current stall is
fixed. Keep one-row and locking scenarios intact. Do not overwrite the old
worktree or recreate its patch from memory.

## Proposed sequence

1. Capture bounded phase evidence during the normal full Windows CI run, before
   naming a root fix. Keep fixture operations, inputs, assertions and deadlines
   unchanged. Add temporary, test-local timing around first record, later records,
   search, close and cleanup. Reuse the local profiler's mechanism; initially keep
   lazy open/schema/FTS/insert in the first-record aggregate and split it only if
   it dominates. Record wall time, process CPU time, counts and stable case labels,
   never memory contents, queries, SQL values or temporary filesystem paths.
   Keep the original failure visible. Do not build a general telemetry service.
2. Select the repair from the measured phase. If later records/commits account for
   the excess cost, compare the preserved batching candidate against the baseline
   with identical data and assertions. Record transaction boundaries and elapsed
   phases; prove error/rollback behavior. If first-write initialization, reads or
   low-CPU waiting dominates, do not call batching the timeout fix: diagnose that
   shared phase instead. Low CPU narrows the search to waiting/descheduling; it
   does not independently prove a lock, filesystem cause or host overload.
3. Review the selected patch, run focused affected checks, then one canonical
   validation on a clean commit and unchanged receipt-reusing push. Require the
   hosted Windows lanes and exact merge checks to finish healthy. Record remaining
   uncertainty even when a run passes.

## Smallest supported diagnostic route

Independent Sol review recommends diagnostic-first, before the existing batching
patch. A separate standalone rerun would lose the suite history that preceded the
failure, so preserve the current full-suite invocation and exclusive lane order.

- Sol owns the temporary change to `test/e2e/memory-recall-holdout.test.js` only.
  Root owns issue state, review, integration and publication. No concurrent writer
  edits the driver, runner, workflow or preserved batching worktree.
- Flush a bounded phase summary atomically after each test to a uniquely named
  JSON sibling under `test-results/`. Preserve synchronous/async method behavior,
  return values and exceptions. No retry or swallowed test failure. Account for
  instrumentation overhead outside the timed database operation.
- Existing `.github/workflows/test.yml:131-139` runs the canonical suite and
  always uploads `test-results/`. Runner cleanup at
  `scripts/test-full-suite.js:1044-1046` removes its own generated suite directory;
  a sibling diagnostic artifact survives. No workflow edit, writer prerequisite,
  public CLI option, general profiler or dependency is needed.
- After normal local validation and publication of the diagnostic commit, use
  the existing `workflow_dispatch` on that exact branch and verify its resolved
  head. Non-PR events select the full OS matrix; a test-only PR can otherwise
  skip it. Capture one natural Windows Node 22/24 exposure, without retries
  substituted for proof. Verify the exact dispatch SHA before comparing results.
- The observed timed-out file continued through its remaining cases, so an
  `afterEach` summary is viable for that failure mode. A hard process kill may
  retain only summaries from earlier cases; state that limit rather than treating
  an absent phase as fast or successful.
- If the stall does not recur, keep the cause unproven and retain the evidence.
  Do not enter an open-ended rerun loop or declare batching a reliability repair.
  Any demonstrated fixture improvement can be evaluated separately.
- Keep diagnostics in a separate commit from the selected fix. Remove temporary
  capture before final landing, retain the evidence in this work record, and
  require the ordinary uninstrumented checks to pass on the final head.

The approved implementation tasks are in `tasks.md`; execution decisions are in
`decisions.md`. Approval covers this diagnostic sequence, not a speculative
production SQLite rewrite. The resource-budget patch stays separate.

## Success criteria and stop rules

- A deterministic explanation for reduced work, not only a green run.
- Every existing functional, privacy and timing assertion remains in place.
- Evidence includes the currently failing case, the slow single-write case,
  a multi-row case, and the intentional locking scenario.
- No global cache, shared mutable fixture database, new dependency, timeout
  increase, retry-based acceptance, skipped gate or migration rewrite.
- If instrumentation changes the measured behavior materially, record that
  limitation rather than presenting the profile as equivalent execution.
- If hosted evidence still cannot isolate the phase, keep the incident open;
  report the measured optimization separately from reliability completion.
- Any production behavior, schema or public API change requires a revised
  concrete plan before implementation. Unknown cause is not permission to rewrite.
