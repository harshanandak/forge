# User-supplied architecture audit: authority, skills, adapters, and plugins

**Captured:** 2026-09-12 from an earlier audit supplied in this planning conversation.

**Original recommendation:** Option A, control-plane first.

**Authority:** Historical research input. It is not a new decision event and does not override the accepted [product restructure plan](../2026-08-09-forge-product-restructure/plan.md) or its [decision register](../2026-08-09-forge-product-restructure/decision-register.md).
**Evidence limit:** The supplied audit described live Kernel/worktree inspection, tracked-source findings, and primary-source public research at the time it was produced. This archive did not independently rerun those checks. Treat code defects, issue status, branch distance, star counts, local project state, and installed harness behavior as historical until refreshed. No private session payload is reproduced here.

## Recommendation and boundary

The audit recommended repairing the existing architecture epic, then implementing authority and receipt contracts, skills, adapters, Companion integration, and plugin lifecycle. It rejected leading with plugins while authority drift remained unresolved.

Its proposed ownership model was:

```text
Agent Config      operator routing, privacy, reachability
.forge/config     project policy, gates, desired providers
Forge Kernel      work, run, lease, gate, revision, evidence authority
Agent Companion   downstream execution, cancellation, traces, receipts
Harness adapters  Codex/OpenCode/Pi/DSH capability translation
Skills            thin human/model playbooks and triggers
Plugins           versioned packaging for replaceable capabilities
Memory            provenance-backed knowledge, never authority by itself
```

The accepted product design resolves the last line precisely: the **Forge Memory product contains the Kernel and therefore contains authority services; recalled content, summaries, extracted facts, and graph edges do not themselves confer authority**. Forge governs; Companion executes; adapters translate; skills explain procedures; plugins package replaceable capabilities; recalled knowledge informs decisions that the Kernel still evaluates.

## Cordis and DeepSeek Harness mechanisms

The supplied report read the dictated name “Coddisk” as **Cordis**, with high confidence. It linked the [Cordis paper](https://arxiv.org/abs/2608.25512) and [DeepSeek Harness architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md).

Mechanisms proposed for adaptation:

- Typed `provides` and `requires` capability seams.
- Owner-bound registrations with explicit disposal.
- Transactional activation that publishes only after setup succeeds.
- Reactive dependency availability instead of startup-order assumptions.
- Deterministic profile overlays with provenance and last-good rollback.
- Separate host, repository, run, and worker scopes.
- Durable facts separated from live progress and interception events.
- Bounded draining, cancellation, replacement, and cleanup.
- Explicit effect classes: reversible, compensatable, or irreversible.

The audit proposed keeping Cordis optional rather than making it a Forge dependency. Its own model does not sandbox hostile plugins or reverse external effects such as pushes, remote writes, or deployments. Those still require permissions, idempotency, compensation, and receipts. See the historical [DeepSeek safety notice](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md); recheck current upstream state before adoption.

## Proposed minimum durable model

The audit proposed a small authority model:

```text
WorkItem -> Run -> Attempt
             |-> ordered Event
             |-> EvidenceRef
             `-> immutable PolicyCapabilitySnapshot
```

Proposed wire envelopes around that model:

- `AuthoritySnapshot`: issue revision, lease, actor/session, worktree, repository, base/head, PR, policy revision, and capture time.
- `WorkPacket`: objective, acceptance criteria, exact cwd/head, permitted roots and mutations, required capabilities, prohibitions, deadline, and idempotency key.
- `EvidenceReceipt`: packet and authority hashes, executor identity, artifacts, validation, cleanup, and `PASS | FAIL | INCOMPLETE`.
- `CompletionReceipt`: fresh verification of every requested sub-object. Pending, unknown, timed-out, or unverified items prevent `complete`.
- `SkillManifest` and `AdapterManifest`: package descriptors, not additional authority stores.
- Handoff: a typed Run event containing checkpoint, evidence references, blocker, continuation constraints, and next action.

This was intended to address stale authority, prose-only handoffs, partial validation rounded up to success, and duplicated state across issues, worktrees, branches, PRs, CI, and agent jobs. Reuse current accepted contracts and schemas before adding any new form.

## Skills findings and proposed product

The supplied historical audit reported:

- `invocation: user` was parsed and dropped from router catalog entries in `lib/using-forge.js`.
- Discovery precedence differed between synchronization, routing, and evaluation.
- Scalar `next` and `terminal` metadata could not express call, return, branch, checkpoint, or human-gate behavior.
- Linked worktrees could be mishandled when sync expected `.git` to be a directory.
- `SkillRuntime` could throw on malformed non-iterable capabilities rather than return `INCOMPLETE`.
- Same-name sources could silently differ; its earlier sample found 25 differing hashes.

These are historical defect claims. Verify them against the current tracked ref before filing or implementing a fix.

The minimum skill product it proposed included:

- Qualified identity, source, version or commit, hash, physical path, scope, and invocation mode.
- `manual-only` and `auto-eligible` behavior, without claiming unsupported model-only enforcement.
- Same-hash deduplication and visible different-hash conflicts.
- Explicit preference rather than load-order selection.
- `forge skill preview "<intent>"` for routing explanations.
- `forge skill doctor` for provenance, collisions, dependencies, compatibility, and projection drift.
- `enable|disable <skill|@group> --scope repo|machine --harness ...`.
- Initially bounded `skill test` coverage: schemas, trigger fixtures, dependency graphs, and temporary rendering.
- One canonical source projected atomically to each harness.

Its disposition of Matt Pocock and PStack ideas was selective:

- Core candidates: blast-radius predicates, evidence receipts or show-work, and durable handoff.
- Model-invoked candidates: bug diagnosis and a small prose-quality rule.
- User-invoked candidates: grilling, arena, full blast-radius audit, and plain-language retry.
- Optional plugin candidates: Wizard and Arena, because they add executable behavior or multi-provider evaluation.
- Rejected as defaults: another meta-router, mandatory relentless interviews, Cursor-specific model/tool assumptions, generated scripts as trusted authority, and a second TSV or Markdown decision store.

The historical report cited [Matt Pocock's skills](https://github.com/mattpocock/skills), its [skill mechanics](https://github.com/mattpocock/skills/blob/main/skills/productivity/writing-for-agents/SKILL-MECHANICS.md), and Cursor's canonical [PStack plugin](https://github.com/cursor/plugins/tree/main/pstack). Popularity was treated as discovery evidence, not proof that every skill belongs in Forge.

## Proposed harness ABI

The audit reported partial and inconsistent harness surfaces: detection and capability probing centered on Claude, Codex, Cursor, and Hermes; the runtime graph named only Claude, Codex, and Cursor; and OpenCode, Pi, and DSH lacked one canonical adapter manifest, renderer, lifecycle contract, and certification row. It also reported that existing probes were not connected to setup/runtime authority and that native host capabilities differed materially.

Its proposed adapter ABI was:

```text
probe()                       -> CapabilitySnapshot
start(JobEnvelope)            -> AttemptId
events(AttemptId, cursor)      -> ordered AttemptEvent[]
message/reroute/resume(...)    -> typed supported-or-unavailable result
cancel(AttemptId)             -> CancellationResult
finalize(AttemptId)           -> EvidenceReceipt
```

Unknown or unenforceable capabilities remain unavailable. Prompt text that asks for read-only behavior is not a permission boundary.

## Agent Companion and Agent Config

The supplied report observed useful Companion mechanisms: request IDs, context digests, leases, heartbeats, append-only traces, cancellation, stale recovery, bounded progress, and normalized receipts. It cited local historical inspections of `agent-companion/docs/architecture.md` and `docs/adapter-contract.md`; those local files are not copied into this archive.

It also recorded caveats:

- Evidence arrays were largely model-supplied strings without independent provenance.
- `completed` did not prove current Forge issue, worktree, head, or CI authority.
- Adapter capabilities were declared policy more than negotiated runtime facts.
- DSH was one-shot, while Pi and OpenCode had different control and resume semantics.
- The local Companion checkout was dirty, had no remote baseline, and one semantic-progress test failed during that audit.

Those local-state claims are historical. The enduring recommendation was to keep Companion downstream: Forge creates the WorkPacket, verifies ownership, imports the receipt, and independently proves diff, tests, head, and CI.

Agent Config was assigned machine/user routing, privacy, provider reachability, and model-selection weights. Forge records the resolved run decision rather than copying mutable policy into Kernel authority.

## Memory principles from the architecture audit

The report linked two Theo videos as context: [“So I tried Matt’s skills...”](https://www.youtube.com/watch?v=0oXOOlqVu5M) and [“Turn off Claude Code’s Memory”](https://www.youtube.com/watch?v=Jf54k7tFeEc). Its combined lesson was:

1. Encode invariants in architecture, types, tests, lint, or CI.
2. Use reviewed skills for procedural behavior that cannot be encoded.
3. Keep task state in bounded issues, handoffs, worktrees, or decision artifacts.
4. Treat automatic memory as derived, scoped, expiring material.

It proposed retaining FTS5 and adding provenance before embeddings:

- Append-only `memory.*` Kernel events.
- Projection rows with authority, source kind/reference, content hash, session, and project.
- Summaries stored as proposals with source references.
- Explicit supersession, compaction, forget, and redaction.
- Opt-in, read-only, allowlisted, project-bound private connectors.

## Historical issue map and delivery waves

The report said to resume the existing architecture epic (`44ed41f0-eda8-41a6-93cc-64ac350cc497`) and its research child (`f831f7c5-7e48-4a77-b327-a0c572828b8b`) rather than create another architecture umbrella. This archive is a docs-preservation child under that same epic.

Its delivery map was:

| Wave | Historical issue lanes | Proposed result |
|---|---|---|
| 0 | Architecture research and epic (`f831f7c5-7e48-4a77-b327-a0c572828b8b`, `44ed41f0-eda8-41a6-93cc-64ac350cc497`) | Preserve/reconcile the research worktree, restore proven ownership, finalize artifact, dependencies, and stage exit |
| 1 | Authority contracts, actor identity, plan reconciliation (`85be2945-ab34-4e3c-abd3-893ee7ea3b4e`, `7b60525b-a1e2-4c94-a6b4-81fa76459a24`, `732bd0fa-61bb-40ac-801d-de2468507cff`) | WorkItem/Run/Attempt, fresh authority snapshot, tri-state evidence and completion receipts |
| 2 | Skill collision registry (`da760874-32c4-4011-99a2-88abe865e667`) | Provenance, invocation preservation, deterministic precedence, preview/doctor, atomic projections |
| 3 | Harness registry, permissions, certification (`6f2dbe75-29ea-442e-a175-c7de13aa3c52`, `84c942f3-b7e0-4416-a7d3-11b6c783c0bc`, `8d3786a0-6d1d-4df8-8893-a7c5b710b54c`) | Generic adapter ABI plus OpenCode, Pi, and DSH conformance fixtures |
| 4 | Companion, Agent Config, Windows backpressure (`8d14651d-03a6-4727-8204-2a05ad7fb280`, `ce785690-af5d-4a40-bc95-bc99d0ac9125`, `1fc448fa-7b76-4c52-a3c1-86be3bbb9dea`) | Forge-governed WorkPacket bridge, policy snapshot, cancellation/resume receipts |
| 5 | Plugin lifecycle (`4d831b25-66f5-4aed-b664-49131f7da797`) | First-party pinned manifests, owned lifecycle, transactional replacement, no marketplace |
| 6 | Memory, UX, evaluation | Provenance-first memory, CLI skill management, and a bounded promotion corpus |

This wave order is an archived recommendation. The later [future synthesis](2026-09-12-forge-future-synthesis.md) refines it: shared contract proof comes first, independent Memory and Flow usability can then proceed in parallel, and thin adapter probes start early so portability informs the contracts.

The audit identified one separate high-priority conflict: D45 said Beads was migration-import-only while tracked code/reference docs still exposed Kernel-to-Beads export and `.beads` authority surfaces. Verify the current conflict before acting; accepted D45 remains the disposition source.

## Proposed plugin MVP

The audit explicitly deferred a marketplace. Its proposed minimum used four records and five operations:

- Records: untrusted author manifest, host-generated resolution lock, policy grant, and runtime record.
- Operations: `discover`, `resolve`, `activate`, `invoke`, and `replace`.
- Lifecycle: `discovered -> resolved -> staged -> active -> draining -> stopped|failed`.
- First-party pinned plugins only.
- Separate process for executable providers.
- Explicit permission grants bound to the plugin digest.
- Exact-digest rollback and bounded draining.
- No sandboxing claim where the platform cannot enforce it.

The supplied audit referenced a completed public Parallel report, now preserved once as [the public source report](sources/2026-08-30-parallel-public-agent-harness-research.md). It stated that no private repository or session content was sent to that run.

Deferred items were marketplace, cloud skill sync, a generic event bus, vector-memory default, cross-harness phase hopping, and Cordis as a required dependency. The proposed admission condition was at least two materially different adapters passing the same conformance suite.

## Original options

- **A — Control-plane first (recommended in the supplied report):** repair the architecture epic, then authority and receipt contracts, skills, adapters, Companion integration, and plugin lifecycle.
- **B — Skills first:** ship collision diagnostics and skill management sooner while orchestration remains prompt-driven.
- **C — Plugins first:** build the extension kernel before authority drift is repaired.

These options are retained for provenance. Current work follows the accepted restructure plan and uses this audit to explain capability work, not to establish another release ladder.
