# Automatic Shepherd Attachment Tasks

## Task 1 — Lock and wire the firing and containment contract

- [x] RED: add focused tests proving session-start, successful push, and successful
  ship invoke the singleton trigger while ordinary commands do not.
- [x] RED: add negative tests for CI/test, dry-run, uninitialized,
  `FORGE_SHEPHERD_DISABLE`, and disabled `rail.auto_shepherd` contexts.
- [x] RED: prove the detached fallback uses the stable common repository root
  instead of the disposable worktree cwd.
- [x] GREEN: call the existing `fireAndForget()` from the three approved seams.
- [x] GREEN: replace push/ship per-PR auto-watch startup with the repository-wide
  singleton trigger.
- [x] GREEN: add the CI/test containment guard and stable fallback cwd with no new
  scheduler or daemon implementation.
- [x] REFACTOR: keep trigger selection in one small shared path and retain
  dependency injection for deterministic tests.

## Task 2 — Prove lifecycle behavior

- [x] Run the focused trigger, reconcile-executor, lease, watcher-lifecycle,
  push, ship, and session-start tests.
- [x] Verify open and draft PR adoption, duplicate-start no-op, restart/reconcile,
  current-head verdict/event delivery, orphan reaping, and self-retirement.
- [x] Verify no detached child survives the containment fixture.

## Task 3 — Update the public contract

- [x] Update `docs/reference/shepherd.md`, canonical `skills/shepherd/SKILL.md`,
  and generated skill mirrors through the repository sync command.
- [x] Remove the W-S4c “planned follow-up” wording only after the behavior is
  proven.
- [x] Run lint and the repository validation suite.

## Task 4 — Repair P0 lifecycle and current-head regressions

- [x] RED: reproduce a foreign-lease loser retained by a ref-ed handle and a
  lease owner that loses ownership while convergence fails.
- [x] GREEN: exit on acquisition loss and verify ownership before, after, and
  on failure of every pass; keep the status file separate from debounce state.
- [x] RED/GREEN: compare divergence and conflicts against `state.headSha`, with
  legacy `HEAD` defaults and fail-closed handling for a missing explicit object.
- [x] RED/GREEN: centralize journal and claim paths through the Git common dir
  so all worktrees share one cursor authority.
- [x] Verify the 90-second TTL margin, 30-second blocked-listing takeover,
  no-open lease cleanup, shared events path, and focused regression suite.
