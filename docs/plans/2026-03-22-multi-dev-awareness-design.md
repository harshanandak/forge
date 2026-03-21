# Multi-Dev Session Awareness - Design Doc

- **Feature**: multi-dev-awareness
- **Date**: 2026-03-22
- **Status**: Phase 2 complete
- **Beads**: forge-w69s (Layer 1 of forge-qml5 epic)

---

## Purpose

Enable 5 developers (each running 2-3 parallel AI/human sessions) to see what others are working on and avoid stepping on each other. Currently, beads + worktrees handle intra-developer coordination (within one laptop), but there is zero cross-developer visibility. This causes:

- Silent file/module conflicts discovered only at PR merge time
- Duplicate work when two devs unknowingly tackle the same area
- Wasted effort when someone builds on another dev's unfinished work

## Success Criteria

1. `bd sync` at entry of every Forge command pulls latest beads state from the shared sync branch
2. `/status` shows all in-progress issues across ALL developers, grouped by developer identity (`user@hostname`), with module-level overlap warnings
3. Soft block on `/plan` and `/dev` entry when another developer has in-progress work in the same module — requires explicit confirmation to proceed
4. `bd conflicts` (new script) shows module-level overlap with drill-down to function-level on `--detail`
5. Session identity stored on beads issues: `developer@hostname` format distinguishes a developer's multiple sessions
6. Sync branch auto-detected from remote default, with config override for git flow (`develop`) and custom setups

## Out of Scope

- Real-time WebSocket/push-based conflict alerts (deferred to Approach C / future Layer 3 - forge-wzpb)
- Full AST-based function-level parsing in the hot path (function-level available on-demand via grep, not AST)
- Auto-unclaiming abandoned issues (too destructive — show staleness warnings instead)
- PR-level conflict detection (covered by GitHub's own merge conflict detection)
- Cross-repository/fork coordination beyond remote auto-detection

## Approach Selected: B — Beads + File Index

### Why not A (Beads-Native only)?
Without a file index, every conflict check must re-parse all task lists from all developers. With 10-15 concurrent issues across 5 devs, this becomes slow and brittle.

### Why not C (External Coordination Service)?
Over-engineered for 5 developers. Breaks the git-native, offline-capable philosophy. Adds infrastructure dependency. Deferred as future enhancement.

### Approach B Details

1. **Auto-sync at command entry**: Every Forge command (`/status`, `/plan`, `/dev`, `/validate`, `/ship`, `/review`) runs `bd sync` at entry to pull latest beads state from the sync branch.

2. **File index** (`.beads/file-index.jsonl`): Maps `{issue_id, developer, files[], modules[], updated_at}`. Updated when:
   - An issue transitions to `in_progress` (from task list file paths)
   - Tasks are completed (progress updates refine the touched files)
   - An issue is closed (entry removed from index)

3. **Conflict detection script** (`scripts/conflict-detect.sh`):
   - Reads file index, groups by module (directory-level)
   - Cross-references with current developer's planned/in-progress work
   - Module-level output by default, function-level via `--detail` flag (uses grep, not AST)
   - Exit codes: 0 = no conflicts, 1 = conflicts found (for gate integration)

4. **Sync branch auto-detection**:
   - Primary: `git remote show origin | grep 'HEAD branch'`
   - Override: `.beads/config.json` field `sync_branch` or env var `BD_SYNC_BRANCH`
   - Fallback order: config > env > auto-detect > "main" > "master"

5. **Session identity**:
   - Format: `git config user.name` + `@` + `hostname`
   - Stored via `--assignee` on `bd update --claim`
   - Distinguishes parallel sessions from the same developer

6. **Soft block integration**:
   - `/plan` entry gate: run conflict-detect, show overlaps, require `y/n` to proceed
   - `/dev` entry gate: same check
   - Not a hard block — developers can always proceed with confirmation

## Constraints

- Must work offline (git-native, no external services)
- Must support git flow (`develop` branch), trunk-based (`main`/`master`), and custom branch strategies
- Must not break existing single-developer workflow
- Must handle stale sync gracefully (warn, don't block)
- `.beads/file-index.jsonl` must be mergeable (append-only JSONL, same pattern as `issues.jsonl`)
- Zero new dependencies — bash scripts + existing beads CLI only

## Edge Cases

1. **Stale sync**: Show "last synced X min ago" warning if >15 min since last `bd sync`. Advisory only — don't block.

2. **JSONL merge conflicts**: `bd resolve-conflicts` already handles `.beads/` JSONL merges. File index follows the same pattern (append-only, last-write-wins per issue_id).

3. **Orphaned claims**: Developer claims an issue, then disappears (crash, vacation). Show staleness in `/status` ("claimed 3 days ago, no commits since"). Never auto-unclaim — that's destructive. Human must explicitly `bd update <id> --assignee ""` to release.

4. **Git flow / develop branch**: Sync target configurable via `.beads/config.json` `sync_branch` field or `BD_SYNC_BRANCH` env var. Auto-detect from `git remote show origin` as default.

5. **Fork-based workflows**: Detect `upstream` remote. If present, sync from `upstream` instead of `origin`. Configurable via `sync_remote` in `.beads/config.json`.

6. **No task list**: Issue created outside Forge workflow (no task file with `File(s):` entries). Fall back to issue title + description for keyword-based module detection. Flag as "low confidence" in conflict output.

7. **Same module, no real conflict**: Two devs touch `src/lib/` but different files. Module-level warning shown, `--detail` reveals no file overlap. Developer confirms to proceed.

8. **Network offline**: `bd sync` fails gracefully — warn "sync failed, working with local data (last sync: timestamp)", proceed with stale data. Never block work due to network.

9. **Branch protection conflicts**: If sync branch has strict protection that blocks `.beads/` pushes, `bd sync` should detect and warn with instructions to configure branch protection rules.

10. **Concurrent bd sync**: Two developers run `bd sync` simultaneously. JSONL append-only format + git's own merge handling should resolve this. If git merge fails, `bd resolve-conflicts` kicks in.

## Ambiguity Policy

7-dimension rubric scoring. Confidence >= 80%: proceed and document in decisions log. Confidence < 80%: stop and ask user. (Per project-wide policy.)

## Technical Research

### Key Findings

**Conflict Detection Techniques**:
- `git diff --name-only <base>...<branch>` — cheap file-level overlap detection across branches
- `git merge-tree` (git >= 2.38) — predicts merge conflicts without side effects. Already used in `smart-status.sh` Tier 2 (lines 391-482)
- Extend existing `smart-status.sh` Tier 1/2 logic for cross-developer detection (currently local-only)

**JSONL Merge Strategy**:
- Append-only JSONL with unique IDs and `updated_at` timestamps is naturally merge-friendly
- Last-write-wins (LWW) per-record by `updated_at` handles same-issue conflicts
- No CRDT complexity needed — git's line-based merge + `bd resolve-conflicts` handles edge cases
- `.beads/file-index.jsonl` follows same pattern as `issues.jsonl`

**Default Branch Detection** (3-method fallback):
1. `git symbolic-ref refs/remotes/origin/HEAD` — fast, cached locally
2. `git remote show origin | grep 'HEAD branch'` — live/accurate, requires network
3. Common name check: try `main`, then `master`
- Config override via `.beads/config.json` `sync_branch` or `BD_SYNC_BRANCH` env var takes precedence

**Session Identity** (cross-platform):
- `hostname -s` — portable across Linux/macOS/Windows Git Bash. Confirmed working.
- `$HOSTNAME` is bash-specific; `$COMPUTERNAME` is Windows-only
- Format: `$(git config user.email)@$(hostname -s)` — prefer email over name for uniqueness
- Validate against `^[a-zA-Z0-9._@+-]+$` (OWASP A03 — injection prevention)

**Existing Code to Extend** (DRY check results):
| What | Where | Action |
|------|-------|--------|
| File-overlap detection (Tier 1) | `smart-status.sh:311-389` | EXTEND for cross-dev |
| Merge-tree conflicts (Tier 2) | `smart-status.sh:391-482` | EXTEND for cross-dev |
| Ripple/keyword detection | `dep-guard.sh:check-ripple` | KEEP as-is (different concern) |
| Input sanitization pattern | `dep-guard.sh:69-83` | REUSE `sanitize()` in new scripts |
| Worktree parsing | `smart-status.sh:205-248` | REUSE for session detection |
| HARD-GATE pattern | `.claude/commands/plan.md:1-30` | EXTEND with soft-block gate |

**New artifacts to create**:
| What | Path |
|------|------|
| File index | `.beads/file-index.jsonl` |
| Conflict detection script | `scripts/conflict-detect.sh` |
| Beads config | `.beads/config.json` |

### OWASP Top 10 Analysis

Full analysis: [2026-03-22-multi-dev-awareness-owasp-analysis.md](2026-03-22-multi-dev-awareness-owasp-analysis.md)

**High-priority mitigations** (must implement):

| Category | Risk | Mitigation |
|----------|------|------------|
| A03: Injection | Shell injection via developer names, hostnames, file paths in bash scripts | Reuse `sanitize()` from `dep-guard.sh`. Validate session identity format `^[a-zA-Z0-9._@+-]+$`. Quote all variables. Use `printf '%s'` not `echo`. |
| A04: Insecure Design | Race condition in concurrent `bd sync` (JSONL-in-git has no locking). TOCTOU gap between conflict detection and gate entry. | Freshness window (re-validate at gate entry if >15 min stale). Optimistic concurrency via `updated_at`. JSONL append-only format minimizes conflict surface. |
| A07: Identification | `gituser@hostname` is trivially spoofable | Prefer `git config user.email`. Recommend (don't require) commit signing. Advisory — git itself has no auth. |
| A09: Logging | No audit trail for sync operations and conflict overrides | Log sync events via `bd comments add`. Record conflict override decisions with rationale. |

**Low-priority** (acceptable risk for v1):

| Category | Risk | Decision |
|----------|------|----------|
| A01: Access Control | Any git pusher can modify another dev's issues | Acceptable — git push access = trust. Diff-based validation deferred to Approach C. |
| A02: Crypto | JSONL files lack integrity checksums | Acceptable — git provides SHA-based integrity. |
| A08: Data Integrity | Truncated sync could corrupt data | `bd sync` should validate JSONL structure post-pull. |

### TDD Test Scenarios

**1. Happy path — conflict detection finds overlap**
- Setup: Two issues in file-index.jsonl, both touching `src/lib/status.ts`
- Input: `conflict-detect.sh --issue forge-abc`
- Expected: Exit code 1, output shows overlap with other issue, module `src/lib/`
- Assertion: Output contains developer identity and conflicting issue ID

**2. Happy path — no conflicts**
- Setup: Two issues in file-index.jsonl, touching different modules
- Input: `conflict-detect.sh --issue forge-abc`
- Expected: Exit code 0, no warnings
- Assertion: Clean output, no overlap messages

**3. Sync branch auto-detection fallback chain**
- Setup: No config, no env var, `git symbolic-ref` fails (no remote HEAD cached)
- Input: `get-sync-branch` function called
- Expected: Falls back to `git remote show origin`, then `main`, then `master`
- Assertion: Correct branch returned at each fallback level

**4. Session identity format validation**
- Input: Various identity strings including injection attempts (`; rm -rf /`, `$(whoami)`, `user@host`)
- Expected: Valid identities pass, injection attempts rejected
- Assertion: Only `^[a-zA-Z0-9._@+-]+$` matches accepted

**5. Stale sync warning**
- Setup: Last sync timestamp >15 min ago
- Input: `conflict-detect.sh --issue forge-abc`
- Expected: Warning message with "last synced X min ago", conflict check still runs
- Assertion: Warning present, exit code still reflects conflict state (not staleness)

**6. File index update on issue state change**
- Setup: Issue transitions to `in_progress` with task list specifying files
- Input: `update-file-index forge-abc docs/plans/task-list.md`
- Expected: `.beads/file-index.jsonl` gains entry with issue ID, developer, files, modules
- Assertion: JSONL entry parseable, contains correct file paths and module groupings

**7. Offline/network failure graceful degradation**
- Setup: `bd sync` fails (no network)
- Input: Forge command entry triggers sync
- Expected: Warning "sync failed, working with local data", command proceeds
- Assertion: No crash, stale data used, warning displayed

**8. Concurrent sync merge resolution**
- Setup: Two developers modify `.beads/file-index.jsonl` simultaneously, push
- Input: `bd sync` on second developer
- Expected: Git merge succeeds (append-only JSONL), or `bd resolve-conflicts` triggered
- Assertion: No data loss, both entries present in merged file

**9. Edge case — issue with no task list**
- Setup: Issue in beads with no design doc or task file
- Input: `update-file-index forge-xyz` (no task file path)
- Expected: Falls back to title/description keyword matching, flags "low confidence"
- Assertion: File index entry created with `confidence: "low"`, module derived from keywords

**10. Soft block confirmation flow**
- Setup: Conflict detected at `/plan` entry
- Input: User enters `/plan` with overlapping module
- Expected: Shows conflicts, prompts y/n, proceeds only on `y`
- Assertion: `n` exits cleanly with no side effects, `y` proceeds to Phase 1

## Future Enhancements (Approach C — deferred)

- Real-time WebSocket coordination server for push-based conflict alerts
- Full AST-based function-level conflict detection
- Live session heartbeats (detect abandoned sessions automatically)
- Team dashboard UI (web-based or TUI)
- Cross-repository dependency tracking for monorepo/polyrepo setups
