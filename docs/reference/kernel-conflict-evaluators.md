# Kernel Conflict Evaluators

**Status**: 0.0.20 conflict quarantine slice.

## Contract

Kernel event writes are evaluated before projection. The evaluator can accept a write, return a prior accepted idempotency result, dedupe an equivalent write, or quarantine the write as a conflict.

Quarantined writes insert `kernel_conflicts` records and do not enqueue projection outbox entries. This keeps Beads, GitHub, Linear, and other downstream projections from resolving authority conflicts.

## Guarded Cases

- Stale `expected_revision` values quarantine the write with the actual entity revision.
- Duplicate idempotency keys return the original accepted event without creating a second event or projection.
- Equivalent duplicate writes dedupe even when the retry uses a different idempotency key.
- Dependency writes that would create a dependency cycle quarantine before projection.
- Fixture cases cover import fidelity, priority ordering, dependency correctness, idempotency, and drift guard violations.

## Broker Ordering

The local broker remains dependency-free. Drivers provide the storage runtime and the broker enforces this order:

1. Load the authority entity revision, prior events, and dependencies.
2. Evaluate the event.
3. Insert a conflict for quarantined writes and stop.
4. Insert accepted events.
5. Enqueue projection outbox rows only after event acceptance.
