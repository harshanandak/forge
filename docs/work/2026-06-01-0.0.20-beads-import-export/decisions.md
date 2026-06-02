# Decisions: 0.0.20 Beads Import/Export Adapter And Fidelity Report

## D1: Preserve close reason as a Kernel event

PR A schema v1 has no direct `issues.closed_at` or `issues.close_reason` columns. The adapter preserves close reason and closed-at values as `beads.issue.closed` Kernel events with a JSON payload, then uses those events to reconstruct Beads export output.

Impact: This preserves fidelity without changing PR A schema or depending on PR B broker internals.

## D2: Dry-run export by default

`exportKernelToBeads` defaults to `dryRun: true`. Callers must pass `dryRun: false` and a `beadsDir` to write files.

Impact: The adapter boundary supports safe inspection and rollback before any `.beads` projection write.

## D3: Explicit unsupported-field gaps

The report marks Beads owner, labels, and dependency metadata as unsupported by Kernel schema v1 instead of silently dropping them.

Impact: Release and follow-up work can decide whether those fields need schema additions or should remain intentional cuts.
