# Delivery budget decisions

No specification gaps encountered.

- Keep `--shards N` as the public spelling and treat `N` as a resource budget across the validate and full-suite boundaries.
- Reject an explicit budget that cannot fund one required lane worker before any child process starts.
- Normalize only an automatically selected default up to the required lane cost; never widen an operator-requested budget.
- Report successful runs as requested/effective and rejected runs as requested/minimum/rejected, because a rejected run has no effective execution budget.
- Preserve rejected-budget evidence in validate failure results so callers receive the same requested/minimum/outcome structure emitted before scheduling; focused RED returned synthetic `1/1 tests failed`, while GREEN retained the structure with zero executed-test counts (1 pass, 76 filtered, 0 fail).
- Validate every repeated `--shards` occurrence and keep the last valid value, matching the standalone full-suite parser.
- Reject `--shards` for consumer repositories because their package-owned test command has no Forge resource-budget contract.
- Record requested and effective budgets in full-suite run output; keep validation receipt identity and schema unchanged.

## Release checkpoint, 2026-09-22

Issue: `e0cb0671-735c-4980-944b-286d6f78fe48`.

The five implementation commits were reconciled onto `origin/master` at
`9dac015783200221ea652c378c7cada9da808a8b`. Range comparison preserved all five
patches unchanged; the implementation head is
`9faf94c6118e42201cb90209872830e39d742dab`. The original branch remains recoverable
through `backup/delivery-budget-before-20260921`.

Recorded focused evidence: 127 passed, 13 existing skips, zero failures and
419 assertions in 87.25 seconds across the validate and full-suite runner tests.
Relevant ESLint passed. These checks establish focused behavior, not canonical
validation or merge readiness. No full-suite receipt exists for this head.

The user explicitly postponed full validation. Current host inspection still
shows substantial competing work, including active Vite and Playwright processes;
their ownership and staleness have not been established. Preserve that hold.

The next canonical attempt must retain its native session handle, output and
terminal verdict. Select an explicit supported budget before starting; a smaller
budget reduces declared concurrent worker cost but may increase elapsed time.
Do not treat `--shards 2` as a demonstrated speed improvement or as control over
other applications. Preserve the 25-minute limit and all test assertions.

Sol's independent source review confirms that Windows budget two funds one
subprocess worker and defers the unit lane until that work releases capacity;
exclusive files remain sequential. This can reduce contention at the expense
of elapsed time. Historical summed file timings are not a wall-clock forecast
for that schedule. Completion within 25 minutes on a quiet host remains unproved.

After a passing canonical run, verify the clean head and receipt, push unchanged
through the personal account route, and open the budget PR for review. Resolve
all review threads and verify checks before the human merge. Verify merge-SHA
workflows before closing this issue. Resume the separate memory holdout diagnostic
only after this delivery prerequisite is verified.

If validation fails, preserve the failed head, runtime, selected budget, host
sample, terminal output and available artifacts before choosing another step.
Do not patch unrelated timed-out tests or immediately repeat the full suite.
Windows process stalls remain tracked in
`a04a58d4-9266-4fff-8c1a-24cd6bd014fe`; lost delegated execution handles are tracked
in `4a4f5dd8-8132-4257-a869-c8507ac98468`. Neither is closed by the budget change.

## Measured validation and review checkpoint, 2026-09-24

The user resumed testing. One canonical `node bin/forge.js validate --shards 2`
run at `6121400fe71919222191a01c84ab3fef26ac4cae` passed: 8,777 tests passed,
32 skipped, zero failed, and 28,517 assertions across 617 profiled files. Type
checking was reported as skipped; conflict checks, lint, security and tests
passed. The native session ran from 08:21:31.857Z to 08:43:24.065Z: **21m52s**.
The clean-head receipt verified under Node. The unchanged personal-account push
reused those tests and took **84.6s**, including **37.0s** of team sync.

These are measured completion times, not a controlled speed improvement. Host
samples varied from 49% CPU / 2.7 GiB free RAM to 97% / 1.2 GiB. The profile's
summed JUnit duration includes overlapping suite records and is not wall time.

PR #574 review found that the CLI discarded structured budget details when
rendering success or rejection. Correct the existing output boundary and cover
the public formatting contract. For this output-only review correction, use
focused regressions and strict lint with the documented `forge push --quick`
review path, then verify required CI. The earlier canonical receipt belongs
only to `6121400f`; do not present it as proof for a changed head.

The formatter regressions failed before the correction and passed afterward.
The revised validate test file passed 67 tests with 13 skips, zero failures and
168 assertions in 14.42s; strict file lint passed. Sonar's nested-ternary and
generic-error findings were corrected without suppressions or message changes.

Further review exposed a shared formatting gap: a passing test message could
become the error for a failed lint check, and accepted budget evidence disappeared
when tests failed. Terminal diagnostics must derive from actual failed checks,
including caught exceptions, while ignoring intentionally skipped checks. Budget
evidence is independent of the overall outcome. Verify this outcome matrix at
the public handler boundary rather than adding isolated example-specific fixes.
The four missed scenarios reproduced before the shared correction. The outcome
matrix then passed 18 tests; the complete focused file passed 73 tests with
13 skips, zero failures and 178 assertions in 15.55s. Strict file lint passed.

The largest attributed test file was `test/protected-state-surfaces.test.js`
at 99.037s. Repeated Git fixture setup is a hypothesis to measure separately in
issue `6eb0147a-ea09-4c8a-83dd-ed8c74acb7bc`, preserving all isolation and authority
assertions. No fixture optimization is included in this PR.
