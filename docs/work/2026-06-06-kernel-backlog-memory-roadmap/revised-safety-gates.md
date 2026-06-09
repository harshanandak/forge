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

**Stage exit:** Summary — planning gaps are captured without runtime changes. Decisions — SQLite local authority and projection boundaries are explicit. Artifacts — evaluator notes, issue proposals, and decision updates. Next — synchronize accepted backlog proposals through authoritative state.

### Phase B — Local broker proof

- Select/validate SQLite runtime driver.
- Implement atomic broker transaction contract.
- Implement idempotency collision/replay semantics.
- Implement DB-level claim lease invariants.
- Implement filesystem/WAL safety doctor.
- Run real multi-process contention tests.

**Stage exit:** Summary — local broker safety is proven against the real driver. Decisions — local safety claims are limited to one machine/common-dir. Artifacts — broker contract, doctor checks, contention fixtures, and validation logs. Next — gate downstream local-agent claims on these fixtures.

### Phase C — Beads fidelity and migration safety

- Preserve unsupported Beads fields as provider extensions.
- Add Beads/Dolt ready-queue parity fixtures.
- Add import/export echo-loop prevention.
- Add stale external write quarantine.

**Stage exit:** Summary — Beads/Dolt remains a tested projection and migration surface. Decisions — compatibility is preserved outside Kernel authority. Artifacts — parity fixtures, dry-run reports, and quarantine tests. Next — retire hot-path dependencies only after parity passes.

### Phase D — Backlog/frontend contracts

- Define first-class sprint/release/milestone entities.
- Define board rank and mutation events.
- Define readiness and blocked-work policy.
- Define card/view/query JSON contracts.
- Define agent work view contract.

**Stage exit:** Summary — work graph/UI contracts are ready for implementation. Decisions — agile concepts remain views over Kernel entities. Artifacts — entity schema notes, board mutation contracts, and JSON examples. Next — implement behind Kernel revision/idempotency rules.

### Phase E — Knowledge layer safety

- Reconcile existing Forge project memory with the new knowledge layer.
- Define source chunk and citation schema.
- Add redaction/prompt-injection policy.
- Add FTS5 rebuild and retrieval quality fixtures.
- Define fact proposal lifecycle.
- Resolve recap command compatibility.

**Stage exit:** Summary — Knowledge is a rebuildable read model, not authority. Decisions — summaries/facts stay proposals until Kernel acceptance. Artifacts — chunk schema, redaction policy, rebuild fixtures, and retrieval checks. Next — expose bounded orient/recap outputs.

### Phase F — Hermes/provider integration

- Define orient/recap consumption schema.
- Define Kernel-only evidence/decision writeback.
- Add no-Hermes-profile-write guard.
- Add harness conformance tests.

**Stage exit:** Summary — Hermes consumes Forge project state without replacing Hermes memory. Decisions — Forge writes project evidence only through Kernel contracts. Artifacts — orient/recap schema, writeback guard, and harness tests. Next — add provider adapters after Knowledge MVP.

### Phase G — Team authority

- Design protocol, auth, sequence, replay/snapshot, D1 lag, offline refusal, and projection outbox before any team-safe write claim.

**Stage exit:** Summary — team writes are blocked until serialized authority exists. Decisions — raw SQLite/git/Dolt merges are not team authority. Artifacts — protocol design, auth model, recovery plan, and projection outbox contract. Next — build server authority before enabling multi-machine writes.

## Implementation rule

No implementation issue may claim safety by architecture alone. Every safety claim must name the test or conformance fixture that proves it.
