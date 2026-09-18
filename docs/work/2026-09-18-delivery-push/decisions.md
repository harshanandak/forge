# Delivery push decisions

## Decision 1

**Date**: 2026-09-18
**Task**: Task 3 — Recover push-runner parity without losing newer receipt work
**Gap**: The approved task assumed `scripts/test.js` exposes an explicit full selector, but its CLI only distinguishes `--validate` from the default diff-selected pre-push plan.
**Score**: 0 / 14
**Route**: PROCEED
**Choice made**: Reuse the existing `node scripts/test-full-suite.js` supervised full-runner route already used by `validate`. It inherits the checkout cwd/environment, returns nonzero for FAIL or INCOMPLETE aggregates, and leaves full-receipt creation exclusively with `validate`.
**Status**: RESOLVED
