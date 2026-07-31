# Plan: resolve project root for worktree git operations

- Issue: `8606ea93-67c5-4805-ad91-01622fe4a0cf`
- Classification: Simple bug fix; execute TDD-first `/dev` → focused `/validate`.
- Scope: `lib/commands/worktree.js`, focused worktree tests, and this unique work log only.
- Forbidden: shared files named by the issue lane instructions (including `package.json`, lockfiles, AGENTS, and unrelated activation/config files).

## Problem

The command handler receives a resolved project root, but the `git worktree add` and branch probe subprocesses are invoked without `-C`, so they use the ambient process cwd. When Forge is launched outside the repository with `INIT_CWD` pointing at the project, creation fails with `fatal: not a git repository`.

## Approach

1. Add a regression test that runs the real handler while `process.cwd()` is an unrelated temporary directory and passes the actual temporary repository as `projectRoot` (the same invariant produced by `INIT_CWD` project resolution).
2. Capture RED evidence before changing production code.
3. Route every git subprocess used by create through the resolved project root using `git -C <projectRoot>`, preserving argument ordering, base selection, linkage, and dependency behavior.
4. Run focused worktree tests and relevant lint/type checks only.
5. Obtain serialized independent spec and quality reviews, fix and re-review any findings, then commit only lane-owned files.

## Acceptance criteria

- `git worktree add` succeeds from an ambient cwd outside the repo when `projectRoot` points to the repo.
- All git subprocesses involved in create use the resolved project root/common repository.
- Existing branch/base/linkage/dependency behavior and Windows Git Bash compatibility remain intact.
- Regression test fails for the ambient-cwd reason before the fix and passes afterward.
