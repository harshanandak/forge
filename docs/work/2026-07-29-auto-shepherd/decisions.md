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

## Decision 2

**Date**: 2026-07-29
**Task**: P0 current-head correctness repair
**Gap**: The adapter API did not identify the authoritative PR head when the
daemon ran from the stable root checkout.
**Score**: 4 / 14
**Route**: SPEC-REVIEWER
**Choice made**: Add optional `headRef` inputs that default to `HEAD`, and have
existing consumers pass `state.headSha` to divergence and conflict prediction.
An unavailable explicit object fails closed to `UNKNOWN`; no build-context
contract was expanded.
**Status**: RESOLVED

## Decision 3

**Date**: 2026-07-29
**Task**: P0 shared journal authority repair
**Gap**: Daemon writers and worktree readers could select different
`.forge/pr-monitor` roots.
**Score**: 4 / 14
**Route**: SPEC-REVIEWER
**Choice made**: Resolve the existing journal from the shared Git common dir,
with legacy per-root fallback when common-dir resolution is unavailable and a
shared metadata fallback for nonstandard common dirs. No new store or migration.
**Status**: RESOLVED

## P0 repair evidence

- RED reproduced a lease-less Bun process kept alive by an unrelated ref-ed
  handle, false `behind=4` from stable-root `HEAD`, and split worktree journals.
- GREEN adds explicit loser exit, pre/post/catch token validation, a 90-second
  lease margin over the 30-second synchronous listing, separate lifecycle
  status, authoritative PR-head comparisons, and shared journal/claim paths.
- The focused 10-file suite passes 245 tests with 0 failed.
- The globally installed `forge.exe` is `forge-workflow@0.1.0-beta.2`; it does
  not contain this branch. Auto-trigger verification therefore uses branch-local
  `bun bin/forge.js` in controlled contexts rather than treating global
  `forge push --quick` as branch proof.
