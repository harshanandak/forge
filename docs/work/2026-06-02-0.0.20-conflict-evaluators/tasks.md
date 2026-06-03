# Tasks: 0.0.20 Conflict Quarantine and Evaluators

## Task 1: Pure evaluator decisions

TDD:
- RED: Add tests for stale revision quarantine, idempotency replay, duplicate write dedupe, and dependency-cycle quarantine.
- GREEN: Implement a pure `lib/kernel/evaluators.js` module.
- REFACTOR: Keep evaluator inputs serializable so fixtures can exercise them without a database runtime.

## Task 2: Broker guard ordering

TDD:
- RED: Add tests proving the broker inserts conflicts before projection and skips outbox creation for quarantined writes.
- GREEN: Add guarded event execution through injected broker driver methods.
- REFACTOR: Preserve the existing broker contract and avoid bundling SQLite.

## Task 3: Evaluator fixtures and drift guards

TDD:
- RED: Add fixture tests for import fidelity, priority ordering, dependency correctness, idempotency, and drift guard violations.
- GREEN: Add evaluator fixtures under `test/fixtures/kernel-evaluators`.
- REFACTOR: Keep expected outcomes explicit and readable.

## Task 4: Docs handoff for migration UX

TDD:
- RED: Add docs tests proving the conflict evaluator reference is indexed.
- GREEN: Document quarantine, idempotency, duplicate write dedupe, dependency-cycle guards, and projection ordering.
- REFACTOR: Keep final migration UX closure in the parallel PR E branch.
