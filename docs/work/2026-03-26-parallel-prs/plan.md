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

---

## Technical Research (Phase 2)

### DRY Check Results

- **Zero existing PR coordination logic** in the codebase — pr-coordinator.sh is fully greenfield
- **No merge simulation, merge ordering, rebase guidance, or PR label automation** exists anywhere
- **file-index.sh** has a clear insertion point for `auto-update` subcommand (after line 366, following existing `update-from-tasks`)
- **Workflow gate integration**: `/plan` command has conflict check at lines 54-75, `/ship` has freshness check at lines 32-47 — both have clear injection points for new soft-block prompts

### Existing Script Improvements (fix during implementation)

These issues in forge-w69s scripts should be fixed as part of this feature since they directly affect reliability of the parallel PR workflow:

#### Critical (P0 — must fix)

1. **JSONL concurrent append not safe** — `file-index.sh` lines 130, 166, 361. Multiple processes appending to `.beads/file-index.jsonl` simultaneously can corrupt lines. **Fix**: Add `flock -w 5` locking on a `.lock` file during append operations.

2. **jq pipe errors not propagated** — `file-index.sh` lines 323, 328. Pipeline `grep | jq -R . | jq -s -c` fails silently; `set -o pipefail` not set in sourced function context. **Fix**: Add `set -o pipefail` in functions that use jq pipelines, or check intermediate results.

3. **Source command failures silent** — `conflict-detect.sh` line 22, `sync-utils.sh` lines 325-329. `source "$SCRIPT_DIR/file-index.sh"` fails silently if file missing/malformed. **Fix**: Add `source ... || die "Failed to source..."`.

#### High (P1 — should fix)

4. **sanitize() duplicated 4x** — beads-context.sh:28, dep-guard.sh:48, file-index.sh:35, sync-utils.sh variant. **Fix**: Extract to shared `scripts/lib/sanitize.sh` sourced by all scripts. Backward compatible — existing function names preserved.

5. **Missing error check on file index update after sync** — sync-utils.sh line 298. `_auto_sync_update_file_index` called with no return code check. **Fix**: Check return code, warn if file index update fails.

6. **jq not checked before use** — sync-utils.sh line 346. `command -v jq` returns 0 (silent skip) but downstream code may still call jq. **Fix**: Fail loudly with error message.

#### Medium (P2 — fix if touched)

7. **Empty JSONL handling inconsistent** — file-index.sh returns `"[]"`, sync-utils.sh silently skips. **Fix**: Standardize to return empty array `[]` consistently.

8. **dep-guard.sh cycle detection brittle** — Line 38 uses `grep -Eqi` for specific output strings. **Fix**: Check exit code rather than output string matching.

### OWASP Top 10 Analysis

| Category | Applies? | Risk | Mitigation |
|----------|----------|------|------------|
| **A01 Broken Access Control** | Partially | Worktree scanning could follow symlinks outside repo | Use `realpath` + validate path starts with repo root before processing |
| **A02 Cryptographic Failures** | No | No secrets, tokens, or encryption involved | N/A |
| **A03 Injection** | **YES — P0** | Branch names, PR numbers interpolated into `git merge`, `gh pr edit`, `git log` shell commands | Validate: branches `^[a-zA-Z0-9._/@-]+$`, PR numbers `^[0-9]+$`, labels `^[a-zA-Z0-9._-]+$`. Double-quote all variables. Use `--` before branch args. Reuse existing `sanitize()` from sync-utils.sh |
| **A04 Insecure Design** | **YES — P0** | Race condition: two agents appending to JSONL simultaneously. Crash during merge simulation leaves dirty git state | `flock -w 5` for JSONL writes. `trap 'git merge --abort 2>/dev/null' EXIT ERR INT` for merge simulation |
| **A05 Security Misconfiguration** | Partially | Labels created by automation could mislead reviewers if naming is ambiguous | Use namespaced labels: `forge/has-deps`, `forge/blocks-others`, `forge/needs-rebase` |
| **A06 Vulnerable Components** | No | No external dependencies added | N/A |
| **A07 Auth Failures** | No | Local trust model — git credentials already authenticated | N/A |
| **A08 Data Integrity** | Partially | Topological sort with undetected cycle could recommend wrong merge order | Always run `bd dep cycles` before computing merge order. Abort if cycles found |
| **A09 Logging** | Yes | Override decisions (proceeding despite conflicts) need audit trail | Log all soft-block overrides via `bd comments add`. Include: who, what conflict, why proceeding |
| **A10 SSRF** | No | No network requests beyond git remote operations | N/A |

**Validation functions to implement in pr-coordinator.sh:**
```bash
validate_branch_name()  # ^[a-zA-Z0-9._/@-]+$ — reuse pattern from sync-utils.sh
validate_pr_number()    # ^[0-9]+$
validate_label_name()   # ^[a-zA-Z0-9._/-]+$
safe_merge_simulation() # trap-guarded git merge --no-commit --no-ff + abort
atomic_jsonl_append()   # flock-based append to prevent concurrent corruption
```

### TDD Test Scenarios

#### pr-coordinator.sh tests

| # | Scenario | Type | Input | Expected |
|---|----------|------|-------|----------|
| 1 | **Happy path: dep add** | Unit | `dep add forge-aaa forge-bbb` | Exit 0, `bd set-state` called with pr_depends_on including forge-bbb |
| 2 | **Circular dep rejected** | Error | `dep add forge-aaa forge-bbb` when forge-bbb already depends on forge-aaa | Exit 1, error message "circular dependency detected" |
| 3 | **Merge order — linear chain** | Unit | 3 issues: A→B→C | Output: "1. C, 2. B, 3. A" (topological sort) |
| 4 | **Merge order — independent PRs** | Edge | 2 issues with no deps | Output: both listed as "can merge in any order" |
| 5 | **Merge order — cycle detected** | Error | A→B→A | Exit 1, abort with cycle error |
| 6 | **Merge simulation — clean** | Unit | Branch with no conflicts vs master | Exit 0, "No conflicts detected" |
| 7 | **Merge simulation — conflicts** | Unit | Branch with deliberate conflict | Exit 1, list of conflicted files |
| 8 | **Merge simulation — crash recovery** | Edge | Simulate interrupt during merge | Git state clean after trap fires (no leftover MERGE_HEAD) |
| 9 | **Rebase check — needs rebase** | Unit | Branch behind master with overlapping files | Exit 0, output lists branch + reason |
| 10 | **Rebase check — clean** | Unit | Branch up-to-date or no overlap | Exit 0, "No branches need rebasing" |
| 11 | **PR label auto-tag — has deps** | Unit | Issue with pr_depends_on set | `gh pr edit --add-label forge/has-deps` called |
| 12 | **PR label auto-tag — no deps** | Unit | Issue with empty pr_depends_on | No label added (or removed if previously set) |
| 13 | **Abandoned worktree — stale** | Unit | Worktree with last commit >48h ago | Flagged as "potentially abandoned" |
| 14 | **Abandoned worktree — active** | Unit | Worktree with recent commit | Not flagged |
| 15 | **Input validation — bad branch name** | Security | Branch name with `;rm -rf /` | Exit 2, rejected by validate_branch_name |
| 16 | **Input validation — bad PR number** | Security | PR number `123; cat /etc/passwd` | Exit 2, rejected by validate_pr_number |

#### file-index.sh auto-update tests

| # | Scenario | Type | Input | Expected |
|---|----------|------|-------|----------|
| 17 | **Auto-update after commit** | Unit | Issue ID + list of changed files | New JSONL entry appended with updated files/modules |
| 18 | **Auto-update concurrent safety** | Edge | Two parallel auto-update calls | Both entries written correctly, no corruption |
| 19 | **Auto-update with flock timeout** | Error | Lock held >5s by another process | Exit 1, warning "file index locked" |

#### Workflow gate integration tests

| # | Scenario | Type | Input | Expected |
|---|----------|------|-------|----------|
| 20 | **Soft-block at /ship — conflicts found** | Integration | Two branches modifying same file | Warning displayed, confirmation prompt shown |
| 21 | **Soft-block at /ship — no conflicts** | Integration | Independent branches | No prompt, proceed silently |
| 22 | **Soft-block at /plan — stale index** | Edge | File index >15 min old | Staleness warning + conflict check still runs |

### Approach Confirmation

**Confirmed approach**: Extend existing scripts (Approach 1)
- New: `scripts/pr-coordinator.sh` + `tests/pr-coordinator.test.sh`
- Extend: `scripts/file-index.sh` (add `auto-update` + `flock` locking)
- Extend: `/plan` and `/ship` commands (add soft-block prompts)
- Fix: P0 issues in existing scripts (JSONL locking, pipefail, source checks)
- Extract: `scripts/lib/sanitize.sh` (deduplicate sanitize functions)
