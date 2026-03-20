# Workflow Intelligence Epic — Design Doc

- **Feature**: workflow-intelligence
- **Date**: 2026-03-21
- **Status**: Draft
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
- `bd list` (all statuses) for issue inventory
- `bd show <id> --json` for dependencies, epic membership, timestamps
- `git worktree list` + branch naming convention for session detection
- `git diff master...<branch> --name-only` for file-level conflict detection
- Beads task list `File(s):` entries as fallback for issues without branches

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

**Rename scope:** bin/forge-validate.js, package.json (bin entry), all agent command files that reference it, AGENTS.md, docs, tests.

### 4. Session Awareness & Conflict Detection

**Session detection:**
- `git worktree list` to find active worktrees and branches
- Match branch names to in-progress beads issues via naming convention (`feat/<slug>`)
- Display as "Active Sessions" section at top of smart-status output

**Conflict detection:**
- For each in-progress issue with a branch, run `git diff master...<branch> --name-only`
- For ready-work issues without branches, check beads task list metadata for `File(s):` entries
- Compare file lists across issues
- Annotate ready-work items with `! Conflict risk: touches <file> (<in-progress-issue>)` when overlap found

**Granularity:** File-level (not directory or line-level)

---

## Constraints

- Script must work on Windows (Git Bash), macOS, and Linux
- Must handle repos with no worktrees (single-developer mode) gracefully
- Must not add significant latency to `/status` — target < 5 seconds for 50 issues
- No new dependencies (pure bash + existing `bd` CLI + `git`)
- Branch-name matching only — no new beads metadata fields

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
