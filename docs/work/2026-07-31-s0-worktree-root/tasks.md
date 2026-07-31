# Tasks: worktree project-root fix

## Task 1 — regression and implementation

- Read current worktree command and focused tests.
- Add a real-git regression test in `test/commands/worktree-base.test.js` (or the closest focused worktree test) that sets `process.cwd()` to an unrelated temp directory while passing the repo root as `projectRoot`; include `INIT_CWD` in the setup so the reproduction is explicit.
- Run only the new test and record deterministic RED failure showing git was run from ambient cwd / not a repository.
- Implement the smallest fix in `lib/commands/worktree.js`: every Git subprocess needed for worktree create must execute against the resolved project root/common repo. Preserve existing `-C` calls and all non-git behavior.
- Run focused tests for `test/commands/worktree.test.js` and `test/commands/worktree-base.test.js`; record GREEN evidence.
- Do not modify forbidden shared files or push/open/merge/close.

## Review gates

- Spec reviewer: verify the reproduction, exact root routing, preservation of branch/base/linkage/dependency behavior, and Windows-safe invocation.
- Quality reviewer: inspect diff, test determinism/cleanup, subprocess argument safety, and focused validation.
- Any finding requires a fresh fix/re-review cycle before commit.
