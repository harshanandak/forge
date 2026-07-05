# Workflow Intelligence Epic — Design Doc

- **Feature**: workflow-intelligence
- **Date**: 2026-03-21
- **Status**: Approved
- **Epic**: forge-68oj
- **Child issues**: forge-vhxt, forge-mwxb, forge-0xic, forge-w69s

---

## Purpose

The Forge workflow currently has gaps in how it communicates project state to users and AI agents:

1. `/status` only shows partial issue lists (bd ready + bd blocked), missing issues that fall into neither category. No ranking by project impact.
2. Beads issues don't get tracked until Phase 3 of `/plan`, so new sessions can't see that planning is in progress.
3. Three different concepts share the name "validate", causing confusion.
4. No visibility into what parallel sessions are working on or whether ready-work items conflict with in-progress work.

This epic addresses all four gaps in a single PR.

---

## Success Criteria

1. `scripts/smart-status.sh` outputs ALL open + in-progress + blocked issues ranked by composite score
2. Output is grouped into actionable categories: Resume > Unblock Chains > Ready Work > Blocked > Backlog
3. Conflict risk annotations appear on items that touch the same files as in-progress work
4. Active sessions are listed with their branches and linked issues
5. `/plan` creates the epic issue at Phase 1 entry and transitions stage at each phase boundary
6. `forge-validate` is renamed to `forge-preflight` across all references
7. `/validate` command header includes a disambiguation note explaining the three concepts
8. All existing tests pass + new tests cover ranking logic and conflict detection

---

## Out of Scope

- Dependency-aware merging (deferred to forge-puh)
- PR coordination / auto-labeling conflicting PRs (deferred to forge-puh)
- Beads locking / preventing two sessions from claiming the same issue (deferred to forge-puh)
- Changes to `/dev`, `/ship`, `/review`, `/premerge`, `/verify` commands
- UI/dashboard (forge-dwm)

---

## Approach Selected

### 1. Smart Status Script (`scripts/smart-status.sh`)

**Composite ranking formula:**

```
score = priority_weight x unblock_chain x type_weight x status_boost x epic_proximity x staleness_boost
```

**Factor definitions:**

| Factor | Values |
|--------|--------|
| priority_weight | P0=5, P1=4, P2=3, P3=2, P4=1 |
| unblock_chain | Count of downstream issues unblocked (min 1) |
| type_weight | bug=1.2, feature=1.0, task=0.8 |
| status_boost | in_progress=1.5, open=1.0 |
| epic_proximity | 1.0 + (siblings_closed / siblings_total) x 0.5 — range 1.0-1.5 |
| staleness_boost | 0-7d=1.0, 7-14d=1.1, 14-30d=1.2, 30+d=1.5 |

**Output grouping:**

```
=== ACTIVE SESSIONS ===
  feat/p2-bug-fixes -> forge-iv1p, forge-cpnj, forge-8u6q, forge-zs2u
  feat/workflow-intelligence -> forge-68oj (this session)

=== RESUME (in-progress) ===
1. [10.8] forge-cpnj (P2 bug) -- Setup code paths [in_progress 3d]
   -> Unblocks: forge-xnyl -> forge-vmjc, forge-2b82

=== UNBLOCK CHAINS (highest downstream impact) ===
2. [8.1] forge-0ht2 (P3 feature) -- Extract bin/forge.js
   -> Unblocks: forge-mymu, forge-h5yj

=== READY WORK (no blockers) ===
3. [5.4] forge-mwxb (P2 bug) -- Beads phase tracking
4. [3.6] forge-npza (P2 feature) -- Lifecycle commands
   ! Conflict risk: touches setup code (forge-cpnj in-progress)

=== BLOCKED (waiting on dependencies) ===
5. [--] forge-xnyl -- Blocked by: forge-cpnj

=== BACKLOG (P4, no urgency) ===
6. [1.2] forge-17rw (P4 feature) -- CJS to ESM migration [stale 14d]
```

**Data sources:**
- `bd list --json --limit 0` — single call gets all issues with `dependency_count`, `dependent_count`, timestamps, status, priority, type
- `bd children <epic-id> --json` — for epic proximity calculation
- `git worktree list --porcelain` — active worktrees with branch refs
- `git diff master...<branch> --name-only` — file-level conflict detection
- `git merge-tree --write-tree --name-only --no-messages` — actual conflict detection (git 2.38+, optional tier 2)
- Beads task list `File(s):` entries as fallback for issues without branches

**Implementation architecture (from research):**
- Single `jq -s` (slurp) invocation: read all issues, compute scores, sort, group, format — all in one pass
- Use jq's `now` and `fromdateiso8601` for staleness calculation (cross-platform, no shell `date`)
- `dependent_count` field as proxy for unblock chain length (avoids recursive graph walk)
- Require jq (check with `command -v jq`, print install instructions if missing)
- Respect `NO_COLOR` env var for plain output; use 8-bit ANSI colors otherwise
- Support `--json` flag for machine-readable output

**Reference: Taskwarrior urgency formula:**
Our formula is inspired by Taskwarrior's 14-factor urgency coefficient (priority 6.0, blocking 8.0, blocked -5.0, age 2.0). Key differences: we use multiplicative factors (not additive), include epic proximity, and use tiered staleness instead of linear age ramp.

### 2. Phase Tracking at Entry (`/plan` command update)

Move issue creation to Phase 1 entry:

- Phase 1 entry: `bd create` epic + `bd update --status=in_progress` + `stage-transition none plan`
- Phase 2 entry: `stage-transition plan research`
- Phase 3 entry: `stage-transition research setup`
- Child issues created in Phase 3 as tasks under the epic

This ensures any session running `bd list --status=in_progress` + `bd show` immediately sees what stage planning is at.

### 3. Validate Naming Disambiguation

**Rename:** `forge-validate` -> `forge-preflight`

This CLI tool checks prerequisites before workflow stages (tools installed, files exist). "Preflight" clearly conveys its purpose vs the other two validate concepts.

**Disambiguation note** added to `/validate` command header:

```
Note: Three things share the "validate" name in Forge:
- /validate (this command): Workflow Stage 3 — runs type/lint/test/security checks
- forge-preflight (formerly forge-validate): CLI tool — checks prerequisites before a stage
- bun run check (scripts/validate.sh): Local quality gate — same checks as /validate, non-interactive
```

**Corrected rename scope (from blast-radius research):**

Files to RENAME:
- `bin/forge-validate.js` -> `bin/forge-preflight.js` (CLI entry point)
- `package.json` bin entry: `"forge-validate"` -> `"forge-preflight"`

Text references to UPDATE (not file renames):
- `README.md` lines 175-177 (usage examples)
- `CHANGELOG.md` lines 120-123 (feature announcement)
- `DEVELOPMENT.md` line 43 (file structure doc)
- `AGENTS.md` (any references to the binary name)

Files to NOT rename (different concepts):
- `lib/commands/validate.js` — shared quality-gate library, used by both CLI and /validate command
- `test/commands/validate.test.js` — tests `lib/commands/validate.js`, not the CLI binary
- `.claude/commands/validate.md` — workflow Stage 3 command, stays as `/validate`
- All agent command copies (`.cursor/`, `.roo/`, etc.) — these define `/validate` workflow, not the CLI
- `scripts/validate.sh` — quality gate script, already called via `bun run check`
- `packages/skills/src/commands/validate.js` — skill validator, different system entirely

### 4. Session Awareness & Conflict Detection

**Session detection:**
- `git worktree list` to find active worktrees and branches
- Match branch names to in-progress beads issues via naming convention (`feat/<slug>`)
- Display as "Active Sessions" section at top of smart-status output

**Conflict detection (two-tier approach from research):**

Tier 1 — File overlap (fast, always runs):
- For each in-progress issue with a branch, run `git diff master...<branch> --name-only`
- For ready-work issues without branches, check beads task list metadata for `File(s):` entries
- Compare file lists across issues
- Annotate ready-work items with `! Conflict risk: touches <file> (<in-progress-issue>)` when overlap found

Tier 2 — Actual conflict detection (optional, git 2.38+):
- Only for pairs with file overlap from Tier 1
- Use `git merge-tree --write-tree --name-only --no-messages --stdin` to batch-check all overlapping pairs
- Exit code 1 = real merge conflict; exit code 0 = no conflict despite file overlap
- Annotate with `!! Merge conflict` (tier 2) vs `! Conflict risk` (tier 1 only)

**Granularity:** File-level (not directory or line-level)

**Worktree parsing:** Use `git worktree list --porcelain` (forward slashes on Windows, key-value blocks separated by blank lines). Extract `branch refs/heads/<name>` per worktree.

---

## Constraints

- Script must work on Windows (Git Bash), macOS, and Linux
- Must handle repos with no worktrees (single-developer mode) gracefully
- Must not add significant latency to `/status` — target < 5 seconds for 50 issues
- Requires jq (available via winget/brew/apt on all platforms)
- Branch-name matching only — no new beads metadata fields
- Tier 2 conflict detection requires git 2.38+ (graceful fallback to tier 1 only)

---

## Edge Cases

1. **No in-progress issues**: Skip "Resume" and "Active Sessions" sections, show "Ready Work" first
2. **No worktrees**: Show single-session mode, skip conflict detection
3. **Orphan branches**: Branch exists but no matching beads issue — show as "untracked branch" warning
4. **Circular dependencies**: `bd` already prevents these; script trusts `bd blocked` output
5. **Issue with no timestamps**: Default staleness to 1.0 (fresh)
6. **Epic with all children closed**: epic_proximity = 1.5 (max boost) — but the epic itself should be closeable
7. **forge-preflight rename mid-flight**: Other in-progress branches may reference old name — blast-radius search required

---

## Ambiguity Policy

Use the project-wide 7-dimension rubric scoring:
- Score each spec gap across all 7 dimensions
- Composite score >= 80%: proceed and document the decision
- Composite score < 80%: stop and ask user for input

---

## Technical Research

### Architecture Decision: Single jq Invocation

The smart-status script will use a single `bd list --json --limit 0` call piped through one `jq -s` filter that:
1. Slurps all issues into an array
2. Computes composite score per issue using arithmetic
3. Sorts by `-.composite_score`
4. Groups into categories (resume/unblock/ready/blocked/backlog)
5. Formats output with ANSI colors

This avoids N subprocess spawns for `bd show` per issue. Performance: sub-second for 87+ issues.

### bd CLI Data Model (Key Fields)

Available via `bd list --json`:
- `id`, `title`, `status`, `priority` (0-4), `issue_type`
- `dependency_count` (blockers), `dependent_count` (what this blocks)
- `dependencies[]` with `depends_on_id` and `type`
- `created_at`, `updated_at` (RFC3339 timestamps)
- `notes`, `design`, `acceptance_criteria`

Epic/parent queries: `bd children <id> --json`, `bd list --parent <id>`

### Conflict Detection: Two-Tier Approach

- Tier 1: `git diff --name-only master...<branch>` per active branch (milliseconds each)
- Tier 2: `git merge-tree --write-tree --stdin` batches all overlapping pairs into one git process
- For 10 branches: ~11 git operations total, under 1 second

`git worktree list --porcelain` uses forward slashes on Windows, compatible with bash parsing.

### Taskwarrior Urgency Reference

Taskwarrior's urgency coefficient uses 14 additive factors:
- due (12.0), blocking (8.0), priority.H (6.0), active (4.0), age (2.0 linear to 365d)
- blocked (-5.0 penalty), waiting (-3.0 penalty)

Our approach differs: multiplicative factors (amplify high-impact items), epic proximity (Taskwarrior lacks), tiered staleness (vs linear age ramp).

### Cross-Platform Notes

- jq: Available on all 3 platforms (winget/brew/apt). Git Bash on Windows has jq via winget.
- Bash 4+ features (associative arrays, mapfile): AVOID — macOS ships bash 3.2.
- Date arithmetic: Use jq's `now` and `fromdateiso8601` — no shell `date` needed.
- `git merge-tree --write-tree`: Requires git 2.38+ (released 2022). This machine has git 2.51.0.

---

## OWASP Top 10 Analysis

### A03 Injection — APPLICABLE (Primary Risk)

**Risk:** `smart-status.sh` parses output from `bd show --json` and `git diff`, which can contain user-authored free text (issue titles, commit messages). Shell metacharacters could execute arbitrary commands if interpolated unsafely.

**Mitigation:**
- Reuse the `sanitize()` function from `beads-context.sh` (strips `$(...)`, backticks, semicolons, double quotes, newlines)
- Use `set -euo pipefail` and quote all variables
- Use `printf '%s'` over `echo` for user data
- Use `--` separator before user-derived arguments in `git diff`/`git log`
- All scoring/formatting done inside jq (no shell interpolation of user data)

### A01-A02, A04-A10 — NOT APPLICABLE

- No authentication, access control, or cryptographic operations
- No web interface, API endpoints, or network communication
- No database queries or SSRF vectors
- No server-side request handling
- Script is local-only, reads from local git repo and bd CLI

---

## TDD Test Scenarios

### Smart Status Script (`scripts/smart-status.sh`)

1. **Happy path — ranked output**: Given 5 issues (mix of priorities, types, statuses), verify output is sorted by composite score descending and grouped correctly
2. **Unblock chain scoring**: Issue that unblocks 3 downstream issues scores higher than isolated issue of same priority
3. **Staleness boost**: Issue untouched for 15 days gets 1.2x boost; issue untouched for 31+ days gets 1.5x
4. **Epic proximity**: Epic with 3/4 children closed gives remaining child 1.375x boost
5. **Status boost**: In-progress P3 bug scores higher than open P3 bug (1.5x multiplier)
6. **No issues**: Empty bd list produces graceful "No open issues" message
7. **No worktrees**: Single-session mode, no "Active Sessions" section, no conflict detection
8. **Conflict detection**: Two branches modifying same file produces conflict annotation
9. **jq missing**: Script prints install instructions and exits with code 1
10. **NO_COLOR respected**: Output contains no ANSI escape codes when NO_COLOR is set

### Phase Tracking (`/plan` command)

11. **Epic created at Phase 1 entry**: After entering /plan, bd list shows new epic with status=in_progress
12. **Stage transitions recorded**: After Phase 2 entry, bd show includes "plan complete -> ready for research" comment

### Rename (`forge-preflight`)

13. **Binary renamed**: `forge-preflight status` works; `forge-validate` is not found
14. **Package.json updated**: `npm bin` shows forge-preflight, not forge-validate
15. **Docs updated**: README.md, CHANGELOG.md, DEVELOPMENT.md reference forge-preflight

---
