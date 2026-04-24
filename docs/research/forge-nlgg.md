# Research: forge-nlgg

- Feature: `forge-nlgg`
- Date: `2026-04-24`
- Status: `complete`
- Parent: `forge-f3lx`
- Worktree: `.worktrees/f3lx`
- Branch: `feat/f3lx`

## Problem

Forge now has the first authority-layer seam from `forge-ya9l`: `lib/commands/issues.js` routes issue operations through `lib/forge-issues.js` instead of building `bd` argv at the command edge. The next missing layer is a normalized GitHub sync model.

Today the repo uses multiple overlapping link and sync mechanisms:

- `scripts/github-beads-sync/index.mjs` creates and closes Beads issues from GitHub issue events.
- `scripts/github-beads-sync/reverse-sync.mjs` closes GitHub issues by parsing issue URLs back out of Beads descriptions.
- `scripts/forge-team/lib/sync-github.sh` reads `github_issue:N` state from `bd show`, then mutates GitHub assignees, labels, and state directly.
- `.github/beads-mapping.json`, bot comments, `externalRef`, `github_issue` state, and description URLs all act as partial identity links.

That overlap is the dual-write drift problem in a different form: GitHub, Forge, and Beads can all mutate related state, but there is no single Forge-owned shared model that decides which fields are shared, which system owns each field, or how pull and push reconcile.

## Scope Assessment

**Strategic/Tactical**: Strategic

**Why**: This work defines the cross-system authority model and the sync primitives that later issues depend on. It changes architecture, command behavior, and data ownership rules across multiple modules.

## Verified Repo Findings

### Forge issue authority seam already exists

- `lib/commands/issues.js` is a thin command adapter that delegates to `runIssueOperation(...)` in `lib/forge-issues.js`.
- `lib/forge-issues.js` currently exposes only a Beads-backed backend with `create`, `list`, `show`, `close`, and `update`.
- `lib/commands/_issue.js` still provides legacy direct wrappers such as `forge claim`, `forge close`, and `forge show`, so not all write paths go through the new authority seam yet.

### Current GitHub sync uses multiple link primitives

- `scripts/github-beads-sync/index.mjs` uses `.github/beads-mapping.json`, sync comments, and `externalRef=gh-<number>` to create or close Beads issues from GitHub issue events.
- `scripts/github-beads-sync/reverse-sync.mjs` parses GitHub issue URLs from Beads descriptions to close GitHub issues.
- `scripts/forge-team/lib/sync-github.sh` stores and reads `github_issue=<number>` in Beads state, then edits GitHub issue labels/assignees directly.

### Prior design intent already points toward a Forge-owned shared core

- `docs/plans/2026-04-06-forge-v2-unified-strategy.md` defines WS3 as a beads wrapper plus GitHub-backed coordination, not a beads replacement.
- The same strategy doc requires CLI/MCP parity through a shared issue core and explicitly calls for `bd create + GitHub sync queue`.
- `docs/plans/2026-04-13-forge-f3lx-issues-design.md` intentionally stops at the backend seam and leaves sync, reconciliation, and import to later children such as `forge-nlgg`.

## Key Decisions

### Decision 1: Use field-level authority, not system-level last-write-wins

**Reasoning**: The user asked for a specific split: GitHub owns shared identity/state, Beads is a local cache/backend, Forge owns workflow rules. That cannot be modeled safely with "the most recent system wins." The reconciliation rule needs to be "the owning field wins."

### Decision 2: Introduce a Forge-owned normalized shared record

**Reasoning**: The repo currently spreads identity and sync state across mapping files, comments, Beads metadata, and description URLs. `forge-nlgg` should collapse those into one canonical Forge-owned record that is persisted locally and can project to GitHub and Beads.

### Decision 3: Keep workflow context out of GitHub

**Reasoning**: The epic and child issue both explicitly exclude pushing rich workflow state, agent memory, and handoff context into GitHub. GitHub should carry team-visible issue state, not become the storage layer for Forge internals.

### Decision 4: Make import a consumer of sync primitives, not a second sync system

**Reasoning**: `forge-ij1` should not invent its own backfill rules. It should call the same GitHub listing, link resolution, shared-record building, and local materialization primitives that ongoing pull sync uses. That keeps initial import and steady-state sync aligned.

## Proposed Shared Model

### GitHub-owned shared fields

- GitHub issue identity: `number`, `nodeId`, `url`
- GitHub-visible content: `title`, canonical issue body/summary
- GitHub-visible state: `open` / `closed`
- Shared coordination fields: assignees, labels, milestone
- GitHub timestamps used for pull cursors and drift detection

### Forge-owned fields

- Forge issue ID and local/backend identifiers
- Parent/child relationships and dependency graph
- Workflow stage, ready/blocked semantics, and stage-transition metadata
- Acceptance criteria, progress notes, handoff context, and memory
- Sync bookkeeping: last pulled cursor, last pushed shared hash, pending outbound operations, drift diagnostics

### Beads-owned role

- Local execution backend and query surface for Forge
- Materialized cache of GitHub-owned shared fields plus Forge-owned workflow state
- No direct authority over shared fields beyond acting as Forge's local store

## Conflict Resolution Model

1. Resolve ownership first.
2. If a GitHub-owned field changes remotely, GitHub wins and the local cache is updated on pull.
3. If a Forge-owned field changes locally, GitHub pull must not overwrite it.
4. Local writes to GitHub-owned fields should happen only through Forge write paths that also enqueue outbound sync.
5. If local cache and GitHub diverge on a GitHub-owned field, keep the GitHub value and log a drift event instead of silently merging.
6. Identity conflicts resolve by stable key precedence:
   - `github.nodeId`
   - GitHub issue number in the same repo
   - Existing Forge link record
   - Legacy bridges: `externalRef`, `github_issue`, mapping file, sync comment, description URL

## Push / Pull Trigger Model

### Push triggers

- `forge issues create`
- `forge issues update` when the updated field belongs to the shared set
- `forge issues close`
- Legacy wrappers that still mutate shared fields, such as `forge claim` and `forge close`, once routed through the shared core
- `forge sync` as an explicit flush path

### Pull triggers

- `forge sync`
- `forge status` / `forge board` cache refresh hooks
- Startup / periodic daemon poll
- `forge-ij1` bulk import bootstrap, which should use the exact same pull primitives with pagination

## Risks

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Duplicate link records | Existing repo already has several link sources | Centralize on one Forge link store and treat legacy values as migration inputs only |
| Shared/local field bleed | Current shell scripts mutate GitHub labels from local state directly | Make the authority matrix explicit in code and tests |
| Import drift | A dedicated import path can diverge from steady-state pull sync | Make `forge-ij1` consume the same list/reconcile/materialize primitives |
| Legacy wrapper bypass | `forge claim` still bypasses the new `forge issues` seam | Route all shared-field mutations through the sync core before calling GitHub adapters |

## TDD Test Scenarios

### Scenario 1: GitHub-owned field wins on pull

Given a linked issue where the local cache has stale labels, when GitHub labels change remotely, pull sync updates the local cache to the GitHub value and records the sync cursor.

### Scenario 2: Forge-owned workflow context survives pull

Given a linked issue with local workflow stage, dependencies, and progress notes, when GitHub title or assignee changes, pull sync keeps all Forge-owned fields unchanged.

### Scenario 3: Outbound write enqueues only shared-field changes

Given a Forge issue update, when the changed field is in the shared set, push sync emits a GitHub projection; when the change is local-only workflow state, no outbound GitHub mutation is queued.

### Scenario 4: Legacy link sources collapse into one canonical record

Given an issue with a mapping-file entry, a `github_issue` state value, and a sync comment, reconciliation resolves them to one canonical link record instead of creating duplicates.

### Scenario 5: Import reuses pull primitives

Given a page of existing GitHub issues with no local counterparts, the import path uses the same normalize-and-materialize primitives as steady-state pull sync and produces link records ready for ongoing sync.
