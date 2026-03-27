# Parallel PRs & Dependency-Aware Merging — Task List

- **Feature**: parallel-prs
- **Date**: 2026-03-26
- **Beads**: forge-puh
- **Design doc**: [2026-03-26-parallel-prs-design.md](2026-03-26-parallel-prs-design.md)

---

## Parallel Wave Structure

```
Wave 1 (foundational — no dependencies):
  Task 1: Extract shared sanitize library
  Task 2: Add flock-based JSONL locking to file-index.sh
  Task 3: Fix jq pipefail + source check issues

Wave 2 (depends on Wave 1):
  Task 4: pr-coordinator.sh — input validation + scaffold
  Task 5: file-index.sh auto-update subcommand

Wave 3 (depends on Wave 2):
  Task 6: PR dependency tracking (dep add/remove/list)
  Task 7: Merge simulation dry-run
  Task 8: Merge order computation (topological sort)

Wave 4 (depends on Wave 3):
  Task 9: Rebase guidance
  Task 10: Abandoned worktree detection
  Task 11: PR label auto-tagging

Wave 5 (depends on Waves 3-4):
  Task 12: Soft-block integration in /plan and /ship
  Task 13: Integration tests + edge case coverage
```

---

## Wave 1: Foundational Fixes (no dependencies)

### Task 1: Extract shared sanitize library

**File(s)**: `scripts/lib/sanitize.sh` (new), `scripts/file-index.sh`, `scripts/sync-utils.sh`, `scripts/conflict-detect.sh`, `scripts/dep-guard.sh`, `scripts/beads-context.sh`

**What to implement**: Extract the duplicated `sanitize()` function (currently copy-pasted in 4 scripts) into a shared `scripts/lib/sanitize.sh`. Each existing script sources it instead of defining its own copy. Add new validation functions: `validate_branch_name()`, `validate_pr_number()`, `validate_label_name()`. Existing function signatures and behavior must be identical — backward compatible.

**TDD steps**:
1. Write test: `tests/sanitize.test.sh` — test `sanitize()` with known inputs (special chars, injection attempts, empty string, valid input). Test new validators: branch names with `/`, `@`, valid chars pass; branch names with `;`, `|`, backticks fail. PR numbers: digits pass, `123;rm` fails. Labels: `forge/has-deps` passes, `label with spaces` fails.
2. Run test: confirm all fail (sanitize.sh doesn't exist yet)
3. Implement: Create `scripts/lib/sanitize.sh` with `sanitize()`, `validate_branch_name()`, `validate_pr_number()`, `validate_label_name()`. Update all 4 existing scripts to `source "$SCRIPT_DIR/lib/sanitize.sh"` instead of inline `sanitize()`.
4. Run test: confirm all pass
5. Run existing test suite: confirm no regressions (existing scripts still work)
6. Commit: `refactor: extract shared sanitize library from multi-dev scripts`

**Expected output**: All sanitize tests pass. Existing `conflict-detect.test.sh`, `file-index.test.sh`, `sync-utils.test.sh` still pass unchanged.

---

### Task 2: Add flock-based JSONL locking to file-index.sh

**File(s)**: `scripts/file-index.sh`, `scripts/lib/sanitize.sh` (for `atomic_jsonl_append()`)

**What to implement**: Add `atomic_jsonl_append()` function to `scripts/lib/sanitize.sh` (shared utility) that wraps JSONL appends with `flock -w 5` on `.beads/file-index.lock`. Update `file_index_add()`, `file_index_remove()`, and `file_index_update_from_tasks()` in `file-index.sh` to use `atomic_jsonl_append()` instead of raw `printf >> $file`. Cross-platform: use `flock` on Linux/WSL, fall back to `mkdir`-based lock on systems without `flock`.

**TDD steps**:
1. Write test: `tests/jsonl-locking.test.sh` — test that two parallel appends to the same JSONL file both succeed without corruption. Test lock timeout (held >5s → exit 1). Test lock cleanup on crash (lock file removed after process exits).
2. Run test: confirm fails (no locking exists)
3. Implement: `atomic_jsonl_append()` in `scripts/lib/sanitize.sh`. Update `file-index.sh` to call it.
4. Run test: confirm passes
5. Run `file-index.test.sh`: confirm no regressions
6. Commit: `fix: add flock-based JSONL locking to prevent concurrent corruption`

**Expected output**: Concurrent append test produces valid JSONL (every line parseable by jq). Lock timeout test exits 1 with warning.

---

### Task 3: Fix jq pipefail and source check issues

**File(s)**: `scripts/file-index.sh`, `scripts/conflict-detect.sh`, `scripts/sync-utils.sh`

**What to implement**:
- Add `set -o pipefail` inside functions that use jq pipelines in `file-index.sh` (lines 323, 328 area — `file_index_update_from_tasks`). Restore previous pipefail state after function returns.
- Add source failure checks: `source "$SCRIPT_DIR/file-index.sh" || { echo "FATAL: failed to source file-index.sh" >&2; exit 2; }` in `conflict-detect.sh` and `sync-utils.sh`.
- Add jq availability check in `sync-utils.sh` `_auto_sync_update_file_index()`: fail with clear error instead of silent skip.
- Add error check on `_auto_sync_update_file_index` return code in `auto_sync()`.

**TDD steps**:
1. Write test: `tests/error-handling.test.sh` — test that missing jq produces clear error (not silent skip). Test that broken jq pipeline (invalid JSON input) produces non-zero exit. Test that missing source file produces FATAL error and exit 2.
2. Run test: confirm fails
3. Implement: Add pipefail, source checks, jq checks as described
4. Run test: confirm passes
5. Run existing tests: confirm no regressions
6. Commit: `fix: add pipefail, source checks, and jq validation to multi-dev scripts`

**Expected output**: Error handling tests pass. Existing tests unaffected (they don't trigger error paths).

---

## Wave 2: Core Infrastructure (depends on Wave 1)

### Task 4: pr-coordinator.sh — input validation + scaffold

**File(s)**: `scripts/pr-coordinator.sh` (new), `tests/pr-coordinator.test.sh` (new)

**What to implement**: Create the script scaffold with:
- Sourcing: `source "$SCRIPT_DIR/lib/sanitize.sh"`, `source "$SCRIPT_DIR/file-index.sh"`, `source "$SCRIPT_DIR/sync-utils.sh"`
- Subcommand dispatcher (same pattern as file-index.sh): `dep`, `merge-sim`, `merge-order`, `rebase-check`, `auto-label`, `stale-worktrees`, `help`
- Input validation on all subcommands using `validate_branch_name()`, `validate_pr_number()`, `validate_label_name()` from sanitize.sh
- `help` subcommand with usage text
- Stub functions that print "not implemented" and exit 0 for each subcommand (filled in later tasks)

**TDD steps**:
1. Write test: `tests/pr-coordinator.test.sh` — test dispatcher routes to correct subcommand. Test unknown subcommand exits 1. Test `help` prints usage. Test input validation: bad branch name exits 2, bad PR number exits 2. Test that script sources dependencies without error.
2. Run test: confirm fails (script doesn't exist)
3. Implement: Create `scripts/pr-coordinator.sh` with scaffold
4. Run test: confirm passes
5. Commit: `feat: scaffold pr-coordinator.sh with input validation and dispatcher`

**Expected output**: Dispatcher tests pass. All subcommands reachable. Invalid inputs rejected with exit 2.

---

### Task 5: file-index.sh auto-update subcommand

**File(s)**: `scripts/file-index.sh`, `tests/file-index-auto-update.test.sh` (new)

**What to implement**: Add `auto-update` subcommand to file-index.sh dispatcher. It accepts `<issue-id>` and a list of changed files (from `git diff --name-only HEAD~1`), derives modules from file paths, and appends an updated entry to JSONL via `atomic_jsonl_append()`. Called by `/dev` after each task commit.

**Interface**: `file-index.sh auto-update <issue-id> [--from-git]`
- `--from-git`: derive file list from `git diff --name-only HEAD~1` (default if no explicit files given)
- Without flag: read file list from stdin (one per line)

**TDD steps**:
1. Write test: `tests/file-index-auto-update.test.sh` — test auto-update with explicit file list. Test auto-update with `--from-git` in a test git repo with a known commit. Test that JSONL entry is appended (not overwritten). Test that modules are correctly derived from paths (e.g., `scripts/foo.sh` → module `scripts`). Test with empty file list → no entry appended.
2. Run test: confirm fails
3. Implement: Add `auto-update` to dispatcher + `file_index_auto_update()` function
4. Run test: confirm passes
5. Run `file-index.test.sh`: confirm no regressions
6. Commit: `feat: add auto-update subcommand to file-index.sh`

**Expected output**: Auto-update test passes. Existing file-index tests unaffected. JSONL grows by one entry per call.

---

## Wave 3: Core Features (depends on Wave 2)

### Task 6: PR dependency tracking (dep add/remove/list)

**File(s)**: `scripts/pr-coordinator.sh`

**What to implement**: Replace stub for `dep` subcommand with full implementation:
- `dep add <issue-a> <issue-b>` — Records that issue-a depends on issue-b. Calls `bd dep add <issue-a> <issue-b>`. Then calls `bd dep cycles` — if cycle detected, rolls back with `bd dep remove` and exits 1 with "circular dependency detected" error.
- `dep remove <issue-a> <issue-b>` — Removes dependency. Calls `bd dep remove <issue-a> <issue-b>`.
- `dep list <issue-id>` — Shows dependencies for an issue. Calls `bd show <issue-id>` and parses DEPENDS ON section.
- `dep list-all` — Shows all open issues with their dependencies. Calls `bd list --status=open,in_progress` and `bd show` for each.
- Store PR number on issue: `bd set-state <issue-id> pr_number=<N> --reason "PR created by /ship"`

**TDD steps**:
1. Write test: test dep add succeeds for valid pair. Test dep add with circular dependency exits 1 and rolls back. Test dep remove succeeds. Test dep list parses bd show output correctly. Test dep list-all with multiple issues.
2. Run test: confirm fails (stubs return "not implemented")
3. Implement: dep subcommand with cycle detection and rollback
4. Run test: confirm passes
5. Commit: `feat: PR dependency tracking with cycle detection in pr-coordinator.sh`

**Expected output**: dep add/remove/list work correctly. Circular dependencies are rejected and rolled back cleanly.

---

### Task 7: Merge simulation dry-run

**File(s)**: `scripts/pr-coordinator.sh`

**What to implement**: Replace stub for `merge-sim` subcommand:
- `merge-sim <branch> [--base=master]` — Runs `git merge --no-commit --no-ff <branch>` against base branch in a temporary detached state.
- Uses trap: `trap 'git merge --abort 2>/dev/null; git checkout - 2>/dev/null' EXIT ERR INT` to ensure clean state on crash.
- On clean merge: exit 0, print "No conflicts detected with <base>"
- On conflict: exit 1, print list of conflicted files from `git diff --name-only --diff-filter=U`
- Validates branch name with `validate_branch_name()` before any git operations
- Never leaves MERGE_HEAD or dirty index behind

**TDD steps**:
1. Write test: Set up test git repo with two branches. Test merge-sim with no conflicts → exit 0. Test merge-sim with deliberate conflict (same line changed in both branches) → exit 1 + conflicted file listed. Test crash recovery: send SIGINT during merge simulation, verify no MERGE_HEAD remains. Test invalid branch name rejected with exit 2. Test non-existent branch exits 1 with clear error.
2. Run test: confirm fails
3. Implement: merge-sim subcommand with trap-guarded git merge
4. Run test: confirm passes
5. Commit: `feat: merge simulation dry-run with crash recovery in pr-coordinator.sh`

**Expected output**: Merge simulation correctly detects conflicts. Git state always clean after run (no MERGE_HEAD, no dirty index).

---

### Task 8: Merge order computation (topological sort)

**File(s)**: `scripts/pr-coordinator.sh`

**What to implement**: Replace stub for `merge-order` subcommand:
- `merge-order [--format=text|json]` — Reads all open/in_progress issues with PR state. Builds dependency graph from `bd dep` relationships. Runs topological sort (Kahn's algorithm in bash/jq).
- Output: ordered list of issues with their PR numbers, grouped by "can merge now" vs "blocked by".
- Independent PRs (no deps, no file overlap) listed as "can merge in any order".
- Always runs `bd dep cycles` first — if cycle found, exit 1 with error before computing order.

**TDD steps**:
1. Write test: Linear chain A→B→C → output C, B, A. Two independent PRs → "any order". Diamond dependency A→B, A→C, B→D, C→D → D first, then B and C (any order), then A. Cycle → exit 1. Single PR with no deps → "ready to merge". Empty (no open PRs) → "nothing to merge".
2. Run test: confirm fails
3. Implement: topological sort using jq for JSON graph processing
4. Run test: confirm passes
5. Commit: `feat: dependency-aware merge order computation in pr-coordinator.sh`

**Expected output**: Correct topological ordering for all graph shapes. Cycles detected and rejected.

---

## Wave 4: Extended Features (depends on Wave 3)

### Task 9: Rebase guidance

**File(s)**: `scripts/pr-coordinator.sh`

**What to implement**: Replace stub for `rebase-check` subcommand:
- `rebase-check [--after-merge=<branch>]` — Scans all open feature branches (from `git branch -r --no-merged` or from Beads PR state).
- For each branch: check if it's behind the base branch AND has file overlap with recently merged changes.
- Uses `git log --name-only <base>..<branch>` to get files touched by the branch.
- Uses `git log --name-only <branch>..<base>` to get files changed on base since branch diverged.
- Compares file lists for overlap.
- Output: list of branches that need rebasing, with the specific files that will conflict.
- Branches with no overlap but behind: listed as "clean rebase" (no conflicts expected).

**TDD steps**:
1. Write test: Branch behind master with overlapping files → listed with conflict files. Branch behind master with no overlap → listed as "clean rebase". Branch up-to-date → not listed. Test with `--after-merge` flag filtering to only check overlap with specific merged branch's changes.
2. Run test: confirm fails
3. Implement: rebase-check subcommand
4. Run test: confirm passes
5. Commit: `feat: rebase guidance with file-level overlap detection in pr-coordinator.sh`

**Expected output**: Correct identification of branches needing rebase. Overlap files listed accurately.

---

### Task 10: Abandoned worktree detection

**File(s)**: `scripts/pr-coordinator.sh`

**What to implement**: Replace stub for `stale-worktrees` subcommand:
- `stale-worktrees [--threshold=48h]` — Scans `.worktrees/` directory.
- For each worktree: check last commit date via `git -C <worktree> log -1 --format=%ci`.
- If last commit > threshold: flag as "potentially abandoned".
- Validate worktree paths with `realpath` + check path starts with repo root (OWASP A01 — no symlink traversal).
- Output: list of stale worktrees with last commit date and branch name.
- Exit 0 always (informational only).

**TDD steps**:
1. Write test: Create test worktree with old commit (mock date or use `GIT_COMMITTER_DATE`). Test threshold detection (>48h flagged, <48h not flagged). Test custom threshold. Test empty `.worktrees/` directory → "No worktrees found". Test symlink in `.worktrees/` pointing outside repo → skipped with warning.
2. Run test: confirm fails
3. Implement: stale-worktrees subcommand
4. Run test: confirm passes
5. Commit: `feat: abandoned worktree detection in pr-coordinator.sh`

**Expected output**: Stale worktrees correctly identified. Symlink traversal blocked.

---

### Task 11: PR label auto-tagging

**File(s)**: `scripts/pr-coordinator.sh`

**What to implement**: Replace stub for `auto-label` subcommand:
- `auto-label <issue-id>` — Reads issue state from Beads. Determines which labels to apply:
  - `forge/has-deps` — issue has pr_depends_on entries
  - `forge/blocks-others` — other issues depend on this one (check with `bd show` BLOCKS section)
  - `forge/needs-rebase` — branch is behind base (check with `git rev-list --count <base>..<branch>`)
- Applies labels via `gh pr edit <pr-number> --add-label <label>`.
- Removes labels that no longer apply via `gh pr edit <pr-number> --remove-label <label>`.
- Validates label names with `validate_label_name()`.
- Uses namespaced labels: all prefixed with `forge/` (OWASP A05).
- If no PR exists for the issue: exit 0 with "no PR found, skipping labels".

**TDD steps**:
1. Write test: Issue with dependencies → `forge/has-deps` added. Issue that blocks others → `forge/blocks-others` added. Branch behind → `forge/needs-rebase` added. Issue with no deps and up-to-date branch → no labels (or labels removed). No PR → exit 0 with skip message. Test label removal when condition no longer applies.
2. Run test: confirm fails
3. Implement: auto-label subcommand
4. Run test: confirm passes
5. Commit: `feat: PR label auto-tagging with forge/ namespace in pr-coordinator.sh`

**Expected output**: Labels correctly applied and removed based on current state. gh CLI called with correct arguments.

---

## Wave 5: Integration (depends on Waves 3-4)

### Task 12: Soft-block integration in /plan and /ship

**File(s)**: `.claude/commands/plan.md`, `.claude/commands/ship.md`, `.claude/skills/plan/SKILL.md`, `.claude/skills/ship/SKILL.md`

**What to implement**: Add soft-block prompts to workflow gates:

**In /plan** (after existing conflict-detect check, before Phase 1):
- Call `pr-coordinator.sh merge-sim` if on a feature branch with pending changes
- Call `pr-coordinator.sh merge-order` to show current merge queue
- If conflicts or dependency issues found: display findings, prompt "Proceed anyway? (y/n)"
- If user says no: exit cleanly
- If user says yes: log override via `bd comments add`

**In /ship** (after freshness check, before PR creation):
- Call `pr-coordinator.sh merge-sim <branch>` to check for merge conflicts
- Call `pr-coordinator.sh merge-order` to show recommended merge sequence
- Call `pr-coordinator.sh auto-label <issue-id>` to tag the PR
- If unmet dependencies found: display "These PRs should merge first: ..." with confirmation prompt
- Call `pr-coordinator.sh stale-worktrees` to flag abandoned worktrees (informational, no block)

**After sync-commands.js**: Run `node scripts/sync-commands.js` to propagate changes to all 7 agent directories.

**TDD steps**:
1. Write test: Verify /plan command file contains `pr-coordinator.sh merge-sim` call. Verify /ship command file contains `pr-coordinator.sh merge-order` call. Verify /ship calls `auto-label`. Verify soft-block uses confirmation prompt pattern (not hard exit). Verify `sync-commands.js --check` passes after changes.
2. Run test: confirm fails
3. Implement: Add soft-block sections to command files
4. Run test: confirm passes
5. Run `node scripts/sync-commands.js --check`: confirm no drift
6. Commit: `feat: soft-block integration for parallel PR coordination in /plan and /ship`

**Expected output**: Command files contain correct integration points. All agent directories in sync.

---

### Task 13: Integration tests + edge case coverage

**File(s)**: `tests/pr-coordinator-integration.test.sh` (new), `tests/pr-coordinator.test.sh` (extend)

**What to implement**: End-to-end integration tests covering the full workflow and all edge cases from the design doc:

**Integration scenarios**:
- Full workflow: create 2 issues → add dep → run merge-order → verify correct sequence
- Merge sim + rebase check: create conflicting branches → verify merge-sim detects conflict → merge one → verify rebase-check flags the other
- Auto-label lifecycle: create PR → add dep → auto-label → remove dep → auto-label → verify label removed

**Edge case scenarios** (from design doc):
- Edge A: Circular dep rejection + rollback
- Edge B: Merge sim conflict + proceed override (log check)
- Edge D: Close PR without merge → check issue status determines dependency satisfaction
- Edge E: Two PRs same files, no dep → soft-block prompt content verification
- Edge F: Stale simulation (verify always re-runs, no caching)
- Edge G: External merge detection (mock `gh pr view` response)
- Edge H: Multiple PRs per issue (update PR number)
- Edge I: Independent PRs → "any order" output

**TDD steps**:
1. Write test: All scenarios above with setup/teardown using temp git repos
2. Run test: confirm fails (some edge cases may already pass from unit tests)
3. Implement: Fix any failing edge cases
4. Run test: confirm all pass
5. Run full test suite: `bun test` — confirm no regressions
6. Commit: `test: integration tests and edge case coverage for pr-coordinator`

**Expected output**: All 8 edge cases covered. Full workflow integration passing. Zero regressions in existing tests.

---

## Summary

| Wave | Tasks | Estimated complexity |
|------|-------|---------------------|
| 1 | Tasks 1-3 (foundational fixes) | Low — refactoring existing code |
| 2 | Tasks 4-5 (infrastructure) | Low-Medium — new script scaffold + one new subcommand |
| 3 | Tasks 6-8 (core features) | Medium — dep tracking, merge sim, topo sort |
| 4 | Tasks 9-11 (extended features) | Medium — rebase guidance, stale detection, labeling |
| 5 | Tasks 12-13 (integration) | Medium — workflow gate integration + edge cases |

**Total**: 13 tasks across 5 waves. Waves within each group can run in parallel.
