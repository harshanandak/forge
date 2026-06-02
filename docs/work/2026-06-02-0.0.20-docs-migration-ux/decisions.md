# Decisions: 0.0.20 Docs And Migration UX

Issue: forge-2agy.2.5

## D1: Document Migration UX As A Reference Guide

Decision: Add `docs/reference/beads-to-kernel-migration-ux.md` instead of expanding implementation work docs only.

Rationale: The migration behavior is cross-slice user guidance. A reference guide can cite PR A/B/C behavior and stay stable while implementation remains in separate branches.

## D2: Keep Conflict Quarantine As A Forward Boundary

Decision: Explain that conflicts will be quarantined before projection, but do not document final commands, output fields, or evaluator fixture names until PR D lands.

Rationale: PR D owns `forge-2agy.2.4`. Prematurely documenting exact behavior would create a compatibility promise before the implementation and evaluator fixtures are merged.

## D3: Rollback Scope Is Projection-Only For Beads Export

Decision: State that Beads export rollback restores `.beads` projection files captured before a write, while Kernel authority remains intact.

Rationale: PR C import/export docs define dry-run by default and rollback snapshots for Beads files. Treating export failure as a Kernel rollback would violate the Kernel authority model.

## D4: Tracker Cleanup Is Limited To Merged PR A/B

Decision: Close `forge-2agy.2.1` and `forge-2agy.2.2` only after verifying GitHub PR #195 and PR #196 are merged.

Rationale: The task explicitly allows cleanup for already-merged PR A/B only. `forge-2agy.2.4` and `forge-2agy.2.5` remain open.
