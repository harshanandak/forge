# Forge architecture convergence plan v2

Issue: `e4d530eb-104e-4e5e-9280-ff19ac781878`
Parent epic: `44ed41f0-eda8-41a6-93cc-64ac350cc497`
Tracked base: `origin/master` at `37ffef8202c5d5853613834e2cc1eb6b4d7a0f6d`
Status: round 2 review draft

## Decision

Forge is three systems with one direction of authority:

```text
Forge Kernel authority -> selective Memory/Knowledge read models -> Forge runtime and projections
```

- **Kernel** owns issues, decisions, dependencies, claims, actor/session/worktree identity, stages, runs, accepted evidence, and terminal state.
- **Memory/Knowledge** owns bounded recall over local truth-bearing sources and derived proposals. It cannot grant authority.
- **Forge runtime** owns skills, harness capability translation, Agent Config policy compilation, Agent Companion dispatch, monitoring, and user-facing projections. It consumes Kernel authority and returns receipts.

No optional provider, model, plugin, graph store, or harness process enters a Kernel mutation path.

## Current-state corrections

The redesign will extend what ships instead of adding five parallel abstractions:

- `ForgeRun` means a durable Kernel run row/event stream.
- Run input is the existing WorkPacket plus current LeaseReceipt, optional ContextPacket, CapabilityManifest, and policy digest.
- `AuthorityBundle` is not a new schema unless a gap audit proves the existing packet/lease fields cannot carry actor, session, worktree, claim, lease epoch, issue revision, head, allowed mutations, capability digest, and policy digest.
- `EvidenceReceipt` means the existing RunReceipt/MonitorReceipt evidence references and exact hashes.
- `DecisionEvent` is a Kernel event.
- `TerminalPolicy` is the existing allowed/prohibited mutation policy plus the transition rules below, not another policy language.
- Reuse MonitorRuntime durability and backpressure. Connect it to external execution instead of building another bounded loop.

The existing `@forge/memory` facade currently mixes knowledge and authority helpers. New work follows the boundary above; compatibility shims can remain until callers move.

## Authority and terminal transitions

A mutating external run must have exact actor, session, repository, worktree, issue/revision, claim ID, live lease epoch, packet hash, head SHA, adapter ID, capability digest, policy/config digest, attempt ID, and idempotency key before dispatch.

| Transition | Required proof | Failure result |
| --- | --- | --- |
| requested -> prepared | current issue revision, owned live lease, exact head, allowed mutation, compatible capability and policy digests | `NOT_EXECUTED` |
| prepared -> running | adapter start acknowledgement bound to run and attempt | `INCOMPLETE` |
| running -> pass | terminal receipt matches packet, attempt, head, lease epoch and policy; every required evidence reference validates | `INCOMPLETE` |
| running -> cancel_requested | operator or policy cancellation event | remains non-terminal |
| cancel_requested -> cancelled | provider acknowledgement plus process and lease cleanup proof | `INCOMPLETE` |
| any active -> incomplete | timeout, lost lease, ambiguous mutation, crash without terminal proof, unsupported policy, or invalid receipt | `INCOMPLETE` |

An ambiguous mutation is never retried automatically. Delivery and rebuildable projections may retry with stable event IDs. Observer output is stored as `observer-proposal`; it cannot satisfy a terminal gate until an authorized actor accepts evidence bound to the current run subject.

## Memory selectivity and optional providers

Local Kernel SQLite plus FTS5 remains the default floor. The current 400-token automatic injection cap and 4.5-second prompt hook deadline stay in force.

Filter order is fixed:

1. reject empty, single-fragment, or unsupported anaphoric queries using the current meaningful-token guard;
2. project/repository/privacy scope;
3. tombstone or forgotten state;
4. supersession/current validity;
5. trust, consent, and disclosure class;
6. freshness/staleness policy;
7. score floor and deterministic rank;
8. already-seen/excluded IDs;
9. token packing and final provenance fencing.

External systems return candidate live Kernel memory IDs and scores only. Forge rehydrates and re-runs every filter. A dangling, foreign, deleted, superseded, untrusted, or over-budget candidate is rejected. Provider failure returns the identical local result.

Before any provider is production-eligible, add scoped forget/tombstone, retention, and projection-deletion convergence. OpenViking, Mem0, Graphiti, and Graphify stay offline benchmark adapters. The current public Graphiti pseudo-backend is deprecated and removed if no approved pilot owns it within one release.

Provider admission requires all of:

- zero cross-scope, forbidden, deleted, superseded, or sensitive injection;
- 100% hit-to-live-Kernel-ID provenance;
- zero deletion residual, collateral deletion, or resurrection after restart/rebuild;
- provider failure leaves local results unchanged;
- paired 95% lower bound of Recall@5 improvement at least 5 percentage points overall or 10 points on semantic/temporal/relational cases;
- Precision@5 lower bound no worse than 2 points below local;
- warm provider search p95 at or below 1 second and a hard 1.5-second provider deadline;
- top-five Jaccard at least 0.90 across three rebuilds and macro Recall@5 variance at most 2 points;
- a cost ceiling declared before the run and no raw content in evidence artifacts.

Any missing usage, deletion, privacy, or completion evidence is `INCOMPLETE`, never a pass.

## Skills, harnesses, and plugin scope

### Skills

- One resolver produces the effective skill set used by setup, sync, routing, and evaluation.
- Identity is namespace + name + pinned source/version/content hash.
- Allowed invocation values are exactly `model` and `user`. User-only skills are excluded from automatic routing and from skill-to-skill calls.
- Preflight the complete resolved set before writing. Invalid metadata or a collision leaves every target untouched.
- Refuse duplicate names by default and show both provenances. An explicit pinned alias/override is the only exception.
- Never overwrite, mix, or delete an unowned skill directory.
- Load compact trigger metadata first, the selected SKILL body second, and references only when needed.

### Harnesses

Unify the runtime graph, static capability matrix, executable probes, setup targets, and CapabilityManifest from one versioned registry. Cache by executable identity, version, config revision, manifest hash, and expiry. Probe during setup, doctor, or certification, not every prompt.

Certified hosts and outbound execution targets are separate. Existing hosts keep compatibility. OpenCode, Pi, and DeepSeek Harness begin as quarantined outbound adapters and must pass the same contract tests before any broader support claim.

The minimum execution adapter is `probe`, `start`, `observe`, `cancel`, `resume`, and `dispose`. Unsupported capability or unenforceable permissions return `NOT_EXECUTED/UNSUPPORTED_POLICY` before model execution.

### Plugins

Reserve “plugin” for an installable capability bundle containing reviewed skills, manifests, adapters, hooks, or apps. The current static `plugin-manager` is a harness manifest registry; `plugin-catalog` is a tool catalog. Rename the architecture concepts before adding lifecycle behavior.

Do not build the proposed seven-state reactive plugin runtime now. There is no second in-process provider that justifies hot replacement, draining, cycle handling, or generic disposers. Current installs remain static, pinned, provenance-checked, explicitly enabled bundles. Revisit reversible activation only when a real second provider needs it.

## Speed and operator visibility

### Kernel

- Preserve WAL, CAS/revision checks, leases, event append, outbox, check-after-write, and atomic stage transitions.
- Reuse current benchmark/eval artifact formats. Candidate p95 may not exceed 1.25 times its exact baseline.
- Compute a status snapshot from one board readiness load rather than rebuilding the full 1,418-issue board four times.
- Push list limits and scoped `show` readiness into SQL/read-model boundaries only after the one-pass snapshot lands and measurements justify the next change.
- Do not add cross-command correctness caches.

### Memory

- Preserve the existing 1,000-row, 100-sample local recall p95 gate of 250 ms and 400-token cap.
- Record candidates considered, rejection reasons, injected IDs, local/provider time, timeout/fallback, and token count without raw sensitive text.
- Never put network retrieval on claims, status correctness, issue mutations, or run preparation.

### Whole Forge

- Schedule only ready DAG leaves, one owner per artifact, with bounded configured concurrency and event-driven wakeups.
- Emit state changes and actionable deltas; suppress duplicate observations.
- Use bounded orient/recap projections for agent context. Preserve full `status --json` compatibility until a versioned bounded mode is added.
- Every external-run receipt shows route/provider/model, selected policy and capability digests, permission set, rejected candidates/reason, authority/probe/dispatch/first-event/receipt timings, input/output/reasoning tokens, reported cost, and terminal reason.

## Delivery units and issue consolidation

The current 12-child redesign is reduced to six units with real Kernel dependency edges:

1. **Measure and reconcile**: baseline artifacts, current-decision cleanup, dependency graph, and no behavior change.
2. **Identity and local correctness**: actor/session/worktree repair (`7b60525b-a1e2-4c94-a6b4-81fa76459a24`), Companion Windows backpressure (`1fc448fa-7b76-4c52-a3c1-86be3bbb9dea`), memory hygiene, and user-only skill invocation enforcement (`da760874-32c4-4011-99a2-88abe865e667`).
3. **Existing contract gap closure**: rewrite `85be2945-ab34-4e3c-abd3-893ee7ea3b4e` to connect existing packet/lease/receipt contracts to durable Kernel run identity.
4. **One capability and policy path**: merge adapter registry `6f2dbe75-29ea-442e-a175-c7de13aa3c52`, permission semantics `84c942f3-b7e0-4416-a7d3-11b6c783c0bc`, certification `8d3786a0-6d1d-4df8-8893-a7c5b710b54c`, and existing PR5 capability owner into one conformance unit; keep Agent Config snapshot `ce785690-af5d-4a40-bc95-bc99d0ac9125` narrow and hashed.
5. **Agent Companion bridge**: `8d14651d-03a6-4727-8204-2a05ad7fb280` is the only first execution adapter and reuses monitor durability.
6. **Stable projections and optional experiments**: merge Kernel-plan reconciliation `732bd0fa-61bb-40ac-801d-de2468507cff` into the existing runtime-contract/projection-drift owner. Benchmark at most one external memory projection after lifecycle and corpus gates pass.

Postpone plugin lifecycle `4d831b25-66f5-4aed-b664-49131f7da797`. Historical plan files remain historical; current projections report drift rather than rewriting history.

## Executable sequence and rollback

### Slice 0: measurements

Add `kernel-core` and `memory-recall` groups to the existing benchmark runner plus base-versus-candidate JSON comparison. Bind artifacts to SHA/runtime/platform and content hashes. No blended score, daemon, dependency, or production telemetry.

Rollback: revert the benchmark-only commit; runtime is unchanged.

### Slice 1: skill invocation integrity

Retain and validate `invocation` in the current routing catalog, exclude user-only skills from automatic selection, and preflight sync metadata before any write. Collision ownership is a follow-up within the same issue, not part of this first patch.

Rollback: revert the resolver/sync commit; generated outputs are unchanged because preflight precedes writes.

### Slice 2: one-pass status snapshot

Add one internal `status.snapshot` read using a single existing `loadBoardReadiness()` result and preserve current ready/blocked/stale/list ordering and randomization. Test one Kernel operation/board load, not wall-clock timing.

Rollback: revert the internal operation; no schema or external contract changes.

### Slice 3: prepareRun authority

Persist durable run identity, compose existing packet/lease/context/capability contracts, and fail closed before dispatch. Keep current merge/execution callers until conformance passes.

Rollback: disable the new dispatch entry and revert its Kernel projection migration; existing paths remain authoritative. Projection migration must have a tested down/ignore path before release.

### Slice 4: capability/policy and Agent Companion

Generate one capability manifest, compile Agent Config to a hashed policy snapshot, enforce permissions before start, and connect one Agent Companion adapter to existing monitor durability.

Rollback: disable the adapter bundle and return `NOT_EXECUTED`; no Kernel truth or worktree data is deleted.

### Slice 5: memory lifecycle and one benchmark adapter

Ship local forget/tombstone and retention first. Only then implement one black-box provider benchmark. Production remains disabled until every admission gate passes.

Rollback: disable and rebuild/drop the external projection; local Kernel memory remains intact.

## Acceptance and falsifiers

- Existing reviewed harness/skill projections stay byte-identical except explicit invocation/collision migrations.
- No user-only skill is automatically selected.
- Status results and ordering remain exact with one board load.
- No run starts with missing/stale identity, lease, head, capability, or policy fields.
- No observer or external memory result mutates authority.
- No optional service changes local command correctness or availability.
- If process startup dominates after Slice 0, optimize session/process reuse before SQL.
- If current contracts already express a proposed new field safely, do not add another type.
- If no provider clears the frozen admission gates, ship none.
- If a plugin requirement has only one implementation, keep the concrete implementation.

## Round 2 gate

Send this exact file and `review-rubric.md` to every requested route again. Convergence still requires every completed reviewer at 90 or above, score spread at most 5, no blockers, and no new critical finding. DeepSeek V4 Pro remains `INCOMPLETE` unless it appears in the live catalog; no substitute receives its score.
