# Decisions log

- 2026-07-31: Treat as a Simple bug fix. Use the required TDD regression plus focused command tests and relevant checks for lane development; this does not waive the protected full-suite CI gate.
- 2026-07-31: Keep the regression in the real-git base-focused test file because it already exercises actual worktree creation and controls temporary repositories.
- 2026-07-31: Prefer explicit `git -C <projectRoot>` arguments over `process.chdir()` in production. This avoids ambient cwd dependence and is compatible with Git Bash on Windows because `execFileSync` still receives an argument vector without a shell.
- 2026-07-31: Do not alter package metadata, shared workflow files, or unrelated command implementations.
