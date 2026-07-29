# Automatic Shepherd Attachment Decisions

## Decision 1

**Date**: 2026-07-29
**Task**: Task 1 — Lock and wire the firing and containment contract
**Gap**: The approved task list separated RED tests from GREEN implementation,
but Forge requires every task to finish with fresh passing tests.
**Score**: 1 / 14
**Route**: PROCEED
**Choice made**: Combine the original Tasks 1 and 2 into one TDD task without
changing their requirements or implementation scope.
**Status**: RESOLVED

## Delivery evidence

- **Task 1**: Commit `cdd08b1c` wires the existing singleton trigger into
  session start, every successful push, and successful non-dry-run ship, with
  the environment/test/CI guards evaluated before project, kernel, rail, lease,
  or child-process work.
- **Task 2**: The focused 14-file lifecycle suite passed with 211 tests passed,
  4 skipped, and 0 failed. It covers trigger containment, stable-root fallback,
  singleton lease behavior, open-PR reconciliation (including drafts), watcher
  restart and cleanup, current-head events, orphan reaping, and self-retirement.
  Every disabled containment scenario explicitly asserts both that no lease is
  acquired and that the injected daemon launcher is not called.
- **Task 3**: The canonical shepherd reference and skill now document the exact
  automatic singleton contract, including the no-local-PR push case and
  zero-side-effect containment precedence. `node scripts/sync-agent-skills.js`
  synchronized the committed `.agents` mirror; its drift/discovery suite passed
  9 tests. `bun run lint` and `bun run check` both passed; the latter ran 266
  tests and reported the repository's existing dependency advisories as
  non-blocking.
- **Review discussions**: `r3671850206` is addressed by explicitly defining
  every successful push as a trigger whose daemon enumerates repository PRs,
  without local PR resolution. `r3671850213` is addressed by defining the
  injected environment predicate and its precedence before all side effects.
