# Workflow Intelligence — Task List

Epic: forge-68oj | Branch: feat/workflow-intelligence | Baseline: 1676 pass, 0 fail

---

## Wave 1: Foundation (no dependencies between tasks)

### Task 1: Smart status scoring engine (jq filter)
**Issue:** forge-vhxt
**File(s):** `scripts/smart-status.sh`
**What to implement:** Create the core bash script with a jq filter that:
- Reads all issues via `bd list --json --limit 0`
- Computes composite score: `priority_weight * unblock_chain * type_weight * status_boost * epic_proximity * staleness_boost`
- Priority weight: P0=5, P1=4, P2=3, P3=2, P4=1
- Unblock chain: `dependent_count + 1` (min 1)
- Type weight: bug=1.2, feature=1.0, task=0.8
- Status boost: in_progress=1.5, open=1.0
- Epic proximity: query `bd children <epic-id> --json` for each epic-type issue, compute `1.0 + (closed_siblings / total_siblings) * 0.5`
- Staleness: tiered from `updated_at` using jq's `now - fromdateiso8601`: 0-7d=1.0, 7-14d=1.1, 14-30d=1.2, 30+d=1.5
- Sort by score descending
- Include `sanitize()` function from beads-context.sh (OWASP A03)
- Check `command -v jq` at entry, print install instructions if missing
- `set -euo pipefail`, cross-platform compatible (no bash 4+ features)
**TDD steps:**
1. Write test: `test/scripts/smart-status.test.js` — mock `bd list --json` output with 5 issues of varying priority/type/status, verify score computation order
2. Run test: confirm it fails (script doesn't exist yet)
3. Implement: `scripts/smart-status.sh` with scoring logic
4. Run test: confirm it passes
5. Commit: `test: add smart-status scoring tests` then `feat: implement smart-status scoring engine`
**Expected output:** Given mock input, issues are sorted by computed composite score descending

---

### Task 2: Rename forge-validate to forge-preflight
**Issue:** forge-0xic
**File(s):** `bin/forge-validate.js`, `package.json`, `README.md`, `CHANGELOG.md`, `DEVELOPMENT.md`
**What to implement:**
- Rename `bin/forge-validate.js` to `bin/forge-preflight.js`
- Update `package.json` bin entry: `"forge-validate"` -> `"forge-preflight"`
- Update text references in README.md (lines 175-177), CHANGELOG.md (lines 120-123), DEVELOPMENT.md (line 43)
- Update AGENTS.md if it references the binary name
- Do NOT rename: `lib/commands/validate.js`, `test/commands/validate.test.js`, `.claude/commands/validate.md`, `scripts/validate.sh`, `packages/skills/src/commands/validate.js`
**TDD steps:**
1. Write test: `test/commands/preflight.test.js` — test that `bin/forge-preflight.js` exists and is executable, that package.json bin entry points to it
2. Run test: confirm it fails (file doesn't exist yet)
3. Implement: git mv + text updates
4. Run test: confirm it passes
5. Commit: `test: add preflight binary existence test` then `refactor: rename forge-validate to forge-preflight`
**Expected output:** `forge-preflight status` works, `forge-validate` no longer exists in bin/

---

## Wave 2: Depends on Wave 1

### Task 3: Smart status grouping and formatted output
**Issue:** forge-vhxt
**File(s):** `scripts/smart-status.sh`
**What to implement:** Extend the scoring engine with grouped output:
- Group issues into categories: Resume (in_progress) > Unblock Chains (dependent_count >= 2, not in_progress) > Ready Work (open, no blockers) > Blocked > Backlog (P4)
- Format each entry: `N. [score] issue-id (priority type) -- title [status Nd]`
- Show unblock chains inline: `-> Unblocks: issue-a, issue-b`
- Show staleness flag on stale items: `[stale 14d]`
- Respect `NO_COLOR` env var (no ANSI escapes when set)
- Use 8-bit ANSI colors otherwise (green=resume, yellow=ready, red=blocked, dim=backlog)
- Support `--json` flag for machine-readable output
**TDD steps:**
1. Write test: verify grouping logic — in_progress goes to Resume, P4 goes to Backlog, blocked goes to Blocked, high dependent_count goes to Unblock Chains
2. Run test: confirm it fails
3. Implement: grouping and formatting in jq + bash
4. Run test: confirm it passes
5. Commit: `test: add smart-status grouping tests` then `feat: add grouped formatted output to smart-status`
**Expected output:** Grouped, colored terminal output with scores and categories

---

### Task 4: Add disambiguation note to /validate command
**Issue:** forge-0xic
**File(s):** `.claude/commands/validate.md`
**What to implement:**
- Add a disambiguation note after the description in `.claude/commands/validate.md` explaining the three concepts:
  - `/validate` (this command): Workflow Stage 3
  - `forge-preflight` (formerly forge-validate): prerequisite checker CLI
  - `bun run check` (scripts/validate.sh): local quality gate
- Run `node scripts/sync-commands.js` to propagate to all 6 agent directories
**TDD steps:**
1. Write test: `test/commands/validate-disambiguation.test.js` — verify `.claude/commands/validate.md` contains "forge-preflight" and "bun run check" references
2. Run test: confirm it fails
3. Implement: add note to validate.md, run sync-commands.js
4. Run test: confirm it passes
5. Commit: `test: add disambiguation note test` then `docs: add validate naming disambiguation to /validate command`
**Expected output:** All 7 agent command files contain the disambiguation note

---

## Wave 3: Depends on Wave 1

### Task 5: Session detection (active worktrees + branch matching)
**Issue:** forge-w69s
**File(s):** `scripts/smart-status.sh`
**What to implement:**
- Parse `git worktree list --porcelain` to extract worktree paths and branch names
- Strip `refs/heads/` prefix from branch values
- Match branch names to in-progress beads issues via naming convention:
  - `feat/<slug>` -> look for issues with matching slug in title/id
  - Use `bd list --status in_progress --json` for the issue list
- Output "Active Sessions" section at top of smart-status:
  ```
  === ACTIVE SESSIONS ===
    feat/p2-bug-fixes -> forge-iv1p, forge-cpnj (2 issues)
    feat/workflow-intelligence -> forge-68oj (this session)
  ```
- Handle edge cases: no worktrees (skip section), orphan branches (show warning)
**TDD steps:**
1. Write test: mock `git worktree list --porcelain` output and `bd list --json` output, verify session matching and formatted output
2. Run test: confirm it fails
3. Implement: worktree parsing + branch matching in smart-status.sh
4. Run test: confirm it passes
5. Commit: `test: add session detection tests` then `feat: add active session detection to smart-status`
**Expected output:** Active Sessions section shows worktree-to-issue mapping

---

### Task 6: File-level conflict detection (Tier 1)
**Issue:** forge-w69s
**File(s):** `scripts/smart-status.sh`
**What to implement:**
- For each active worktree branch, run `git diff master...<branch> --name-only --` to get changed files
- Build a map: `file -> [branches that touch it]`
- For ready-work issues, check if their likely files overlap with in-progress branch files
- Annotate overlapping items: `! Conflict risk: touches <file> (<branch> in-progress)`
- Use `--` separator after branch name to prevent argument injection (OWASP A03)
- Handle: no active branches (skip), single branch (no conflicts possible)
**TDD steps:**
1. Write test: mock git diff output for 2 branches with overlapping files, verify conflict annotation appears
2. Run test: confirm it fails
3. Implement: conflict detection in smart-status.sh
4. Run test: confirm it passes
5. Commit: `test: add conflict detection tests` then `feat: add file-level conflict detection to smart-status`
**Expected output:** Ready-work items touching same files as in-progress branches get conflict warning

---

## Wave 4: Depends on Waves 1-3

### Task 7: Update /status command to use smart-status.sh
**Issue:** forge-vhxt
**File(s):** `.claude/commands/status.md`
**What to implement:**
- Replace the current manual `bd stats` + `bd list` + `git log` steps with a call to `scripts/smart-status.sh`
- Keep `git log --oneline -10` for recent commits (smart-status doesn't cover this)
- Keep the "Determine Context" and "Next Steps" sections
- Run `node scripts/sync-commands.js` to propagate to all agent directories
**TDD steps:**
1. Write test: verify `.claude/commands/status.md` references `scripts/smart-status.sh`
2. Run test: confirm it fails
3. Implement: update status.md
4. Run test: confirm it passes
5. Commit: `test: verify status command references smart-status` then `feat: update /status to use smart-status.sh`
**Expected output:** `/status` command calls smart-status.sh for ranked issue output

---

### Task 8: Update /plan to create epic at Phase 1 entry
**Issue:** forge-mwxb
**File(s):** `.claude/commands/plan.md`
**What to implement:**
- Move `bd create` from Phase 3 Step 1 to Phase 1 entry (after worktree creation, before Q&A):
  ```
  bd create --title="<feature-name>" --type=epic
  bd update <id> --status=in_progress
  bash scripts/beads-context.sh stage-transition <id> none plan
  ```
- Add stage transitions at phase boundaries:
  - Phase 2 entry: `stage-transition plan research`
  - Phase 3 entry: `stage-transition research setup`
- Keep child issue creation in Phase 3 (unchanged)
- Run `node scripts/sync-commands.js` to propagate
**TDD steps:**
1. Write test: verify `.claude/commands/plan.md` contains `bd create` before Phase 1 Q&A, and `stage-transition` calls at Phase 2 and Phase 3 entry
2. Run test: confirm it fails
3. Implement: update plan.md
4. Run test: confirm it passes
5. Commit: `test: verify plan command phase tracking` then `feat: add early epic creation and phase tracking to /plan`
**Expected output:** `/plan` creates epic at Phase 1 entry with stage transitions at each boundary

---

## Wave 5: Optional enhancement (depends on Wave 3)

### Task 9: Tier 2 conflict detection (git merge-tree)
**Issue:** forge-w69s
**File(s):** `scripts/smart-status.sh`
**What to implement:**
- After Tier 1 file-overlap detection, for pairs with overlaps:
  - Check git version >= 2.38 (`git --version` parse)
  - If available, batch-check with `git merge-tree --write-tree --name-only --no-messages --stdin`
  - Each input line: `<branch1> <branch2>`
  - Exit code 1 = actual merge conflict
- Upgrade annotation: `!! Merge conflict: <file> (branch-a vs branch-b)` for real conflicts
- Keep `! Conflict risk` for file-overlap-only (no actual conflict)
- Graceful fallback: if git < 2.38, skip Tier 2 silently (Tier 1 still works)
**TDD steps:**
1. Write test: mock git merge-tree output with conflict (exit 1) and clean (exit 0), verify annotation upgrade
2. Run test: confirm it fails
3. Implement: Tier 2 in smart-status.sh
4. Run test: confirm it passes
5. Commit: `test: add tier-2 merge-tree conflict tests` then `feat: add git merge-tree tier-2 conflict detection`
**Expected output:** Real merge conflicts get `!!` annotation, file-only overlaps get `!`

---

## Dependency Graph

```
Wave 1: [Task 1] [Task 2]        (parallel, no deps)
Wave 2: [Task 3] [Task 4]        (Task 3 depends on 1; Task 4 depends on 2)
Wave 3: [Task 5] [Task 6]        (both depend on Task 1)
Wave 4: [Task 7] [Task 8]        (Task 7 depends on 1,3,5,6; Task 8 independent but logically last)
Wave 5: [Task 9]                  (depends on Task 6, optional enhancement)
```

## Summary

| Wave | Tasks | Parallel? | Est. Complexity |
|------|-------|-----------|-----------------|
| 1 | Task 1 (scoring), Task 2 (rename) | Yes | Medium |
| 2 | Task 3 (grouping), Task 4 (disambiguation) | Yes | Medium, Low |
| 3 | Task 5 (sessions), Task 6 (conflicts) | Yes | Medium |
| 4 | Task 7 (/status update), Task 8 (/plan update) | Yes | Low |
| 5 | Task 9 (merge-tree tier 2) | No | Medium |

Total: 9 tasks across 5 waves
