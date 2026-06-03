# Forge Kernel Schema And Migrations

**Status**: 0.0.20 schema slice reference.
**Storage model**: [Forge Kernel storage model](FORGE_KERNEL_STORAGE_MODEL.md).

## Purpose

This document records the contract for the 0.0.20 Forge Kernel schema slice. It is a release reference for the schema registry, local migration plans, and storage-class metadata. It does not define the broker runtime, importer/exporter behavior, or conflict resolver behavior; those remain follow-up PRs.

## Schema registry contract

`lib/kernel/schema.js` is the source of truth for Kernel table definitions in this slice. The registry must keep table names, fields, primary keys, indexes, storage classes, and field authority metadata together so later broker and adapter work can consume one deterministic definition.

The schema registry covers these Kernel surfaces:

- issues,
- dependencies,
- comments,
- priority events,
- claims,
- sessions,
- worktrees,
- stage runs,
- evidence,
- projections,
- conflicts,
- events,
- outbox entries,
- dead letters.

Kernel events persist `expected_revision` alongside the idempotency key and payload. Conflict evaluators depend on that revision metadata to distinguish a true equivalent retry from a later intentional write that returns an entity to an earlier payload.

Every table and field must declare a storage class and field authority that match [FORGE_KERNEL_STORAGE_MODEL.md](FORGE_KERNEL_STORAGE_MODEL.md). Drift guard failures should name the missing or invalid table or field.

## Migration contract

`lib/kernel/migrations.js` owns reversible local migration plans for this slice. Migration definitions must:

- apply in declared order,
- roll back in reverse order,
- reject duplicate migration IDs,
- produce deterministic SQL,
- avoid introducing a database runtime dependency.

Migration SQL generation should stay small and explicit. Runtime connection management, broker coordination, and remote execution are outside this slice.

`expected_revision` on `kernel_events` is added by the additive `002_kernel_events_expected_revision` migration so existing local Kernel databases created by the initial schema migration gain the column during upgrade.

## Storage-class contract

Storage-class metadata must answer the storage model questions before a table or field lands:

- What is authoritative?
- What is cached?
- What is projected?
- What is archived?
- What remains local-only?
- What requires server acceptance?
- What happens when projection fails?

The valid classes and authority rules are inherited from [FORGE_KERNEL_STORAGE_MODEL.md](FORGE_KERNEL_STORAGE_MODEL.md). This schema reference links that model so changes to schema, migrations, or storage classification cannot drift into undocumented authority behavior.

## Follow-up PRs

This document intentionally limits 0.0.20 to schema, migration, and storage-class contracts. Follow-up PRs should cover:

- broker read/write execution,
- Beads import and export adapters,
- conflict detection and resolution workflows,
- projection delivery workers,
- dead-letter repair operations,
- team-mode server acceptance paths.
