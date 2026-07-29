# Automatic Shepherd Attachment Tasks

## Task 1 — Lock the firing and containment contract

- [ ] RED: add focused tests proving session-start, successful push, and successful
  ship invoke the singleton trigger while ordinary commands do not.
- [ ] RED: add negative tests for CI/test, dry-run, uninitialized,
  `FORGE_SHEPHERD_DISABLE`, and disabled `rail.auto_shepherd` contexts.
- [ ] RED: prove the detached fallback uses the stable common repository root
  instead of the disposable worktree cwd.

## Task 2 — Wire the existing singleton trigger

- [ ] GREEN: call the existing `fireAndForget()` from the three approved seams.
- [ ] GREEN: replace push/ship per-PR auto-watch startup with the repository-wide
  singleton trigger.
- [ ] GREEN: add the CI/test containment guard and stable fallback cwd with no new
  scheduler or daemon implementation.
- [ ] REFACTOR: keep trigger selection in one small shared path and retain
  dependency injection for deterministic tests.

## Task 3 — Prove lifecycle behavior

- [ ] Run the focused trigger, reconcile-executor, lease, watcher-lifecycle,
  push, ship, and session-start tests.
- [ ] Verify open and draft PR adoption, duplicate-start no-op, restart/reconcile,
  current-head verdict/event delivery, orphan reaping, and self-retirement.
- [ ] Verify no detached child survives the containment fixture.

## Task 4 — Update the public contract

- [ ] Update `docs/reference/shepherd.md`, canonical `skills/shepherd/SKILL.md`,
  and generated skill mirrors through the repository sync command.
- [ ] Remove the W-S4c “planned follow-up” wording only after the behavior is
  proven.
- [ ] Run lint and the repository validation suite.

