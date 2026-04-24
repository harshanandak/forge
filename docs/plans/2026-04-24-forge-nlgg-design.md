# Feature

- Slug: `forge-nlgg`
- Date: `2026-04-24`
- Status: `planned`
- Issue: `forge-nlgg`
- Parent Epic: `forge-f3lx`
- Branch: `feat/f3lx`
- Worktree: `.worktrees/f3lx`
- Research: `docs/research/forge-nlgg.md`

## Purpose

Define the normalized bidirectional Forge-GitHub sync model that turns GitHub into the shared team-visible issue surface without making GitHub the owner of Forge workflow semantics or replacing Beads as the local backend.

This issue is the missing layer between:

- `forge-ya9l`, which established the first Forge-owned issue command seam in `lib/commands/issues.js` and `lib/forge-issues.js`, and
- `forge-ij1`, which needs stable GitHub pull/materialization primitives before it can import existing issues safely.

## Success Criteria

1. A Forge-owned normalized shared issue record exists with an explicit authority matrix for GitHub-owned fields, Forge-owned fields, and Beads' cache role.
2. Shared-field sync is defined at field level, not as ad hoc direct `bd` and `gh` mutations.
3. The link contract between Forge issues and GitHub issues has one canonical representation, with current mapping/comment/state/url mechanisms treated as migration inputs only.
4. Push triggers and pull triggers are defined through Forge-owned command paths (`forge issues`, `forge sync`, daemon/status refresh), not scattered shell scripts.
5. `forge-ij1` can consume the resulting list/reconcile/materialize primitives without inventing a separate import-specific sync model.
6. GitHub Projects / board visibility remains derived or additive; GitHub is not made the authority for workflow stage, memory, or handoff data.

## Out Of Scope

- Full import/backfill orchestration for existing GitHub issues. That is the follow-on implementation tracked by `forge-ij1`.
- Full mirroring of every Beads field into GitHub.
- Storing workflow stage, progress notes, acceptance criteria, handoff context, or agent memory in GitHub.
- Replacing Beads as the local issue engine.
- Treating GitHub Projects v2 as the system of record.
- Solving the broader Dolt/worktree runtime issues unrelated to the shared sync contract.

## Approach Selected

Implement a Forge-owned `shared issue` layer that sits between command surfaces and adapters:

1. **Normalize**
   - Build one canonical `SharedIssueRecord` from GitHub snapshots, Forge metadata, and legacy link hints.
   - Separate the record into `github`, `shared`, `forge`, `cache`, and `sync` sections.
2. **Reconcile**
   - Apply field-level ownership rules:
     - GitHub owns shared identity/state fields.
     - Forge owns workflow semantics and local metadata.
     - Beads stores the materialized local record and search/query surface.
   - Resolve identity conflicts by stable key precedence and collapse legacy link sources into one record.
3. **Project**
   - Outbound Forge writes mutate the local backend first, then enqueue GitHub projection only for shared fields.
   - Inbound GitHub pulls materialize the latest shared snapshot into local state without overwriting Forge-owned fields.
4. **Reuse**
   - Expose `listRemoteIssues`, `normalizeRemoteIssue`, `resolveSharedLink`, and `materializeLocalIssue` primitives.
   - `forge-ij1` uses those same primitives for initial import instead of a separate backfill pipeline.

### Authority Split

#### GitHub = shared identity/state

- Issue identity: number, node ID, URL
- Team-visible content: title and canonical issue body/summary
- Team-visible state: open/closed
- Shared coordination metadata: assignees, labels, milestone
- Remote timestamps used for pull cursors and drift checks

#### Forge = workflow rules

- Forge issue ID and internal link metadata
- Parent/child/dependency graph
- Workflow stage and derived ready/blocked semantics
- Acceptance criteria, progress notes, stage-transition context, decisions, memory
- Sync bookkeeping such as pending outbound writes, last pull cursor, and drift diagnostics

#### Beads = local cache/backend

- Materializes the combined local issue state that Forge commands query and mutate
- Stores the Forge-owned metadata plus a cached GitHub shared snapshot
- Does not define the authority rules for shared fields

### Sync Model

#### Shared fields that sync

- `github.number`
- `github.nodeId`
- `github.url`
- `shared.title`
- `shared.body`
- `shared.state`
- `shared.assignees`
- `shared.labels`
- `shared.milestone`
- `sync.remoteUpdatedAt`

#### Local-only fields that do not sync to GitHub

- Forge issue ID / local backend IDs
- Workflow stage and stage-transition metadata
- Dependencies and parent/child relationships
- Acceptance criteria, progress notes, handoff context, memory
- Drift logs and sync cursors

#### Conflict resolution

1. Determine the owning field.
2. For GitHub-owned fields, remote GitHub state wins on pull.
3. For Forge-owned fields, local Forge state wins and survives pull.
4. Local changes to GitHub-owned fields are legal only through Forge write paths that also emit outbound GitHub sync.
5. If the same shared field differs locally and remotely, store the GitHub value, preserve the local audit trail, and log drift instead of last-write-wins.

### Push / Pull Triggers

#### Push

- `forge issues create`
- `forge issues update` when the updated field belongs to the shared set
- `forge issues close`
- Legacy wrappers such as `forge claim` once routed through the same shared core
- `forge sync` explicit flush

#### Pull

- `forge sync`
- `forge status` / `forge board` freshness checks
- Daemon/background refresh
- `forge-ij1` import bootstrap through paginated GitHub listing

### Why this approach

- It matches the authority split requested in the issue and user prompt.
- It preserves the backend seam created in `forge-ya9l` instead of regressing to direct `bd` and `gh` writes.
- It gives `forge-ij1` a stable base: import becomes an initial pull over the same normalization and reconciliation code used every day.

## Alternatives Considered

### Option A: GitHub as the source of truth for everything

Rejected.

- It violates the explicit scope that Forge owns workflow rules and rich agent context.
- It would push workflow-specific data into a surface meant for shared team coordination.

### Option B: Keep current mixed link model and tighten scripts

Rejected.

- The current model already has too many identity links (`mapping`, `github_issue`, `externalRef`, comments, description URLs).
- Hardening each script separately would preserve drift rather than remove it.

### Option C: Field-level authority with a Forge-owned shared record

Selected.

- It cleanly separates shared team-visible state from Forge workflow metadata.
- It gives both bidirectional sync and initial import the same primitives.

## Constraints

- The existing `forge issues` service seam in `lib/forge-issues.js` should remain the entry point for new shared-field behavior.
- Legacy wrappers that still mutate shared fields must be folded into the same shared sync core before this issue is considered complete.
- GitHub Projects / board state must stay derived or additive, not authoritative.
- The design must accommodate existing legacy link data during migration without creating duplicate issues.
- Sync logic must translate downstream errors into Forge-level diagnostics rather than surfacing raw `bd` / `gh` failures directly.

## Edge Cases

- A local issue has both a mapping-file entry and a `github_issue` state value that disagree.
- A GitHub issue is renamed or relabeled while a developer has stale local cache.
- A Forge local-only update (workflow stage, dependency change, progress note) occurs alongside a remote GitHub label change.
- A GitHub issue exists with no local mirror yet; import should materialize it without bypassing the canonical link store.
- A GitHub issue is closed remotely while the local issue still has in-progress Forge workflow metadata.
- Legacy wrappers (`forge claim`, shell hooks) mutate GitHub directly before they are fully rerouted through the shared core.

## Ambiguity Policy

Use the repo's `/dev` decision-gate rubric.

- If confidence is `>= 80%`, choose the conservative option, document it in the decisions log during implementation, and continue.
- If confidence is `< 80%`, stop and ask before changing the ownership matrix, shared-field set, or link resolution precedence.

## Technical Research

### Current Repo Findings

- `lib/commands/issues.js` and `lib/forge-issues.js` already define the initial Forge-owned issue seam from `forge-ya9l`.
- `lib/commands/_issue.js` still bypasses that seam for legacy commands including `claim`.
- `scripts/github-beads-sync/index.mjs` currently handles GitHub-opened and GitHub-closed events using `.github/beads-mapping.json`, sync comments, and `externalRef`.
- `scripts/github-beads-sync/reverse-sync.mjs` currently closes GitHub issues by parsing issue URLs from Beads descriptions.
- `scripts/forge-team/lib/sync-github.sh` currently relies on `github_issue` state in Beads and directly mutates labels/assignees on GitHub.

### Design Inputs From Existing Docs

- `docs/plans/2026-04-06-forge-v2-unified-strategy.md` requires a shared issue core with CLI/MCP parity and explicitly describes `bd create + GitHub sync queue`.
- The same strategy doc frames WS3 as "wrap beads + shared Dolt + GitHub sync", not as a beads rewrite.
- `docs/plans/2026-04-13-forge-f3lx-issues-design.md` intentionally leaves sync, reconciliation, and import work to later child issues.
- `docs/research/forge-nlgg.md` captures the verified current-state overlap and the strategic need for a normalized shared record.

### Baseline / Planning Preconditions

- The requested worktree already existed at `.worktrees/f3lx` on branch `feat/f3lx`.
- `bd update forge-f3lx --claim` succeeded from the main workspace.
- The repo's current `forge plan forge-nlgg` adapter initially blocked on runtime prerequisites, then on a missing `docs/research/forge-nlgg.md` artifact. It still assumes the older flow that creates a new Beads issue/branch, so this child-issue plan is documented directly under the existing epic worktree instead of using that adapter to create a duplicate issue.
- Baseline validation in this worktree currently reports `719 pass / 36 skip / 1 fail` via `node scripts/test.js --validate`. The remaining failure is `CLI Registry Integration > non-registry stage enforcement > forge verify still invokes stage enforcement outside the registry`. Because this plan is docs-only, the baseline failure is recorded here and implementation should either tolerate it as pre-existing or fix it separately before `/ship`.

## TDD Scenarios

1. Pull sync updates GitHub-owned shared fields in the local cache while preserving Forge-owned workflow context.
2. Outbound Forge writes project only shared-field changes to GitHub and never push local-only workflow metadata.
3. Link reconciliation collapses legacy sources (`mapping`, `github_issue`, sync comments, `externalRef`, description URL) into one canonical link record.
4. A local workflow-only update does not trigger outbound GitHub mutation.
5. `forge-ij1` import uses the same normalize/reconcile/materialize primitives as ongoing pull sync.
