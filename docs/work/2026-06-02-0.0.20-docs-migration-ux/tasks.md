# Tasks: 0.0.20 Docs And Migration UX

Issue: forge-2agy.2.5

## Task 1: Inspect Existing State

- [x] RED: Confirm the worktree starts clean enough to isolate PR E changes.
- [x] GREEN: Read existing 0.0.20 schema, broker, Beads import/export docs, docs index, and `.beads/issues.jsonl`.
- [x] REFACTOR: Record verified inputs in `design.md`.

## Task 2: Add Migration UX Reference

- [x] RED: Identify the missing public/reference doc that explains migration behavior across PR A/B/C and the PR D boundary.
- [x] GREEN: Add a concise Beads-to-Kernel migration UX reference covering compatibility, rollback, and quarantine handoff.
- [x] REFACTOR: Link the new reference from `docs/INDEX.md`.

## Task 3: Tracker Projection Cleanup

- [x] RED: Parse `.beads/issues.jsonl`, count records, and inspect `forge-2agy.2.1`, `forge-2agy.2.2`, `forge-2agy.2.4`, and `forge-2agy.2.5`.
- [x] GREEN: Close only `forge-2agy.2.1` and `forge-2agy.2.2` because GitHub PR #195 and PR #196 are merged.
- [x] REFACTOR: Re-parse/count JSONL and verify issue count and `_type` fields are preserved.

## Task 4: Validate And Commit

- [x] RED: Run focused JSONL shape validation before relying on tracker cleanup.
- [x] GREEN: Run docs-relevant Bun tests.
- [x] REFACTOR: Commit only allowed PR E files.
