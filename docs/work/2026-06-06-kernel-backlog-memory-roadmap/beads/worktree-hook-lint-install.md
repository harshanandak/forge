## Description
Worktrees can miss Lefthook/lint setup or have stale hook paths, so local validation may not actually run where agents are working.

Reference: `docs/work/2026-06-06-kernel-backlog-memory-roadmap/workflow-friction-amendments.md#4-hooks-and-lint-checks-are-not-reliably-installed-in-worktrees`

## Scope
- Extend `forge hooks doctor --json` to inspect linked worktrees, git common-dir hooks, `core.hooksPath`, Lefthook install state, lint command availability, and agent adapter status.
- Define exact Git path checks: main worktree vs linked worktree, `git rev-parse --git-common-dir`, `git rev-parse --git-path hooks`, and relative/absolute `core.hooksPath` normalization.
- Define lint discovery order: Forge workflow config, package-manager scripts, repo-local binaries, and explicit fallback command.
- Implement safe `forge hooks install/sync` repair behavior for worktree-local adapters.
- Support `--json` and `--dry-run` for doctor/install/sync.
- Surface hook/lint installation status in `forge validate` and `forge push` before claiming gates are active.
- Keep Lefthook as an adapter; Forge policy engine remains authority.
- Do not write global/private agent profiles without explicit authorization.

## Acceptance Criteria
- Doctor detects missing, stale, disabled, or misdirected worktree hook/lint setup.
- Repair commands are explicit, narrow, and safe for Windows/MSYS and POSIX worktrees.
- Tests cover normal checkout, linked worktree, missing Lefthook, stale `core.hooksPath`, and absent lint command.
- Protected workflow/hook files are only changed through Forge-owned protected-state-aware surfaces.
- `forge push` cannot silently claim local gate coverage when worktree hook/lint setup is absent.
