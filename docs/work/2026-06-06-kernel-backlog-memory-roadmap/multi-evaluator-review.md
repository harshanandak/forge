# Multi-Evaluator Review: Kernel Storage, Backlog, and Knowledge Roadmap

## Method

Three independent evaluator agents reviewed the roadmap from separate perspectives:

1. Storage / concurrency / distributed systems.
2. Product / backlog / frontend / team workflow.
3. Knowledge / RAG / Hermes memory boundary.

This document records the consolidated findings and the changes that must be folded into the roadmap before implementation PRs begin.

## Overall verdict

The roadmap is directionally correct, but the first version was too optimistic in a few places. It is safe as a planning PR only after the amendments below are tracked.

The main correction is this:

> SQLite is fine for local authority only under a stricter safety envelope: supported local filesystem, real SQLite driver conformance, one canonical DB path per git common-dir, one Kernel broker transaction path, atomic compare-and-swap revisions, idempotency collision handling, DB-enforced claim invariants, and real multi-process contention tests.

The plan must not imply that local multi-agent safety, team-safe writes, Beads retirement, or knowledge-layer authority is already achieved.

## Cross-agent consensus

### 1. SQLite is still acceptable, but only with hard gates

SQLite WAL remains the right local-first choice. The missing piece is not “choose another database”; it is specifying and testing the transaction contract:

- `BEGIN IMMEDIATE` or equivalent writer acquisition.
- Atomic event append, entity revision CAS, materialized entity update, and projection outbox enqueue.
- Busy timeout plus retry taxonomy.
- Idempotency replay vs collision behavior.
- DB-level claim lease invariants.
- Real SQLite driver validation, not just mock/driver-seam tests.
- Local filesystem guardrails for network/cloud-sync/WSL path hazards.

### 2. Dolt/Beads still matters as compatibility and fidelity check

The evaluators agreed we should not delete or demote Beads too early. Forge must explicitly preserve or document loss for:

- Beads issue graph and ready-work behavior.
- Dolt history/branch-ish expectations.
- Labels, owner, creator, metadata, design/acceptance fields.
- Legacy events/interactions where possible.
- Import/export echo-loop prevention.

### 3. The frontend model needs real contracts

The current model names backlog, sprint, ready queue, agent work, and roadmap views, but needs concrete schemas:

- Sprint/release/milestone entities.
- Board rank and drag/drop mutation events.
- Readiness and blocked-work policy.
- Card response shape including readiness, claims, workflow, rollups, projection health, and agent commands.
- Pagination, facets, read-model revision, stale indicator, and delta/event sync.

### 4. The knowledge layer needs safety contracts

The MemPalace lesson is right: verbatim-first, scoped retrieval, layered context, temporal facts. The missing safety work:

- Exact citation schema: source path, event id, line/byte span, content hash, commit SHA, entity revision, redaction state, index version.
- Redaction and privacy rules for logs/prompts/evidence.
- Prompt-injection-safe rendering: retrieved content is evidence, not instruction.
- Summary/fact proposal lifecycle: proposed, accepted, rejected, superseded, expired.
- Retrieval quality fixtures.
- Compatibility with existing `lib/project-memory.js`, typed memory, and `bd remember`.

### 5. Hermes remains a consumer, not a memory target

Forge should expose bounded JSON via orient/recap/search and accept evidence/decision writeback only through Kernel APIs. Forge should not write Hermes profile memories/skills unless a user explicitly configures that behavior.

## Required roadmap amendments

### Storage / concurrency amendments

- Add atomic SQLite transaction contract issue.
- Add real SQLite driver and FTS5 capability validation issue.
- Add filesystem/WAL safety doctor issue.
- Add idempotency collision/replay issue.
- Add DB-level claim lease invariant issue.
- Expand busy-timeout policy to include transaction mode, retries, checkpoint behavior, and user-facing errors.

### Beads / projection amendments

- Preserve unsupported Beads fields as provider extensions before broad migration.
- Add import/export echo-loop prevention.
- Add real Beads/Dolt ready-queue parity fixtures.
- Ensure stale external writes quarantine instead of overwriting Kernel authority.

### Backlog / frontend amendments

- Add sprint/release/milestone entity and rollup model.
- Add board rank and mutation event model.
- Add readiness/blocked-work policy model.
- Expand frontend issue card JSON shape.
- Add agent work contract for claims, stages, evidence, and allowed next actions.

### Knowledge / Hermes amendments

- Reconcile existing Forge project memory with the Project Knowledge Layer.
- Add source chunk/citation schema.
- Add redaction and prompt-injection safety policy.
- Add retrieval quality/provenance fixtures.
- Resolve `forge recap` naming/backward compatibility.
- Add Hermes no-profile-write integration guard.

## Revised go/no-go gates

### GO as planning PR if

- This multi-evaluator review is included.
- The additional Beads issues are created or folded into existing issues.
- Plan language clearly states SQLite local safety is gated by tests and runtime contracts.
- The plan remains docs/backlog only and does not change runtime authority code.

### NO-GO for local multi-agent safety claims until

- Real SQLite driver conformance passes.
- Multi-process contention tests pass against real SQLite.
- Atomic broker transaction/CAS/outbox behavior is implemented.
- Claim lease races are DB-enforced and tested.

### NO-GO for team-safe write claims until

- Server authority protocol, identity/auth, idempotency, replay/snapshot, config revision agreement, D1/read-model lag, and offline refusal UX are designed and tested.

### NO-GO for Beads retirement until

- Unsupported fields are preserved or loss is explicit.
- Ready-work parity fixtures pass or intentional differences are documented.
- Projection/import echo loops and stale external writes are quarantined.

### NO-GO for knowledge/Hermes integration until

- Orient/recap/search JSON schemas and budgets exist.
- Provenance, redaction, prompt-injection handling, and retrieval quality tests exist.
- Forge does not write Hermes private memory/skills except by explicit user configuration.
