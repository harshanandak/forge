# Multi-Dev Session Awareness — Task List

**Beads**: forge-w69s | **Branch**: feat/multi-dev-awareness | **Design**: [design doc](2026-03-22-multi-dev-awareness-design.md)

---

## Parallel Wave Structure

```
Wave 1 (foundational, parallel):  Tasks 1, 2, 3
Wave 2 (core logic, parallel):    Tasks 4, 5       (depends on Wave 1)
Wave 3 (integration, sequential): Tasks 6, 7       (depends on Wave 2)
Wave 4 (gates, sequential):       Task 8            (depends on Wave 3)
Wave 5 (docs):                    Task 9            (depends on Wave 4)
```

---

## Wave 1: Foundations (parallel — no interdependencies)

### Task 1: Sync branch auto-detection utility
File(s): `scripts/sync-utils.sh`
What to implement: Shell function `get_sync_branch()` that returns the correct sync branch using 3-method fallback: (1) `.beads/config.json` `sync_branch` field or `BD_SYNC_BRANCH` env var, (2) `git symbolic-ref refs/remotes/origin/HEAD`, (3) `git remote show origin | grep 'HEAD branch'`, (4) try `main`, then `master`. Also `get_sync_remote()` with config override and `upstream` detection for forks.
TDD steps:
  1. Write test: `tests/sync-utils.test.sh` — assert fallback chain returns correct branch for each scenario (config set, env set, symbolic-ref works, remote show works, neither works)
  2. Run test: confirm it fails (script doesn't exist)
  3. Implement: `scripts/sync-utils.sh` with `get_sync_branch` and `get_sync_remote` functions
  4. Run test: confirm it passes
  5. Commit: `test: add sync branch detection tests` then `feat: implement sync branch auto-detection`
Expected output: `get_sync_branch` returns correct branch name in all fallback scenarios

### Task 2: Session identity utility
File(s): `scripts/sync-utils.sh`
What to implement: Shell function `get_session_identity()` that returns `$(git config user.email)@$(hostname -s)` format. Validate against `^[a-zA-Z0-9._@+-]+$` regex (OWASP A03). Fallback to `git config user.name` if email not set. Cross-platform: use `hostname -s` (portable across Linux/macOS/Windows Git Bash).
TDD steps:
  1. Write test: `tests/sync-utils.test.sh` — assert identity format, assert injection strings rejected, assert fallback when email missing
  2. Run test: confirm it fails
  3. Implement: `get_session_identity` in `scripts/sync-utils.sh`
  4. Run test: confirm it passes
  5. Commit: `test: add session identity tests` then `feat: implement session identity utility`
Expected output: Valid identity string like `harsha@Harsha-OFC`

### Task 3: File index JSONL schema and read/write helpers
File(s): `scripts/file-index.sh`
What to implement: Shell functions to manage `.beads/file-index.jsonl`:
- `file_index_add <issue_id> <developer> <files_json> <modules_json>` — append entry with `updated_at` timestamp
- `file_index_remove <issue_id>` — append tombstone entry for issue
- `file_index_read` — read all entries, resolve LWW per issue_id, output active entries as JSON
- `file_index_get <issue_id>` — get single issue's file entry
Uses `jq` for JSON handling. Reuses `sanitize()` pattern from `dep-guard.sh`.
TDD steps:
  1. Write test: `tests/file-index.test.sh` — assert add creates valid JSONL, remove tombstones, read resolves LWW, injection inputs sanitized
  2. Run test: confirm it fails
  3. Implement: `scripts/file-index.sh`
  4. Run test: confirm it passes
  5. Commit: `test: add file index JSONL tests` then `feat: implement file index read/write helpers`
Expected output: JSONL entries with `{issue_id, developer, files, modules, updated_at, tombstone}` schema

---

## Wave 2: Core Logic (parallel — depends on Wave 1)

### Task 4: Conflict detection script
File(s): `scripts/conflict-detect.sh`
What to implement: Main conflict detection script:
- `conflict-detect.sh --issue <id>` — check for overlaps between given issue's files/modules and all other in-progress issues in file index
- `conflict-detect.sh --files <file1,file2>` — check arbitrary file list against index
- `--detail` flag: drill down from module-level to file-level, use grep for function-level hints
- Exit codes: 0 = no conflicts, 1 = conflicts found
- Stale sync warning: check last sync timestamp, warn if >15 min
- Output format: developer identity, issue ID, overlapping modules/files
- Reuses: `sanitize()` from dep-guard, `get_session_identity()` from sync-utils, `file_index_read()` from file-index
TDD steps:
  1. Write test: `tests/conflict-detect.test.sh` — assert: overlap found (exit 1), no overlap (exit 0), detail flag shows files, stale warning shown, injection inputs rejected
  2. Run test: confirm it fails
  3. Implement: `scripts/conflict-detect.sh`
  4. Run test: confirm it passes
  5. Commit: `test: add conflict detection tests` then `feat: implement conflict detection script`
Expected output: Module-level overlap warnings with developer identity and issue references

### Task 5: File index auto-update on issue state changes
File(s): `scripts/file-index.sh` (extend)
What to implement: Function `file_index_update_from_tasks <issue_id> <task_file_path>` that:
- Parses task file for `File(s):` lines, extracts file paths
- Derives modules from directory paths (e.g., `src/lib/status.ts` -> `src/lib/`)
- Calls `file_index_add` with extracted data
- Called when: issue goes in_progress (from task list), task completed (refine), issue closed (tombstone)
- Edge case: no task file — fall back to issue description keyword matching, flag `confidence: "low"`
TDD steps:
  1. Write test: `tests/file-index.test.sh` (extend) — assert: task file parsed correctly, modules derived, no-task-file fallback works, closed issue tombstoned
  2. Run test: confirm it fails
  3. Implement: `file_index_update_from_tasks` in `scripts/file-index.sh`
  4. Run test: confirm it passes
  5. Commit: `test: add file index task parsing tests` then `feat: implement file index auto-update from task files`
Expected output: File index populated from task list `File(s):` entries

---

## Wave 3: Integration (sequential — depends on Wave 2)

### Task 6: Extend smart-status.sh for cross-developer visibility
File(s): `scripts/smart-status.sh`
What to implement: Extend existing Tier 1/2 conflict detection (lines 311-482) to include cross-developer data:
- After local worktree conflict checks, read file index for OTHER developers' in-progress issues
- Group by developer identity, show module-level overlaps
- Add "Team Activity" section to status output: who is working on what, module overlap warnings
- Show staleness: "harsha@laptop claimed forge-abc 3 days ago, no commits since"
- Source sync-utils.sh for identity, file-index.sh for index reads
TDD steps:
  1. Write test: `tests/smart-status.test.sh` (extend or create) — assert: cross-dev section appears, overlap warning format correct, staleness shown for old claims
  2. Run test: confirm it fails
  3. Implement: extend smart-status.sh with cross-dev section
  4. Run test: confirm it passes
  5. Commit: `test: add cross-dev status tests` then `feat: extend smart-status for cross-developer visibility`
Expected output: `/status` shows "Team Activity" with developer-grouped issues and overlap warnings

### Task 7: Auto-sync at Forge command entry
File(s): `scripts/sync-utils.sh` (extend), `.claude/commands/plan.md`, `.claude/commands/dev.md`, `.claude/commands/status.md`
What to implement: Function `auto_sync()` in sync-utils.sh that:
- Runs `bd sync` targeting the correct sync branch (from `get_sync_branch`)
- On failure: warn "sync failed, working with local data (last sync: <timestamp>)", continue
- Records last sync timestamp to `.beads/.last-sync`
- Update Forge commands (plan, dev, status) to call `bash scripts/sync-utils.sh auto-sync` at entry
- After sync, auto-update file index from all in-progress issues' task files
TDD steps:
  1. Write test: `tests/sync-utils.test.sh` (extend) — assert: sync records timestamp, failure is non-blocking, stale detection works
  2. Run test: confirm it fails
  3. Implement: `auto_sync` in sync-utils.sh, update command files
  4. Run test: confirm it passes
  5. Commit: `test: add auto-sync tests` then `feat: implement auto-sync at Forge command entry`
Expected output: Every Forge command starts with fresh beads state, graceful offline handling

---

## Wave 4: Gate Integration (sequential — depends on Wave 3)

### Task 8: Soft block gates on /plan and /dev entry
File(s): `.claude/commands/plan.md`, `.claude/commands/dev.md`
What to implement: After the existing HARD-GATE (worktree isolation), add a soft-block gate:
- Run `bash scripts/conflict-detect.sh --issue <beads-id>`
- If exit code 1 (conflicts found): display conflicts, prompt "Conflicts detected with other developers. Proceed anyway? (y/n)"
- `n` → exit cleanly, no side effects
- `y` → log override decision via `bd comments add <id> "Conflict override: proceeding despite overlap with <other-issues>"`, continue
- If exit code 0: proceed silently
- Audit: record conflict overrides per OWASP A09
TDD steps:
  1. Write test: `tests/conflict-detect.test.sh` (extend) — assert: exit code 1 triggers prompt text, exit code 0 has no prompt, override logged
  2. Run test: confirm it fails
  3. Implement: add soft-block gate sections to plan.md and dev.md
  4. Run test: confirm it passes
  5. Commit: `test: add soft block gate tests` then `feat: add conflict soft-block gates to /plan and /dev`
Expected output: Developers warned before entering conflicting work areas

---

## Wave 5: Documentation (depends on Wave 4)

### Task 9: Sync commands after command file edits
File(s): (run script only)
What to implement: Run `node scripts/sync-commands.js` to propagate command changes to all 7 agent directories. Verify with `--check`.
TDD steps:
  1. Run: `node scripts/sync-commands.js --check` — confirm no drift
  2. If drift: run `node scripts/sync-commands.js` to fix
  3. Commit: `chore: sync command files across agent directories`
Expected output: All agent directories have updated plan.md and dev.md
