# Validated push receipt

## Problem

`forge validate` and the following `forge push` both run the same full test suite. On Windows this repeats roughly twelve minutes of work without adding evidence when the commit and worktree are unchanged.

## Contract

- A complete successful full validation may write a short-lived, signed local receipt.
- The receipt is bound to the canonical worktree, exact HEAD, clean worktree, runtime, and required gate results.
- `forge push` always runs branch protection and lint. It may reuse the receipt only for the duplicate test step.
- Missing, malformed, changed, expired, future-dated, or unverifiable evidence falls back to the full suite.
- Targeted, skipped, zero-test, failed, or interrupted validation never produces reusable evidence.
- `forge push --quick`, raw `git push`, GitHub CI, and team sync keep their existing behavior.

## Verification

Focused tests cover issuance, accepted reuse, rejection/fallback, tampering, expiry, changed HEAD/worktree, paths with spaces, and linked-worktree scope. The exact committed head then runs full validation once, followed by a normal `forge push` that proves branch/lint execution and test reuse.
