# Tasks: 0.0.20 Beads Import/Export Adapter And Fidelity Report

## Task 1: Import fixture and adapter contract

TDD:
- RED: Add Beads JSONL fixtures and tests for IDs, statuses, priorities, parent-child dependencies, blockers, comments, close reason, and timestamps.
- GREEN: Implement `loadBeadsSnapshotFromDirectory` and `importBeadsSnapshot`.
- REFACTOR: Keep the importer pure and independent of PR B broker internals.

## Task 2: Fidelity report

TDD:
- RED: Assert preserved fields and unsupported-field gaps in the adapter result.
- GREEN: Add the fidelity report output with counts, preserved fields, and gaps.
- REFACTOR: Keep gap messages explicit enough for release notes and handoff.

## Task 3: Dry-run export

TDD:
- RED: Assert Kernel records export to Beads JSONL without writing by default.
- GREEN: Implement dry-run `exportKernelToBeads` output for `issues.jsonl`, `comments.jsonl`, and `dependencies.jsonl`.
- REFACTOR: Preserve close reason from Kernel events when rebuilding Beads issues.

## Task 4: Rollback path

TDD:
- RED: Assert export captures previous Beads file contents and rollback restores them.
- GREEN: Implement export rollback snapshots and `rollbackBeadsExport`.
- REFACTOR: Keep rollback at the adapter boundary and avoid wider state mutation.

## Task 5: Scoped work docs

TDD:
- RED: Add a docs guard for the PR C boundary, fidelity report, dry-run, and rollback path.
- GREEN: Add this work folder with design, tasks, and decisions.
- REFACTOR: Keep docs scoped to `forge-2agy.2.3`.
