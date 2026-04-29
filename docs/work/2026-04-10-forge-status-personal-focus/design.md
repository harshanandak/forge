## Feature

- **Slug**: `forge-status-personal-focus`
- **Issue**: `forge-sxg2`
- **Date**: `2026-04-10`
- **Status**: `Phase 2 complete / awaiting approval`

## Purpose

`forge status` currently succeeds only when the caller supplies authoritative workflow context through `--workflow-state` or `--issue-id`. The command does not yet provide the zero-argument "what should I work on right now?" view requested for Forge v2.

This track adds a zero-arg personal status dashboard that works from local repo state first. The command should show branch/worktree context, active Beads work assigned to the current developer, ready work, recent completions, and the current workflow stage when an active `/plan -> /verify` cycle can be resolved unambiguously.

## Verified Baseline

1. The current command parses `--issue-id`, `--workflow-state`, `--bd-comments`, and `--project-root`, then tries to resolve workflow state from those inputs rather than auto-discovering current work (`lib/commands/status.js:341-360`).
2. When no authoritative workflow state is found, the command returns a low-confidence placeholder that explicitly asks for `--workflow-state` or `--issue-id` (`lib/commands/status.js:399-409`).
3. The current formatter is stage-centric and emits either authoritative stage output or heuristic fallback output; it does not render branch/worktree context, personal issue groups, or recent completions (`lib/commands/status.js:440-515`).
4. The workflow-state loader already supports `.forge-state.json` plus Beads comment-backed state, but only when a project root or issue id is supplied (`lib/workflow/state-manager.js:22-79`).
5. The repo already has reusable worktree detection that distinguishes the main checkout from linked worktrees and returns the current branch (`lib/detect-worktree.js:6-47`).
6. The WS1 strategy doc describes a broader personal dashboard vision for `forge status`, including ready/blocked/PR groupings and multi-dimensional ranking, but that vision is larger than the zero-arg local slice requested here (`docs/plans/2026-04-06-forge-v2-unified-strategy.md:109-159`).
7. Targeted status baselines currently pass:
   - `bun test --timeout 15000 test/status-command.test.js test/commands/status-smart.test.js` -> `13 pass / 0 fail`
   - `bun test --timeout 15000 test/commands/status.test.js` -> `22 pass / 0 fail`

## Success Criteria

1. Running `forge status` with no flags succeeds from the repo root or a linked worktree.
2. Zero-arg output includes current branch and worktree context, including whether the checkout is the main worktree or a linked worktree.
3. Zero-arg output includes active Beads issues assigned to the current developer and filtered to `in_progress`.
4. Zero-arg output includes ready Beads issues that are open and not blocked by unresolved dependencies.
5. Zero-arg output includes recent completions from local Beads state.
6. If an active workflow cycle can be identified, zero-arg output shows the current authoritative workflow stage and next command.
7. If workflow-stage discovery is ambiguous or unavailable, the command still returns the other sections and explains that no active workflow cycle was detected.
8. Existing explicit `--workflow-state` and `--issue-id` behavior remains backward compatible.

## Out of Scope

1. GitHub PR sections such as "Your PRs" and "PRs awaiting your reply".
2. The external issue classifier described in WS1 for non-Forge metadata.
3. Role-aware ranking via `.forge/config.yaml`.
4. Shared Dolt-backed state or cross-repo/team aggregation.
5. Replacing the existing authoritative workflow-state model with a new stage system.

## Approach Selected

### Selected approach

Add a small JS status-context layer ahead of the existing status command:

1. Keep `lib/commands/status.js` as the command entry point and preserve explicit-flag behavior.
2. Add zero-arg context discovery helpers that gather:
   - git branch, dirty/clean state, and linked-worktree details
   - Beads issue snapshots from local `.beads/issues.jsonl`
   - current developer identity from local git config
   - current workflow state from `.forge-state.json` first, then a discovered current issue if one can be resolved safely
3. Render a new human-readable dashboard for the zero-arg path while preserving the existing stage-oriented output for explicit authoritative calls.

### Why this approach

1. It solves the user-requested gap without dragging in GitHub API, PR state, or role-configuration work.
2. It reuses verified repo primitives that already exist: authoritative workflow-state parsing and worktree detection.
3. It avoids coupling the CLI to the older shell-based `smart-status.sh` output format, while still leaving room to borrow future ranking logic if needed.
4. It keeps the explicit authoritative path intact for tests and downstream callers.

### Rejected alternatives

#### 1. Shell out to `scripts/smart-status.sh` and print its output

Rejected because the feature request targets `forge status` in `lib/commands/status.js`, and the shell script covers a broader, different surface with session/team features that are not needed for this slice.

#### 2. Implement the full WS1 smart dashboard in one track

Rejected because the explicit request is narrower: zero-arg local context plus Beads-backed personal work focus. Pulling in PR integrations, external classification, and config-driven role scoring would expand the scope well past the requested feature.

#### 3. Infer workflow stage heuristically again when no authoritative state exists

Rejected because the current command intentionally prefers authoritative stage data. This slice should add discovery, not reintroduce guesswork as the primary source of truth.

## Data Model and Resolution Order

### Branch/worktree context

Collect:

1. current branch
2. main-vs-linked worktree status
3. linked worktree path and main worktree path when applicable
4. dirty/clean working tree summary

Implementation note: reuse `detectWorktree()` and add a lightweight git-status helper rather than embedding shell parsing in the command.

### Current developer identity

Resolve from:

1. `git config user.email`
2. `git config user.name`

Assignment matching should prefer `issue.owner === user.email` and fall back to `created_by === user.name` only when `owner` is absent.

### Beads issue snapshot

Read local `.beads/issues.jsonl` and apply last-write-wins grouping by issue id. The snapshot layer should expose:

1. `activeAssigned`: `status === "in_progress"` and assigned to current developer
2. `ready`: `status === "open"` and `dependency_count === 0`
3. `recentCompleted`: `status === "closed"` sorted by `updated_at` descending, capped for display

### Current workflow cycle discovery

Resolution order:

1. Explicit `--workflow-state`
2. Explicit `--issue-id`
3. `.forge-state.json` in the current checkout
4. Auto-discovered current issue from branch/worktree context when unambiguous

Auto-discovered current issue rules:

1. Match non-main feature/worktree slug against issue design metadata when the design/task path embeds the same slug.
2. If no slug match exists, allow exactly one owned `in_progress` issue as the current issue.
3. If multiple candidates remain, treat workflow-stage detection as ambiguous and omit the workflow section rather than guessing.

## Output Design

Default zero-arg output should use five sections in this order:

1. `Context`
2. `Active Issues`
3. `Ready`
4. `Recent Completions`
5. `Workflow`

Display rules:

1. Empty sections should print a concise "none" message rather than disappearing silently.
2. Ready and recent-completion lists should cap at a small default count and mention overflow when more items exist.
3. The workflow section should say either:
   - authoritative stage + next command, or
   - no active workflow cycle detected
4. If explicit authoritative flags are used, preserve the current stage-centric output contract instead of forcing the new dashboard.

## Constraints

1. Zero-arg must work entirely from local git and Beads state.
2. The command must remain useful on `master` and in linked worktrees.
3. Stage reporting must stay authoritative-only.
4. The implementation must not require GitHub access or new credentials.
5. Existing status exports used by tests must remain available.

## Edge Cases

1. **No `.beads/issues.jsonl` present**
   - Return context plus a clear message that no Beads issue data is available.
2. **Multiple owned `in_progress` issues on `master`**
   - Show all active issues, but mark workflow stage as ambiguous unless `.forge-state.json` exists.
3. **Feature branch with no design metadata on issues**
   - Fall back to the "exactly one owned in-progress issue" rule only.
4. **Malformed issue rows or duplicate JSONL entries**
   - Ignore invalid rows and apply last-write-wins per id.
5. **Missing git identity**
   - Show context and non-personal ready/completed sections, but explain that assigned-work filtering is unavailable.
6. **Current repo has `.forge-state.json` but no Beads issue match**
   - Use the file-backed workflow state anyway; the workflow section is about current checkout state, not issue discovery alone.

## Ambiguity Policy

Use the repo's existing `/dev` rubric threshold:

1. If confidence is `>= 80%`, proceed conservatively and document the decision.
2. If confidence is `< 80%`, stop and ask.

For this feature, the high-impact ambiguities are:

1. changing the authoritative workflow-state contract
2. guessing a current issue when multiple active candidates exist
3. adding GitHub/PR integration to this slice

## Technical Research

### Current command contract

The current command has already moved away from filesystem heuristics as the primary path. It reads authoritative workflow state from explicit input or state-manager helpers, then formats that state into a stage summary. The gap is not stage parsing; the gap is zero-arg discovery and broader personal-work presentation.

Relevant code:

1. `lib/commands/status.js:341-409`
2. `lib/commands/status.js:440-515`
3. `test/status-command.test.js:20-155`

### Existing repo helpers worth reusing

1. `lib/detect-worktree.js:13-47` already returns `inWorktree`, `branch`, and `mainWorktree`.
2. `lib/workflow/state-manager.js:57-79` already resolves workflow state from file first, then Beads.
3. `scripts/smart-status.sh:275-376` proves the repo already values worktree/session-aware status and local issue ranking, but its shell-centric surface is broader than the requested CLI slice.
4. `scripts/sync-utils.sh:35-80` documents current git-based identity conventions that align with local-developer filtering.

### Scope decision versus WS1 strategy

The WS1 strategy doc describes a much larger "smart personal status" command with PR integrations, label/body-based classification, JSON mode, and role-specific scoring (`docs/plans/2026-04-06-forge-v2-unified-strategy.md:109-159`). This design deliberately narrows the first implementation slice to the concrete requirements in the current issue request:

1. branch/worktree context
2. assigned active work
3. ready work
4. recent completions
5. current workflow stage when active

That narrower scope is the safest standalone implementation with no dependency on other tracks.
