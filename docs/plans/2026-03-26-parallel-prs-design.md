# Parallel PRs & Dependency-Aware Merging - Design Doc

- **Feature**: parallel-prs
- **Date**: 2026-03-26
- **Status**: Phase 1 complete
- **Beads**: forge-puh (Layer 2 of forge-qml5 epic)
- **Depends on**: forge-w69s (merged PR #92 — session awareness, conflict detection, file index)

---

## Purpose

Enable developers running multiple parallel features (each with their own branch/worktree/PR) to coordinate merges safely. Currently, forge-w69s provides cross-developer conflict *detection* (who's working where), but there is no:

- PR-level dependency tracking ("PR #24 depends on PR #23")
- Merge order guidance ("merge this first, then rebase that")
- Merge conflict simulation before attempting real merge
- Automatic file index updates as work progresses during `/dev`
- Rebase guidance after a PR merges

This causes:
- Merge conflicts discovered only at merge time, requiring manual investigation
- Wrong merge order breaking dependent branches
- Stale conflict detection because file index isn't updated during development
- No visibility into which branches need rebasing after a merge lands

## Success Criteria

1. **PR dependency tracking** — `pr-coordinator.sh dep add <issue-a> <issue-b>` records that issue-a's PR depends on issue-b's PR being merged first. Stored via `bd set-state` on the issue. Circular dependencies rejected at creation time.
2. **Merge order recommendation** — `pr-coordinator.sh merge-order` reads the `bd dep` graph + PR state and outputs a topologically sorted merge sequence. Handles ties (independent PRs can merge in any order).
3. **Soft-block at `/ship` and `/plan`** — When entering these stages, if overlapping in-flight PRs are detected (via file index + merge simulation), warn with conflict details and "proceed anyway?" prompt. Never hard-block.
4. **Rebase guidance after merge** — `pr-coordinator.sh rebase-check` scans all open branches and identifies which need rebasing and why (files changed in the merged PR that overlap with the branch).
5. **Abandoned worktree detection** — `/status` flags worktrees with no commits in >48 hours as potentially abandoned.
6. **Auto file-index updates during `/dev`** — After each task commit in `/dev`, append updated file list to `.beads/file-index.jsonl` so conflict detection stays current throughout the session.
7. **Merge simulation dry-run** — `pr-coordinator.sh merge-sim <branch>` runs `git merge --no-commit --no-ff` + `git merge --abort` to detect actual git conflicts before attempting real merge. Results are ephemeral (not cached — always re-run at decision time).
8. **PR label auto-tagging** — After `/ship` creates a PR, auto-add labels via `gh pr edit --add-label`: `has-dependencies`, `blocks-others`, `needs-rebase` based on current state.

## Out of Scope

- Auto-merging PRs (humans always merge — enforced by existing PreToolUse hook blocking `gh pr merge`)
- Hard-blocking workflow gates (all checks are advisory with confirmation prompts)
- Real-time WebSocket coordination (deferred to forge-ognn, P4)
- Cross-repository/fork PR coordination
- AST-level merge conflict analysis (deferred to forge-ognn, P4)
- PR review assignment or approval workflows (GitHub handles this natively)

## Approach Selected: Extend Existing Scripts (Approach 1)

### Why not a centralized coordinator module (Approach 2)?
Forge uses focused, single-purpose scripts that source each other (sync-utils.sh, conflict-detect.sh, file-index.sh). A centralized module would require refactoring working code for no functional gain and break the established pattern.

### Approach 1 Details

1. **New `scripts/pr-coordinator.sh`** — Single new script handling:
   - PR dependency tracking (CRUD operations on `bd set-state` fields)
   - Merge order computation (topological sort of issue dependency graph)
   - Merge simulation (git merge dry-run)
   - Rebase guidance (scan open branches for overlap with merged PR)
   - PR label management (gh pr edit --add-label/--remove-label)
   - Abandoned worktree detection (scan `.worktrees/` for stale branches)

2. **Extend `scripts/file-index.sh`** — Add `auto-update` subcommand called after each `/dev` task commit. Appends updated file list to JSONL. Backward compatible: existing subcommands unchanged.

3. **Extend workflow gates** — Add soft-block prompts to `/plan` and `/ship` command files. These call `pr-coordinator.sh merge-sim` and `conflict-detect.sh` (existing), then present findings with confirmation prompt.

4. **PR state via Beads** — Store on each issue via `bd set-state`:
   - `pr_number` — GitHub PR number (null if no PR yet)
   - `pr_branch` — Branch name
   - `pr_depends_on[]` — Issue IDs this PR depends on
   - `pr_merge_ready` — Boolean (no conflicts, dependencies satisfied)
   - `pr_labels[]` — Current auto-managed labels

### Backward Compatibility Contract

All existing scripts from forge-w69s maintain their current interfaces:

| Script | Guarantee |
|--------|-----------|
| `conflict-detect.sh` | Same CLI flags, same exit codes (0/1/2), same output format |
| `sync-utils.sh` | Same functions (auto_sync, get_session_identity, detect_sync_branch), same env vars |
| `file-index.sh` | Same subcommands (update, query, clean). New `auto-update` subcommand is additive only |
| `dep-guard.sh` | Same subcommands and exit codes. No modifications planned |
| `beads-context.sh` | Same subcommands. No modifications planned |

New functionality is additive only. No existing function signatures, exit codes, or output formats change.

## Constraints

1. **No external services** — Everything git-native (no WebSocket, no database beyond Beads SQLite + JSONL)
2. **No auto-merge** — System recommends merge order and warns about conflicts, humans always merge
3. **No hard-blocks** — All checks are advisory with confirmation prompts, never prevent work
4. **No cross-repo** — Only tracks PRs and branches within the same repository
5. **Backward compatible** — All forge-w69s script interfaces preserved exactly

## Edge Cases

### A) Circular PR dependencies
Reject at creation time: "circular dependency detected: forge-xxx → forge-yyy → forge-xxx". Uses same cycle detection as `bd dep cycles`.

### B) Merge simulation says "conflict" but developer wants to proceed
Show conflicted files, warn, allow proceed (soft-block per constraint #3). Log override via `bd comments add`.

### C) File index is stale when `/ship` runs
Warn with staleness duration: "file index is 43 min stale — conflict detection may be incomplete." Don't block.

### D) PR closed without merge — is the issue resolved?
Dependencies live at the **Beads issue level**, not PR level:
1. If the Beads issue linked to the closed PR is closed/done → dependency satisfied, clear automatically
2. If issue is still open → work moved to a new PR. Auto-detect new PR for that issue (via `Closes beads-xxx` in PR body) and update the PR number in `bd set-state`
3. If issue is open but no new PR exists → flag at `/status`: "forge-xxx is still open but has no active PR. Your work depends on it."

### E) Two PRs touch same files but no Beads dependency exists
Soft-block at `/ship`: "PR #25 and PR #26 both modify `scripts/conflict-detect.sh` but have no dependency. Add one, or proceed?"

### F) Merge simulation result goes stale after rebase/force-push
Never cache simulation results. Always re-run `git merge --no-commit --no-ff` at decision time (`/ship` entry).

### G) Developer merges PR outside Forge (directly in GitHub UI)
At `/status` and `/ship` entry, run `gh pr view --json state` for tracked PRs. If PR is merged but Beads issue is still open, flag: "PR #23 was merged but forge-xxx is still open. Close it?"

### H) Multiple PRs for the same Beads issue
PR index (via `bd set-state`) supports updating the PR number. Dependency is satisfied only when the **issue** is closed, not when any single PR merges.

### I) Merge order has a tie (independent PRs, no overlap)
No recommendation needed — they can merge in any order. Only recommend ordering when dependency or file overlap exists.

## Ambiguity Policy

Use 7-dimension rubric scoring per /dev decision gate:
- >= 80% confidence: proceed and document the decision
- < 80% confidence: stop and ask user
