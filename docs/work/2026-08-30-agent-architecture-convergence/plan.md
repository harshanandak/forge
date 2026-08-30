# Forge architecture convergence plan

Issue: `e4d530eb-104e-4e5e-9280-ff19ac781878`
Parent: `44ed41f0-eda8-41a6-93cc-64ac350cc497`
Base: `origin/master` `37ffef8202c5d5853613834e2cc1eb6b4d7a0f6d`

## Final direction

Forge is the governor, not a universal harness:

```text
Agent Config -> versioned operator policy
Forge Kernel -> issue, lease, run, revision, evidence, terminal authority
Forge Memory/Knowledge -> bounded local recall and rebuildable proposals
Agent Companion -> one downstream execution adapter
OpenCode/Pi/DSH -> dispatch targets behind Companion
Skills -> provenance-bearing manual or auto-eligible procedures
Plugins -> static pinned capability bundles until a real second provider proves lifecycle need
```

Kernel commands remain local and deterministic. Memory and optional providers never grant authority. External execution starts only from a current WorkPacket + LeaseReceipt + CapabilityManifest + policy digest and returns existing receipt types for independent Kernel verification.

## Decisions

- Reuse WorkPacket, LeaseReceipt, ContextPacket, CapabilityManifest, RunReceipt, MonitorReceipt, MonitorRuntime, Kernel events, benchmark helpers, and eval evidence. Add no parallel `AuthorityBundle`, `EvidenceReceipt`, or workflow engine.
- `completed` is a derived Kernel terminal state. Receipt verdicts are `PASS | FAIL | INCOMPLETE`. Every named acceptance sub-object must be freshly verified.
- Permission is the default-deny intersection of operator policy, project policy, adapter capabilities, and the WorkPacket request. Kernel authority itself is never delegated.
- Skill metadata stays `invocation:user|model`; `user` is manual-only and cannot be auto-selected or invoked by another skill.
- FTS5 stays the memory floor. Implement forget/tombstone and retention before any external projection. OpenViking, Mem0, Graphiti, and Graphify remain benchmarks/offline tools unless frozen gates pass.
- Postpone the seven-state plugin lifecycle. Current plugin surfaces are static harness manifests and a separate tool catalog.
- Preserve full `status --json` compatibility, but compute one Kernel board snapshot instead of four and use bounded orient/recap for automatic context.

Full architecture, permission matrix, terminal transition table, corpus design, rollbacks, and issue consolidation are in `plan-v2.md` and `plan-v3.md`. `reviews-round1.md` through `reviews-round3.md` preserve independent scores and dissent.

## Final sequence

1. **Measure:** add focused Kernel/memory benchmark groups, frozen corpus/evidence metadata, deterministic base-versus-candidate comparison, and repair issue dependencies.
2. **Local correctness:** actor/session/worktree identity, user-only skill invocation and sync preflight, Companion Windows backpressure, memory hygiene.
3. **Kernel speed:** one-pass status snapshot; then measure before scoped list/show changes.
4. **Run authority:** field-coverage audit, injected-clock transition fixtures, durable `prepareRun`, and explicit legacy-caller cutover.
5. **Execution:** permission conformance, one capability registry, hashed Agent Config snapshot, one Companion adapter with OpenCode/Pi/DSH targets.
6. **Memory lifecycle:** forget/retention and Graphiti pseudo-backend disposition.
7. **Optional experiments:** at most one external memory projection benchmark and stable plan/status projections.

## Immediate implementation: Slice 0 only

Extend the existing benchmark runner rather than creating observability infrastructure:

- add targeted `kernel-core` and `memory-recall` benchmark groups that use existing correctness/holdout test files;
- make benchmark results carry exact base SHA, runtime/platform identity, command arguments, group samples/medians, and a deterministic content hash;
- use at least 3 warmups and 30 recorded samples, reporting nearest-rank p95, min/max, median, and coefficient of variation from the raw samples;
- add an explicit base-versus-candidate comparison using the existing promotion caps: candidate latency at most 1.25 times baseline and candidate tokens at most 1.20 times baseline;
- keep correctness tests deterministic; no CI pass/fail depends on wall-clock speed;
- add no dependency, daemon, cache, provider, or runtime behavior.

Rollback is one commit revert. Slice 0 does not change product authority or runtime behavior.

## Acceptance

- Focused tests show RED before implementation and GREEN after.
- Existing benchmark output remains backward compatible unless a versioned schema field is added.
- Comparison rejects mismatched corpus/config/runtime identities instead of comparing unrelated runs.
- Result hashes are stable for equivalent normalized content and change when evidence-bearing content changes.
- Derived timing summaries are reconciled from raw samples; forged summaries are rejected.
- No generated artifact, benchmark output, or temporary profile is committed.
- Issue dependency changes are verified live after write.

## Ambiguity policy

Reuse the existing benchmark/evidence helpers and schemas. A new abstraction, dependency, persistent store, CLI command, or production metric is out of scope. If exact identity fields cannot be added compatibly, record the gap and stop that sub-part rather than widening Slice 0.
