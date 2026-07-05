# 0.0.20 Conflict Evaluators Design

## Intent

Add the first Kernel conflict evaluator surface after the schema, broker, and Beads adapter contracts. This slice keeps the broker dependency-free while proving the command path can detect stale revisions, idempotent replays, duplicate writes, and dependency cycles before projection.

## Scope

- Pure evaluator helpers for Kernel event acceptance, dedupe, and quarantine.
- Broker orchestration through injected driver methods.
- Fixtures and tests for stale revision quarantine, idempotency, dependency correctness, and decision drift guard coverage.
- Conflict evaluator docs and fixtures that PR E can reference for final migration UX.

## Boundaries

- No bundled SQLite runtime.
- No conflict resolution command UI.
- No Beads projection writes from Kernel authority in this slice.
- No closure for `forge-2agy.2.4` until this PR merges and verifies.
- Tracker cleanup for already-merged A/B slices is handled in the parallel docs/migration UX PR to avoid direct protected-state edits from this worktree.

## Architecture

The evaluator accepts an event draft plus a minimal authority snapshot. It returns one of:

- `accept`: insert the event and enqueue projection.
- `duplicate`: return the previously accepted idempotency result.
- `dedupe`: return the previously accepted equivalent write.
- `quarantine`: insert a conflict record and skip projection.

The broker owns operation order. Conflict insertion happens before projection enqueueing, and quarantined writes never create outbox rows.
