# Forge Kernel Storage Model

**Status**: Planning reference for the Forge Kernel authority reset.
**Canonical design**: [Forge Kernel authority control plane](../work/2026-04-28-skeleton-pivot/forge-kernel-authority-control-plane.md).

## Purpose

This document defines where Forge Kernel state lives, what is authoritative, what is cached, what is projected, and what is archived. It exists to prevent future implementation work from drifting back into Beads-first, GitHub-first, or harness-first storage.

## Storage Layers

```text
Authority
  Local mode: local SQLite WAL broker
  Team mode: Cloudflare Durable Object per project

Read model
  Local mode: SQLite query tables
  Team mode: D1 query tables

Projection state
  Beads export/import status
  GitHub/Linear projection delivery status
  dead letters and repair state

Repository exports
  Explicit Kernel projection snapshots for clone/bootstrap/review only
  Not the durability channel for routine local or team writes

Archive
  Local evidence archive
  R2 for server-side large evidence/log/artifact bundles

Configuration
  .forge/workflow.yaml
  .forge/providers/*.yaml
  .forge/providers.lock later
  generated harness files as projections only
```

## Authority Rules

1. Forge Kernel owns issue, claim, stage, run, and projection state.
2. Beads is import/export compatibility only.
3. GitHub and Linear are server-side projections only.
4. Harness files are generated projections only.
5. D1 is a read model, not the claim authority.
6. Queues retry projection work, not core issue mutations.
7. R2 stores large evidence and archives, not hot authority fields.
8. Routine close/verify state is never made durable by committing tracker metadata to the protected default branch.
9. Repository exports are explicit projection artifacts, not the write-ahead log for normal work.

## Local Mode

Local mode is for one user working across one or more local worktrees.

Local SQLite WAL broker stores:

- issue graph,
- dependencies and blockers,
- comments,
- priorities,
- claims and stale/reclaim state,
- stages and substages,
- worktrees,
- sessions,
- runs,
- event log,
- local outbox,
- projection/import/export status.

Local mode may work without a server. It must still prevent two local worktrees from double-claiming the same issue.

Local mode is intentionally local-only. Closing an issue, recording a run, updating a claim, or saving project knowledge in local mode must not require a Git commit or push. If the user wants another machine or teammate to see that state, Forge must use team mode server authority or an explicit export/import operation.

### SQLite Runtime Driver

Forge Kernel local mode uses a builtin SQLite runtime driver. Driver selection must feature-detect `bun:sqlite` first and backup-capable `node:sqlite` second, and must not add a native-compile SQLite package as the default install path.

The selected driver must pass conformance checks for WAL mode, `busy_timeout`, transactions, WAL checkpointing, backup creation, and FTS5 before Forge claims real local SQLite authority behavior.

## Team Mode

Team mode requires server authority.

Cloudflare components:

- Worker API validates auth, project membership, and routes requests.
- Durable Object serializes issue mutations and claims for a project.
- D1 stores queryable read models for dashboards and reports.
- Queues run retryable Beads/GitHub/Linear projections.
- R2 stores optional large evidence, validation artifacts, and archived session bundles.

Team mode must block claim/start/close/stage-transition writes when the server cannot accept them.

Team mode is the only shared write authority. Cross-machine and multi-user close/verify state must be accepted by the server before Forge reports it as shared truth. Projection workers may update GitHub, Linear, Beads, or explicit export artifacts after acceptance, but projection failure never rolls back the accepted server event.

## Local Versus Server Matrix

| Data | Local mode | Team mode | Rule |
| --- | --- | --- | --- |
| Issue identity/title/body/type | SQLite authority | Durable Object authority + D1 read model | Server acceptance required in team mode. |
| Priority/order | SQLite authority | Durable Object authority + D1 read model | Deterministic reorder events. |
| Dependencies/blockers | SQLite authority | Durable Object authority + D1 read model | Ready queue depends on this. |
| Comments | SQLite authority | Durable Object authority + D1 read model | Sensitive local-only notes allowed only in local mode. |
| Claims/leases | SQLite authority | Durable Object authority | Team claims are never offline-authoritative. |
| Worktree path | SQLite full path | Redacted/normalized server record | Avoid leaking full local paths by default. |
| Session state | SQLite | Durable Object + D1 read model | Required for team visibility. |
| Stage/substage state | SQLite | Durable Object + D1 read model | Source for gates and workflow progress. |
| Run events | SQLite | Durable Object + D1 read model | Raw details may be summarized before upload. |
| Evidence metadata | SQLite | D1 metadata + optional R2 object | Store pointers and hashes. |
| Raw prompts/tool logs | Local only by default | Optional redacted R2 archive | Never push by default. |
| Provider manifests | Project files + local cache | Optional server hash/copy | Required providers need revision agreement. |
| Workflow config | Project files + local cache | Server copy/hash in team mode | Team writes require config revision agreement. |
| Beads import source | Local archive | Not uploaded by default | Upload only migration summary if needed. |
| Beads export output | Local projection | Projection status only | Export failure never rolls back Kernel state. |
| Kernel repository export | Explicit local export | Explicit server export/projection | Repository files are reviewable snapshots, not hot authority. |
| GitHub/Linear projection | Local status cache | Server outbox/projection table | Server workers own external projection. |
| Dead letters/conflicts | SQLite | Durable Object/D1 dead-letter state | Must be visible before release readiness. |

## Drift Guard

Any PR that changes storage, authority, sync, projections, issue commands, workflow configuration, or provider loading must answer:

```text
What is authoritative?
What is cached?
What is projected?
What is archived?
What remains local-only?
What requires server acceptance?
What happens when projection fails?
```

If those answers change, update this document, the authority plan, and locked decisions.
