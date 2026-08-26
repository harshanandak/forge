# Decisions

## Decision 1

**Date**: 2026-08-19
**Task**: Task 1 — Dormant transactional owner primitive
**Gap**: The planned tokenized pathname lock could not make token verification and rename/delete atomic, and path validation could not prevent a parent junction swap across separate pathname operations.
**Score**: 7/14
**Route**: SPEC-REVIEWER
**Choice made**: User selected option A: store watcher authority as one row in the existing shared Kernel SQLite database. Use short `BEGIN IMMEDIATE` transactions and remove JSON owner files plus custom lock artifacts.
**Status**: RESOLVED

## Decision 2

**Date**: 2026-08-19
**Task**: Task 1 — Transaction boundaries
**Gap**: External provider, PID, Memory, journal, monitor, retry, and sleep work cannot execute while a shared Kernel writer transaction is held.
**Score**: 5/14
**Route**: SPEC-REVIEWER
**Choice made**: Use two-phase evidence: snapshot transaction, external verification/work, then exact-generation CAS transaction. Never nest owner transactions with another Kernel or event-journal operation.
**Status**: RESOLVED

## Decision 3

**Date**: 2026-08-19
**Task**: Task 1 — Schema identity
**Gap**: The plan requires a composite primary key, while the current Kernel schema DSL and renderer support only inline single-column primary keys.
**Score**: 5/14
**Route**: SPEC-REVIEWER
**Choice made**: Extend the schema DSL and DDL renderer with a validated table-level composite-primary-key contract, used identically by fresh-schema creation and additive migration. The authority identity is physically `PRIMARY KEY (repo, pr)`; a secondary unique index is not a substitute.
**Status**: RESOLVED

## Decision 4

**Date**: 2026-08-19
**Task**: Task 2 — Legacy cutover
**Gap**: Snapshot-then-import allowed a legacy writer race, and evidence without canonical repository/PR identity could not be represented by an owner row.
**Score**: 6/14
**Route**: SPEC-REVIEWER
**Choice made**: Add a repository-local singleton migration gate separate from watcher authority. Publish `quarantined` before disabling legacy launchers, require two identical bounded legacy snapshots around external evidence verification, CAS-bind that exact hash into the gate before any owner insert, then use one ordered idempotent owner transaction per PR while the same gate/hash remains authoritative. Reread every row and the source durably before an exact `(quarantined, hash) -> (complete, same hash)` CAS. Unmappable identity publishes a tagged `conflict`, retains its source, and blocks starts/retirement without fabricating an owner row. Crash recovery resumes from the persisted gate and exact snapshot hash.
**Status**: RESOLVED

## Decision 5

**Date**: 2026-08-19
**Task**: Task 2 — Migration cutover integration
**Gap**: Task 2 could neither read the migration gate without mutating it nor import verified dead-open legacy evidence directly into `starting` under the bound gate/hash.
**Score**: 6/14
**Route**: SPEC-REVIEWER
**Choice made**: Add exactly two narrow Task 1 APIs before cutover: non-mutating `readMigrationGate`, and gate-bound two-phase `importLegacyStarting`. Imported `starting` rows carry a validated legacy evidence hash that is preserved across later transitions. No generic transition, raw transaction, or alternate authority is added.
**Status**: RESOLVED
