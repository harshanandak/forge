# Preflight Bootstrap Script Tasks

**Feature:** preflight-bootstrap
**Issue:** forge-byvq
**Date:** 2026-04-26

## Task 1: Add preflight script tests

OWNS: `test/scripts/preflight.test.js`

File(s): `test/scripts/preflight.test.js`

What to implement: Add Bun tests that execute `scripts/preflight.sh` with mocked `bd`, `jq`, and `gh` commands in a temporary PATH. Cover the exit-code contract and key command calls.

TDD steps:

1. Write test: `test/scripts/preflight.test.js` asserts happy path exits 0, uninitialized Beads path runs `bd init --database forge --prefix forge` and exits 1, missing/unauthenticated GitHub path exits 2 with guidance.
2. Run test: confirm it fails because `scripts/preflight.sh` does not exist.
3. Implement: none in this task.
4. Run test: keep failing RED output as evidence for Task 2.
5. Commit: `test: add preflight bootstrap coverage`

Expected output: Bun reports failing tests due to the missing preflight script.

## Task 2: Implement preflight bootstrap script

OWNS: `scripts/preflight.sh`

File(s): `scripts/preflight.sh`

What to implement: Add the Bash preflight script with tool checks, GitHub auth check, Beads initialization probe/init, Beads doctor repair, deterministic output labels, Windows install hints, and exit code precedence.

TDD steps:

1. Write test: use Task 1 tests.
2. Run test: confirm RED failure from missing behavior.
3. Implement: `scripts/preflight.sh` helper functions for `ok`, `fixed`, `action`, tool checks, `gh auth status`, `bd show --json forge-byvq`, `bd init --database forge --prefix forge`, and `bd doctor --fix --yes`.
4. Run test: `bun test test/scripts/preflight.test.js` passes.
5. Commit: `feat: add preflight bootstrap script`

Expected output: Bun reports all preflight tests passing.

## Task 3: Final verification

OWNS: none

File(s): `scripts/preflight.sh`, `test/scripts/preflight.test.js`

What to implement: Run focused verification for the new script and inspect git status.

TDD steps:

1. Write test: covered by Task 1.
2. Run test: `bun test test/scripts/preflight.test.js`.
3. Run pre-push validation: `node scripts/test.js --pre-push`.
4. Implement: no additional code unless verification finds a defect.
5. Run test: rerun focused test after any fix.
6. Commit: no commit unless a verification fix is needed.

Expected output: Focused preflight tests pass and changed files are limited to the requested artifacts plus plan/dev docs.
