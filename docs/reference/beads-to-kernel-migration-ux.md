# Beads To Kernel Migration UX

**Status**: 0.0.20 migration reference for Forge Kernel authority rollout.

**Related work**:

- PR A / `forge-2agy.2.1`: Kernel schema, migrations, and storage classifier.
- PR B / `forge-2agy.2.2`: Local SQLite WAL broker and command API contract.
- PR C / `forge-2agy.2.3`: Beads import/export adapter and fidelity report.
- PR D / `forge-2agy.2.4`: Conflict quarantine, idempotency, and evaluator fixtures.
- PR E / `forge-2agy.2.5`: Documentation and migration UX.

## User-Facing Position

Forge Kernel is the target issue authority. Beads remains compatibility input/output during the migration window so existing repositories can inspect, import, export, and recover issue state without treating `.beads` files as the new source of truth.

The migration UX should make three boundaries visible:

1. Import reads Beads state and creates Kernel-shaped records.
2. Export projects Kernel records back to Beads-compatible JSONL.
3. Projection failure does not invalidate Kernel authority.

## Current Compatibility

The Beads compatibility adapter is import/export only. It preserves issue IDs, statuses, priorities, parent-child dependencies, blockers, comments, close reasons, available timestamps, and fidelity counts where the current Beads projection exposes them.

Known compatibility gaps are explicit. Kernel schema v1 does not directly preserve every Beads field as first-class issue columns, so unsupported or non-authoritative fields must appear in the fidelity report rather than silently becoming Kernel authority.

## Recommended Operator Flow

1. Snapshot or back up the current Beads projection before migration.
2. Run import and review the fidelity report.
3. Keep export in dry-run mode until record counts, dependency edges, comments, close metadata, and unsupported-field gaps are understood.
4. If export writes are enabled, capture rollback snapshots for the Beads projection files before writing.
5. Treat any conflict or stale projection warning as a stop point until the quarantine report is reviewed.

## Rollback Boundaries

Import rollback is discard-only when import has not committed authoritative Kernel mutations. Discard the imported Kernel-shaped records and keep the original Beads projection unchanged.

Export rollback restores the previous Beads-compatible projection files captured before the export write. This rollback affects files such as `issues.jsonl`, `comments.jsonl`, and `dependencies.jsonl`; it does not roll back Kernel authority.

After Kernel command routing is active, a committed Kernel mutation must be reversed through a Kernel operation or a documented Kernel migration rollback. Do not use Beads export rollback as an authority rollback.

## Conflict Quarantine Boundary

Conflict quarantine is defined by the landed evaluator contract in [Kernel Conflict Evaluators](kernel-conflict-evaluators.md). Migration UX should reference that contract for exact quarantine behavior, evaluator evidence, and release-readiness checks.

The intended UX boundary is stable:

- stale revisions, duplicate writes, dependency cycles, and projection drift are detected before external projection;
- conflicting records are quarantined instead of projected as normal output;
- the operator gets enough detail to decide whether to repair source input, retry projection, or wait for a resolver path.

## Release Readiness Checklist

- Beads import fidelity report reviewed.
- Export dry-run reviewed before any write.
- Rollback snapshot path documented for write-enabled export.
- Projection failure behavior documented as non-authoritative rollback.
- Conflict quarantine behavior cross-checked against [Kernel Conflict Evaluators](kernel-conflict-evaluators.md).
