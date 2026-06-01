# Feature: 0.0.20 Kernel Schema, Migrations, and Storage Classifier

Date: 2026-06-01
Status: locked for development
Issue: forge-2agy.2.1
Branch: codex/0.0.20-kernel-schema

## Purpose

Define the first Forge Kernel authority implementation surface. This slice gives later broker, Beads adapter, conflict quarantine, and workflow work a stable schema contract, reversible local migrations, and a storage classifier grounded in `docs/reference/FORGE_KERNEL_STORAGE_MODEL.md`.

## Success Criteria

- Kernel entities are represented as explicit schema definitions for issues, dependencies, comments, priorities, claims, sessions, worktrees, stage runs, evidence, projections, conflicts, events, outbox entries, and dead letters.
- Local migrations can apply and roll back deterministically without depending on Beads or Dolt.
- Storage classification covers authority, read model, projection, archive, configuration, cache, and external-provider fields.
- The schema exposes indexes needed by ready queues, issue detail reads, dependency traversal, stage/run queries, projection repair, and conflict quarantine.
- Tests prove migration reversibility, entity coverage, storage classification, and drift guards against the storage model reference.

## Out of Scope

- No command routing through the Kernel API; that belongs to `forge-2agy.2.2`.
- No full SQLite broker mutation API; this PR only provides schema and migration primitives.
- No Beads import/export implementation; this PR only reserves schema surfaces for `forge-2agy.2.3`.
- No conflict resolution engine; this PR only defines conflict/quarantine tables for `forge-2agy.2.4`.
- No Cloudflare, D1, Durable Object, or team-authority implementation.

## Approach Selected

Add a small Kernel schema module and migration runner:

- `lib/kernel/schema.js` exports table definitions, indexes, storage classes, field authority metadata, and validation helpers.
- `lib/kernel/migrations.js` exposes reversible migration planning for local SQLite-style stores without requiring a SQLite dependency in this slice.
- `test/kernel-schema.test.js` verifies entity coverage, migration ordering, reversible SQL shape, index coverage, and storage classification drift guards.

The migration runner emits deterministic SQL statements and rollback statements. The next PR can bind those plans to the actual local SQLite WAL broker while this PR remains testable with the current dependency set.

## Constraints

- Keep this PR dependency-free unless an existing dependency already supports the need.
- Do not mutate `.beads` files or treat Beads as write authority.
- Keep schema names stable and boring; later broker and adapter PRs should consume them directly.
- Keep generated SQL deterministic across Windows and Unix.
- Preserve the public command surface until the broker PR routes commands through Kernel APIs.

## Edge Cases

- Duplicate migration IDs must be rejected.
- Rollback order must be the reverse of apply order.
- Unknown storage classes and field authorities must fail validation.
- Projection and conflict tables must be present even before adapter/conflict engines exist.
- Worktree/session fields must include Git common-dir and branch/path metadata so 0.0.21 can build lease coordination on top.

## Ambiguity Policy

Use the 7-dimension `/dev` decision gate. If confidence is at least 80%, proceed and document the choice in `decisions.md`. If confidence is below 80%, stop and request developer input.
