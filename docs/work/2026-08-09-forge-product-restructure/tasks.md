# Forge 0.1.0 Restructuring Tasks

**Status:** Approved development handoff
**Epic:** `d6a74dc8-10f7-4be9-9761-2467c3df4798`
**Plan:** [plan.md](./plan.md)
**Decision register:** [decision-register.md](./decision-register.md)

## Operating contract

- Deliver seven milestones through eight cohesive PRs in this merge order: PR 1 -> PR 2 -> PR 3 -> PR 4A -> PR 4B -> PR 5 -> PR 6 -> PR 7.
- PR 3 and PR 4A may be prepared in parallel only after PR 2 freezes their public contracts; Memory merges first.
- One issue and one non-overlapping file owner per task. The main integrator alone owns shared manifests, lockfiles, generated projections, and cross-product fixtures.
- Use one failing contract or journey before implementation, then the smallest risk-owned verification lane. Do not repeat a broad suite on an unchanged SHA. Run the complete matrix once on the final exact release candidate.
- Mandatory deterministic replans occur at 20% and 30% of the declared token budget. Choose completion or resumable handoff at 35%; stop all new work at 39%.
- Unrelated discoveries become separate Kernel issues and cannot expand an active PR.

## Task 0 — Admission checkpoint

**Outcome:** every implementation/migration candidate has executable acceptance criteria in Kernel authority before production code changes.

1. Read the issue at its expected revision and apply the approved contract from [acceptance-contracts.md](./acceptance-contracts.md).
2. Read the issue back and verify the exact revision, normalized acceptance text, owner PR, product owner, affected contract, and validation owner.
3. Generate `admission-evidence.v1.json`; any missing, stale, conflicting, or unverified write is `INCOMPLETE`.
4. Claim and prove ownership of the first PR 1 child issue. Do not claim the restructuring epic itself.

## Task 1 — PR 1: control-plane trust and fast validation

**Outcome:** claims, readiness, affected-test selection, and release evidence are trustworthy enough to support the train.

- Reconcile claim projections and enforce contract-valid readiness.
- Add the versioned risk-to-test ownership manifest and changed-surface selector.
- Separate PR, scheduled, and release validation lanes without weakening security, authority, migration, or data-integrity coverage.
- Add prerelease/RC dist-tag behavior, exact-SHA receipts, beta.5 corpus capture, state inventory, verified backup, and non-mutating migration dry-run scaffolding.
- Verify only control-plane, manifest-selection, release-preflight, and compatibility-corpus owner lanes.

## Task 2 — PR 2: Memory contracts and package boundaries

**Outcome:** public contracts and package boundaries exist without behavior change.

- Add `@forge/memory-contracts`, `@forge/memory`, and `@forge/flow` package boundaries.
- Define canonical envelopes, WorkPacket, ContextPacket, RunReceipt, MonitorEvent, DeliveryReceipt, and MonitorReceipt schemas, validators, semantic identities, fixtures, and compatibility snapshots.
- Add forbidden-private-import checks and preserve the legacy facade's command, JSON, and exit behavior.
- Freeze the exact API commit consumed by PR 3 and PR 4A.

## Task 3 — PR 3: Forge Memory foundation

**Outcome:** Kernel authority, durable memory, monitor evidence, and feedback intake are available only through Memory public APIs.

- Move or wrap authority, broker, schema, migrations, issues, runs, evidence, memory, and projections.
- Split storage concerns behind internal Memory interfaces.
- Implement durable monitor event/outbox storage, idempotent sequence/cursor semantics, and receipt ingestion without importing Flow.
- Preserve authority, privacy, migration, and rollback behavior through the beta.5 corpus and Memory owner lanes.

## Task 4A — PR 4A: Forge Flow core, skills, observers, and efficiency

**Outcome:** standalone packet execution and one universal Monitor Engine work without PR-specific semantics.

- Implement Flow execution, bounded-loop APIs, Smith/skill composition, and process lifecycle.
- Implement `MonitorSpec`, source adapters, deterministic transition reducer, acknowledgement cursor, retry/backpressure, and session/run/subject lifetime.
- Persist before delivery through Memory contracts; prove crash recovery, lease fencing, cancellation acknowledgement, child reaping, deadline handling, and terminal cleanup receipts.
- Implement the deterministic EfficiencySupervisor and strict sub-budget.
- Verify that unchanged or duplicate observations consume no model turn and that full diagnostics remain artifacts rather than model context.

## Task 4B — PR 4B: Shepherd, review, merge, and post-merge handoff

**Outcome:** PR orchestration becomes the first vertical consumer of the shared Monitor Engine.

- Move Shepherd, PR-monitor specialization, review, merge, ancestry, thread, and PR-state adapters onto Flow and Memory public seams.
- Preserve one current-head fail-closed verdict and Memory-issued merge authority.
- Replay restart, watcher adoption/reaping, stale head, zero/open threads, optional neutral checks, external/fork heads, bounded feedback discovery, and post-merge handoff.
- Never poll with a model, resolve threads automatically, or merge without the existing authority gate.

## Task 5 — PR 5: facade, harness, and capability negotiation

**Outcome:** the current CLI remains compatible while every installed harness receives truthful delivery behavior.

- Thin the facade, preserve legacy bins/JSON/exit codes, and add `forge capabilities --json`.
- Implement T0 durable pull, T1 next-turn injection, T2 active-session delivery, T3 resume/wake, and T4 human notification adapters.
- Probe the installed Claude, Codex, Cursor, and Hermes versions and executable behavior; never infer support from harness name.
- Use native monitor/channel/message facilities only when their probe passes; otherwise degrade to the next supported tier.

## Task 6 — PR 6: migration, shadow comparison, and extraction readiness

**Outcome:** beta.5 users can upgrade, compare, cut over, restore, and consume independently releasable packages.

- Implement dry-run, backup, additive migration, replay, shadow comparison, cutover, and rollback.
- Prove clean install, beta.5 upgrade, interrupted migration, post-cutover-write handling, sparse package builds, independent publish lanes, and signed BOM verification.
- Keep Kernel/Memory the sole authority writer; shadow mode may dual-read but never dual-write authority.

## Task 7 — PR 7: convergence and release evidence

**Outcome:** the exact RC candidate has frozen contracts, resolved dispositions, complete evidence, and reversible release artifacts.

- Finish issue disposition, supersession links, security/evaluation/release gates, migration/rollback documentation, and obsolete-shadow removal supported by evidence.
- Run the complete exact-BOM matrix once after the final correction SHA is settled.
- Aggregate tri-state journey evidence, verify observation windows and rollback, then prepare metadata-only stable promotion.

## Development start

The next authorized action is Task 0. Production implementation begins only after its admission evidence passes; the first code branch is PR 1, not PR 4A or the Shepherd specialization.
