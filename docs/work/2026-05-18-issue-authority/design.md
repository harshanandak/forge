# 0.0.18 Issue Authority

## Issues Covered

- `forge-3yrz`: IssueAdapter SPI with Beads reference adapter.
- `forge-f3lx`: Forge issue authority and GitHub-backed coordination.
- `forge-ij1`: only primitive-level support if it stays inside the existing issue-sync import boundary.

## Current State

PR #168 (`0.0.18 adapter foundation`) is open, not merged. This branch is stacked on `codex/0.0.18-adapter-foundation` at `a03f8cf` because that branch already exposes the adapter foundation shape in `lib/review-adapter.js` and documents that IssueAdapter is non-scope for that PR.

The repo already has issue authority primitives:

- `lib/issue-sync/authority.js` defines GitHub-, Forge-, and cache-owned field paths.
- `lib/issue-sync/reconcile.js` applies GitHub-owned fields and records drift diagnostics.
- `lib/issue-sync/import-primitives.js` materializes GitHub issue payloads through the same reconciliation path.
- `lib/forge-issues.js` wraps Beads operations behind a service/backend boundary.

## Design

Add a first-class `IssueAdapter` SPI that mirrors the review adapter foundation style but stays issue-specific:

- `list(args, context)`
- `read(args, context)`
- `create(args, context)`
- `update(args, context)`
- `close(args, context)`
- `comment(args, context)`
- `mapStatus(status, context)`
- `decideAuthority(change, context)`

Implement `BeadsIssueAdapter` as the reference adapter. It delegates to the existing Beads operation runner, maps Beads `show` to `read`, maps `comment` to `bd comments add`, and exposes Forge-owned authority decisions through the existing issue-sync authority tables.

Keep GitHub-backed coordination on the existing primitive layer. This slice should not build a team dashboard UI, ReviewAdapter internals, or a separate GitHub issue client. If import behavior is touched, it must reuse `lib/issue-sync/import-primitives.js` and not create a second reconciliation contract.

## Authority Model

- GitHub owns shared team-visible identity and state fields: GitHub issue id, URL, title, body, state, assignees, labels, milestone, and remote update timestamps.
- Forge owns workflow and project context: issue id, dependencies, parent/child links, workflow stages, acceptance criteria, progress notes, stage transitions, decisions, memory, outbound projection bookkeeping, and drift diagnostics.
- Beads is the local/reference issue adapter and cache backend. It can store Forge-owned state and materialized GitHub snapshots, but it is not the cross-team source of truth for shared GitHub fields.
- Cache fields are derived and may be rebuilt.

## Conflict Behavior

GitHub-owned remote changes overwrite local materialized shared fields during pull/import. Differences are retained as drift diagnostics rather than silently discarded. Forge-owned fields are not overwritten by GitHub pull/import. Unknown fields are rejected by the authority decision helper so callers cannot accidentally claim ownership without updating the model.

## Non-Scope

- Team dashboard UI.
- ReviewAdapter internals beyond consuming the foundation shape.
- Full GitHub issue write client.
- GitHub Projects migration or board automation.
- Importing all comments/discussions.
