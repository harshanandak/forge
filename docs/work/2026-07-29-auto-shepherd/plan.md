# Automatic Shepherd Attachment

Issue: `49f438f0-6308-4c12-bae7-62258b7eb517`

## Purpose

Make the existing singleton Shepherd reconciler automatically own every open or
draft pull request during an active Forge session without relying on an agent to
remember a polling command. Preserve the existing disable controls and prevent
test runs or disposable worktrees from leaking detached processes.

## Implemented flow

- `lib/pr-monitor/reconcile-executor.js` already owns repository-wide discovery,
  singleton lease arbitration, watcher restart/reaping, Kernel PR state, verdicts,
  events, and self-retirement.
- Its `fireAndForget()` trigger is called only after successful session-start,
  push, and non-dry-run ship operations.
- `forge push` and `forge ship` wake the repository-wide singleton instead of
  starting separate detached per-PR watchers.
- `bin/forge.js` explicitly rejects an every-command dispatch-finally trigger.
- `forge hooks session-start` is the existing automatic session entry seam.

## Design

Use one ownership mechanism: the existing singleton reconcile daemon.

1. Invoke `fireAndForget()` only from:
   - the successful `forge hooks session-start` path;
   - successful `forge push`;
   - successful non-dry-run `forge ship`.
2. Replace the push/ship per-PR detached watcher launch with the singleton trigger.
   The daemon discovers all open and draft PRs, including PRs created outside Forge.
3. Keep ordinary commands free of launch side effects; do not add dispatch-finally
   wiring.
4. Make `fireAndForget()` inert before lock or process work in dry-run,
   uninitialized-repository, CI/test, `FORGE_SHEPHERD_DISABLE`, and disabled
   `rail.auto_shepherd` contexts.
5. Prefer a supplied harness background-shell capability. For the detached
   fallback, launch from the repository's stable common root rather than a
   disposable feature-worktree cwd; retain singleton lease arbitration,
   `windowsHide`, `unref`, verified child cleanup, and self-retirement.

### Review clarifications

- **Every successful push fires.** The push seam does not run `gh pr view` or
  require a locally resolvable PR number. It calls `fireAndForget()` after
  `git push` succeeds; the singleton daemon then enumerates every open or draft
  PR itself. A push with no locally resolved open PR therefore still wakes the
  repository-wide reconciler.
- **Containment is injected and ordered.** `fireAndForget()` evaluates
  `ctx.env || process.env` first. It returns inert when
  `FORGE_SHEPHERD_DISABLE` is set, `NODE_ENV` or `BUN_ENV` equals `test`, or any
  of `CI`, `GITHUB_ACTIONS`, or `GITLAB_CI` is set. It then checks, in order:
  project root, dry-run, existing Kernel initialization, and
  `rail.auto_shepherd`. Only after every guard passes may it resolve repository
  state, arbitrate the lease, or launch a background/detached process. The same
  zero-side-effect contract applies at all three approved seams: no lease,
  Kernel state, child process, or detached-child cleanup is created on a
  disabled path.

## Boundaries

- Shepherd still never merges and never resolves review threads.
- Conditional auto-merge policy and branch updating remain separate issues.
- No new scheduler, heartbeat, watcher implementation, or per-command hook.
- No gate, quiet-period, current-head, checks, or review-thread rule is weakened.

## Acceptance criteria

- An open or draft PR fixture is registered and monitored after session start
  without an explicit Shepherd command.
- Every successful push (including when no open PR resolves locally) and every
  successful non-dry-run ship trigger the singleton reconciler, not an
  additional per-PR detached watcher.
- Ordinary commands do not launch Shepherd.
- CI/test, dry-run, uninitialized, environment-disabled, and rail-disabled paths
  create no lease, Kernel state, or child process.
- Concurrent triggers yield at most one daemon; killed watchers are restarted,
  verified orphans are reaped, current-head verdict/events are preserved, and the
  daemon self-retires when no PR remains.
- The detached fallback does not hold a disposable worktree as its cwd.
- Focused Shepherd tests, lint, and the repository validation suite pass.
