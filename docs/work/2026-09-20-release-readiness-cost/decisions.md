# Release-readiness scan cost

Issue: `b2df9e0d-9bf1-4f1f-a550-f4d8f271d7f5`

## Approved scope

The user approved this as a separate prerequisite to the resource-budget PR on
2026-09-20. Reuse adapter instruction-surface discovery within one synchronous
readiness scan. Preserve all readiness blockers, audit output, helper defaults,
and the real-repository integration test's 15-second deadline. Keep discoveries
fresh between invocations; do not add a global cache or dependency.

The shared entry points are `buildReadinessReport` (release check) and
`writeAuditArtifact` (release audit regeneration and the audit sync script).
The first optimization addresses repeated manifest discovery in file filtering,
classification, and hot-path analysis. Repeated source/AST parsing is outside
this patch unless measurement shows the smaller fix is insufficient.

## Baseline and evidence limits

- Base: `origin/master` at `13268a58d1261e00e0c8e79e0441e529c973decc`.
- The existing issue records a 13.5-second readiness test against a 15-second
  deadline.
- The resource-budget branch's canonical validation failed this unchanged test
  at 15.800994 seconds. Its partial shard contained 2,988 tests and one failure.
  The remaining run was stopped; no passing receipt was produced.
- Those historical timings were collected under different host conditions.
  They establish insufficient headroom, not the size of this patch's speedup.
- The SQLite CI timeout remains unproven and is tracked separately. This patch
  does not establish the earlier merged PR's health.

## Verification contract

Record same-host before/after discovery counts and elapsed cost, prove equivalent
audit/report output, and verify changed manifests are observed on a subsequent
invocation. Run existing regeneration/currentness tests and the unchanged real
readiness test. Independent review precedes one canonical validation on a clean
committed head. Publication requires its passing receipt and an unchanged push.

## Measured change

The real repository has four adapter manifests. The original scan read each
1,623 times: 6,492 reads in one report. The patch reads each twice: once for
surface discovery and once because the manifest itself is audited text. This
reduces total manifest reads to eight without omitting audit content.

| Measurement | Before | After |
| --- | ---: | ---: |
| Manifest reads per real report | 6,492 | 8 |
| Warmed instrumented real report | 1,205 ms | 187 ms |
| Existing named readiness integration case | 1,787.85 ms | 230.31 ms |

These elapsed samples are observational, not a controlled benchmark: the host
reported 100% CPU and 3.69 GiB free RAM before measurement. An earlier baseline
report took 7,952 ms. Filesystem warming and unrelated load affect wall time.
The deterministic read-count reduction is the stronger proof of less work.

Both instrumented real reports returned PASS with zero blockers and the same
SHA-256 of their serialized output:
`ba9250af6b3d8d5ebc7780ce4a6e119d5747ea5fde2572c87cb0103fecabb7b6`.

The new fixture first failed because one audit read its manifest nine times.
The final assertion requires two reads: discovery plus the manifest's audited
content. It passed six assertions covering direct audit discovery, report
reuse, audit equality, and changed surfaces on the next invocation.
The public audit signature stays unchanged; a private helper carries the
invocation's surfaces through shared processing.

The focused six-file caller set passed 137 tests with zero failures and 312
assertions in 8.96 seconds. Targeted ESLint passed with zero lint errors or
warnings; Node emitted an existing module-type notice. `git diff --check` passed.
These focused checks do not replace canonical validation or post-merge proof.

Focused command:

```sh
bun test test/release-readiness.test.js test/commands/release.test.js test/release-readiness-tracked.test.js test/release-readiness-premerge-gate.test.js test/forge-skills-pack.test.js test/sync-d20-audit-script.test.js --timeout 15000
```

The paired diagnostic compiled the original source from `git show
origin/master:lib/release-readiness.js` in memory, counted manifest reads through
`fs.readFileSync`, then compared `JSON.stringify(report)` hashes with the patched
module. Its measurements and RED/GREEN output were returned in Sol's tool
transcript; no separate raw diagnostic script or report JSON was retained.

Independent source reviews passed: Luna checked specification and test coverage;
a separate Sol reviewer checked quality and security. Both verified public API
compatibility, all shared callers, bounded snapshot lifetime, fresh subsequent
invocations and unchanged gates. Neither review reran the test suite.
