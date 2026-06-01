# Tasks: 0.0.20 Kernel Schema, Migrations, and Storage Classifier

## Task 1: Kernel schema registry

TDD:
- RED: Add tests proving the registry includes issues, dependencies, comments, priority events, claims, sessions, worktrees, stage runs, evidence, projections, conflicts, events, outbox entries, and dead letters.
- GREEN: Implement `lib/kernel/schema.js` with entity/table definitions, fields, primary keys, and indexes.
- REFACTOR: Keep definitions data-driven so later broker and adapter PRs can consume the same registry.

## Task 2: Storage classifier and field authority metadata

TDD:
- RED: Add tests proving every table and field has a valid storage class and field authority aligned to `docs/reference/FORGE_KERNEL_STORAGE_MODEL.md`.
- GREEN: Add storage classes, field authorities, and classifier helpers to `lib/kernel/schema.js`.
- REFACTOR: Make drift failures point at the missing table or field.

## Task 3: Reversible local migration plans

TDD:
- RED: Add tests proving migrations apply in order, roll back in reverse order, reject duplicate IDs, and generate deterministic SQL.
- GREEN: Implement `lib/kernel/migrations.js` with migration validation, apply-plan generation, and rollback-plan generation.
- REFACTOR: Keep SQL generation small and explicit; do not introduce a database runtime dependency in this slice.

## Task 4: Drift guards and release documentation

TDD:
- RED: Add tests proving docs mention the schema, migration, and storage-class contract and that the reference model stays linked.
- GREEN: Add `docs/reference/forge-kernel-schema.md` and update `docs/INDEX.md`.
- REFACTOR: Keep docs scoped to the 0.0.20 schema slice and clearly mark broker/import/conflict work as follow-up PRs.
