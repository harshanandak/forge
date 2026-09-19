# Delivery push decisions

## Decision 1

**Date**: 2026-09-18
**Task**: Task 3 — Recover push-runner parity without losing newer receipt work
**Gap**: The approved task assumed `scripts/test.js` exposes an explicit full selector, but its CLI only distinguishes `--validate` from the default diff-selected pre-push plan.
**Score**: 0 / 14
**Route**: PROCEED
**Choice made**: Reuse the existing `node scripts/test-full-suite.js` supervised full-runner route already used by `validate`. It inherits the checkout cwd/environment, returns nonzero for FAIL or INCOMPLETE aggregates, and leaves full-receipt creation exclusively with `validate`.
**Status**: RESOLVED

## Decision 2

**Date**: 2026-09-19
**Task**: Invocation proof lifetime and revocation
**Gap**: A shared marker cannot compare-and-delete atomically if another push replaces it between the read and unlink operations.
**Score**: 5 / 14
**Route**: BLOCKED — resolved by the spec owner
**Choice made**: Store one signed proof per nonce under worktree-private Git metadata. The Git child receives only its nonce, each push deletes only its own file, and exact process identity invalidates crash residue without a lock or registry.
**Status**: RESOLVED

## Decision 3

**Date**: 2026-09-19
**Task**: Existing unparameterized hook predicates
**Gap**: `lefthook.yml` is protected and has no sanctioned active-root-config writer in scope.
**Score**: 2 / 14
**Route**: PROCEED after spec-owner review
**Choice made**: Leave all three hook calls unchanged. A full proof signs exactly branch protection, lint, and tests; a quick proof signs exactly branch protection and lint and also requires the existing quick child lane. Any other shape runs ordinary hooks.
**Status**: RESOLVED

## Refresh and focused validation evidence

**Date**: 2026-09-20
**Base**: Rebased the two reviewed delivery-push commits onto healthy merge `460dc14b`. The only manual conflict was `CHANGELOG.md`; all upstream reliability entries and both delivery-push entries were retained. The automatic `test/validation-receipt.test.js` merge retains the failed-full-suite stale-receipt negative alongside the push-proof state, mutation, and receipt-separation negatives.
**Focused result**: `bun test --timeout 15000 test/commands/push.test.js test/validation-receipt.test.js test/check-forge-token.test.js test/commands/github-indirect-routes.test.js test/pr-monitor/auto-trigger-wiring.test.js test/push-backing-issue.test.js` passed 112 tests, failed 0, with 392 expectations in 18.77 seconds.
**Publication baseline**: The prior normal push at `ada0c8ee` explicitly reused its validation receipt but still launched the pre-push test runner, reran 371 tests, and took 110,543 ms. Final publication acceptance requires an exact valid receipt, signed hook acceptance, and zero duplicate hook tests without quick mode, retries, timeout changes, or hook bypass.
