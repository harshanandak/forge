# Evaluation: control-plane-first candidate

Verdict: **adopt direction A, but simplify the implementation model**.

## Strong parts to keep

- Forge governs; Agent Companion executes; adapters translate; skills guide; memory informs.
- Capability support must be executable and unavailable when it cannot be enforced.
- Forge must independently re-verify Companion output against current issue, lease, worktree, head, diff, tests, and CI.
- Skill identity needs provenance, content hash, invocation mode, visible collision handling, preview/doctor UX, and atomic projections.
- Handoff is a typed run event, not another store.
- Automatic memory is derived, scoped, expiring, and never authority.
- The old Beads/export contradictions and stale architecture records need explicit reconciliation.

## Changes required

1. **Do not add a parallel schema family.** Map `AuthoritySnapshot`, `EvidenceReceipt`, and `CompletionReceipt` onto existing WorkPacket, LeaseReceipt, RunReceipt, MonitorReceipt, Kernel events, and a durable Kernel run row. Add fields only when a gap test proves they are absent.
2. **Do not restore the stale research worktree as the implementation base.** Preserve its untracked research as evidence, but implement from the refreshed remote in the fresh issue-linked worktree.
3. **Postpone plugin lifecycle.** Current “plugin manager” is a static harness-manifest catalog and the tool catalog is separate. With no second in-process provider, staged/draining/hot-replace machinery is speculative.
4. **Keep skills narrower.** Fix `invocation:user`, preflight, provenance, and collision ownership before adding group management, enable/disable UX, dependency graphs, or an ecosystem manager.
5. **Do not claim append-only memory events are new.** Kernel-backed memory, typed contracts, FTS5, supersession, and recall telemetry already exist. The actual missing work is forget/tombstone, retention, documentation repair, and projection deletion convergence.
6. **Measure before broad control-plane work.** The current status path rescans the full board four times and emits more than 570k JSON characters. Freeze baselines, then land the invocation correctness fix and one-pass status snapshot before the larger run bridge.

## Candidate sequence after correction

1. exact baseline and issue/dependency reconciliation;
2. user-only skill invocation and sync preflight;
3. one-pass Kernel status snapshot;
4. existing run-contract gap closure and durable `prepareRun` authority;
5. one capability registry, Agent Config digest, and one Agent Companion adapter;
6. local memory lifecycle hygiene;
7. optional provider benchmark;
8. plugin lifecycle only when a second real provider proves the need.

This candidate is architecture evidence for the synthesis. It is not a separate roadmap or authority source.
