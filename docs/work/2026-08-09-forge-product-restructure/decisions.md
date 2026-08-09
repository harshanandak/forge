# Forge 0.1.0 Restructuring Development Decisions

## Decision 1

**Date**: 2026-08-09
**Task**: PR 1 lane B — issue-bound approval events
**Gap**: The issue proposed `forge control approve|status <id>`, while `forge control` already owns policy classification and `forge gate approve <issue-id> <gate-id>` already owns durable issue-bound human decisions. Adding approval verbs to `control` would create a second authority surface.
**Score**: 6/14; mandatory override — permission/security surface
**Route**: BLOCKED
**Choice made**: Keep `forge control` limited to mandatory/optional/permission policy configuration. Keep approval authority on the existing issue-bound gate event surface: `forge gate approve <issue-id> <gate-id>`. If bounded expiry is required, extend that existing event with `--ttl`; do not add project-scoped approval or a new `forge issue approve`/`forge control approve` command. Unscoped approval fails closed.
**Status**: RESOLVED

## Decision 2

**Date**: 2026-08-09
**Task**: PR 1 lane C — production issue/PR trace emission
**Gap**: The trace primitive correctly requires issue revision, exact head SHA, WorkPacket hash, risk-manifest digest, and gate receipts, but current ship/merge callers do not possess the full authoritative envelope. PR 2 owns WorkPacket/receipt contracts, while PR 4B owns ship/merge lifecycle wiring. Synthesizing or accepting caller-asserted evidence in PR 1 would weaken authority.
**Score**: 12/14; mandatory override — authority/security and persistent contract boundary
**Route**: BLOCKED
**Choice made**: Do not integrate the unused PR 1 trace commits. Move the production linkage outcome to PR 4B after PR 2 freezes the Memory-owned evidence contract, then wire ship/merge using the validated immutable receipt. Keep the Kernel primitive branch available for rebasing rather than inventing evidence.
**Status**: RESOLVED

## Decision 3

**Date**: 2026-08-10
**Task**: PR 3 Memory foundation — durable monitor event, delivery receipt, cursor, and terminal receipt storage
**Gap**: The approved plan fixes the public `MonitorEvent`, `DeliveryReceipt`, and `MonitorReceipt` contracts and requires durable, idempotent sequence/cursor behavior, but it does not specify the physical storage model, table ownership, uniqueness keys, acknowledgement transaction, migration rollback, or whether the existing Kernel event/projection outbox may be reused. Implementing schema or migration code now would invent a persistent authority contract.
**Score**: 12/14; mandatory override — persistent schema/data model and rollback boundary
**Route**: BLOCKED (schema slice only)
**Alternatives**:
1. Reuse `kernel_events` plus the existing projection outbox/dead-letter tables. This avoids a migration, but those tables currently model Kernel authority events and JSONL projection delivery; their target/status model does not prove per-monitor sequence cursors, acknowledgements, terminal receipts, or transport delivery semantics.
2. Add Memory-owned monitor event, delivery receipt/cursor, terminal receipt, and feedback report tables. This gives explicit query and uniqueness semantics, but the approved plan does not define the keys, acknowledgement transaction, retention indexes, or rollback contract required to create them safely.
3. Keep the public `@forge/memory` interface storage-agnostic, append validated monitor contracts through an adapter backed by existing Kernel primitives only where their semantics are proven, and defer any new physical schema until a follow-up decision freezes keys, transactions, indexes, and rollback. This is the smallest safe migration path but cannot claim the full durable monitor-storage outcome yet.
**Choice made**: Stop only the monitor schema/migration slice. Continue non-dependent recall, retention, read-attention, and session-summary work. Recommend alternative 3, subject to an approved schema decision proving whether existing primitives satisfy every sequence/cursor/receipt invariant; do not create tables or migrations from inference.
**Status**: PENDING-DEVELOPER-INPUT
