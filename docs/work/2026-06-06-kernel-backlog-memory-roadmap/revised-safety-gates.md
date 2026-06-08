# Revised Safety Gates and Implementation Sequence

This file supersedes the first-pass implementation order where the wording was too broad.

## Corrected SQLite position

SQLite remains the preferred local Kernel authority store, but only inside this safety envelope:

- one physical developer machine;
- supported local filesystem, not network share or cloud-sync folder where detectable;
- all participating worktrees resolve to the same canonical git common-dir and Kernel DB path;
- all writes go through one Kernel broker transaction path;
- real SQLite driver supports WAL, busy timeout, transactions, backup/checkpoint, and FTS5 where needed;
- event append, entity revision compare-and-swap, materialized update, and projection outbox enqueue are atomic;
- idempotency keys distinguish replay from collision;
- claim leases have DB-enforced invariants;
- multi-process contention tests pass against the real SQLite driver.

## Corrected team position

SQLite local files plus git are not team authority. Team writes require a serialized server authority with:

- project identity and membership/auth;
- server sequence and entity revision;
- server-side idempotency;
- replay/snapshot/recovery;
- config/workflow revision agreement;
- read-model lag visibility;
- offline refusal and recovery UX;
- projection outbox/dead-letter handling.

## Revised sequence

### Phase A — Planning PR hardening

- Include multi-evaluator findings.
- Create additional backlog issues for missing gates.
- Keep runtime code unchanged unless separately scoped.

### Phase B — Local broker proof

- Select/validate SQLite runtime driver.
- Implement atomic broker transaction contract.
- Implement idempotency collision/replay semantics.
- Implement DB-level claim lease invariants.
- Implement filesystem/WAL safety doctor.
- Run real multi-process contention tests.

### Phase C — Beads fidelity and migration safety

- Preserve unsupported Beads fields as provider extensions.
- Add Beads/Dolt ready-queue parity fixtures.
- Add import/export echo-loop prevention.
- Add stale external write quarantine.

### Phase D — Backlog/frontend contracts

- Define first-class sprint/release/milestone entities.
- Define board rank and mutation events.
- Define readiness and blocked-work policy.
- Define card/view/query JSON contracts.
- Define agent work view contract.

### Phase E — Knowledge layer safety

- Reconcile existing Forge project memory with the new knowledge layer.
- Define source chunk and citation schema.
- Add redaction/prompt-injection policy.
- Add FTS5 rebuild and retrieval quality fixtures.
- Define fact proposal lifecycle.
- Resolve recap command compatibility.

### Phase F — Hermes/provider integration

- Define orient/recap consumption schema.
- Define Kernel-only evidence/decision writeback.
- Add no-Hermes-profile-write guard.
- Add harness conformance tests.

### Phase G — Team authority

- Design protocol, auth, sequence, replay/snapshot, D1 lag, offline refusal, and projection outbox before any team-safe write claim.

## Implementation rule

No implementation issue may claim safety by architecture alone. Every safety claim must name the test or conformance fixture that proves it.
