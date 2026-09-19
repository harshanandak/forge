# Smart-status CRLF fixture tasks

Issue: `c8ece1ef-e410-45b8-98bc-ca184fa4f828`

## Task 1: Preserve CRLF coverage with fewer Windows processes

**Files:** `test/scripts/smart-status.helpers.js`, `test/scripts/smart-status.basics.test.js`

**Scope:** Select the resolved native jq executable on Windows only after a bounded raw-byte probe proves successful, nonempty output ending in CRLF. Otherwise create the existing CRLF-producing wrapper. Pass the selected command through `JQ_CMD`, preserve the full smart-status arithmetic assertions and the unchanged 20-second case deadline, and clean only temporary directories created by the helper.

**TDD:**

1. Add a focused regression proving the selected command emits nonempty output ending in exact `0D0A` bytes and uses native jq on Windows only after that proof.
2. Add a focused regression with a deliberately failing jq executable; demonstrate RED because the current `jq | awk` wrapper returns success.
3. Add the minimal native selection and wrapper failure propagation.
4. Run each changed fixture regression and the existing full smart-status CRLF arithmetic case sequentially. Record counts and elapsed time.

**Acceptance:** Native Windows coverage uses genuine jq CRLF output without the per-call wrapper; non-Windows retains genuine CRLF wrapper output; upstream jq failure is nonzero; the full script case remains strict and passes inside 20 seconds; production files are unchanged.

## Task 2: Document the fixture reliability fix

**Files:** `CHANGELOG.md`, `docs/work/2026-09-19-smart-status-crlf-fixture/decisions.md`

Record the Windows fixture optimization, failure propagation, focused RED/GREEN evidence, and the limits of the proof. Do not claim the isolated pass proves host contention or resolves every smart-status timing path.

## Status

Implementation and focused validation are complete. Independent spec and quality review remain pending; no commit has been created.
