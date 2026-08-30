# Forge architecture convergence plan v1

Issue: `e4d530eb-104e-4e5e-9280-ff19ac781878`
Parent epic: `44ed41f0-eda8-41a6-93cc-64ac350cc497`
Status: independent review draft

## Outcome

Make Forge faster and easier to reason about by separating three jobs that are currently discussed as one system:

1. **Forge Kernel** owns durable project truth: issues, dependencies, decisions, claims, stages, actor/session/worktree identity, runs, evidence, and terminal policy.
2. **Forge Memory and Knowledge** store or derive selectively recalled context. They never decide authority and never write through an external provider before the Kernel/local store succeeds.
3. **Forge runtime** composes skills, harness adapters, plugins, Agent Config policy, Agent Companion execution, and user-facing workflows around Kernel contracts.

The design adapts useful ideas from DeepSeek Harness/Cordis, Matt Pocock skills, Pstack, Agent Config, Agent Companion, OpenViking, Mem0, Graphiti, and Graphify without copying their host assumptions or adding all of them as production dependencies.

## Non-negotiable boundaries

### Kernel authority

- Keep the existing local SQLite/WAL authority and JSON-first CLI contract.
- Core issue, claim, lease, decision, and run mutations are synchronous local operations. No network, LLM, plugin, graph store, or harness process may sit on this path.
- Every mutation carries actor, session, repository, worktree, expected revision, and idempotency identity where the operation can conflict.
- Background observers and plugins may append evidence or proposals. They cannot close issues, accept decisions, change claims, or silently advance stages.
- A durable `ForgeRun` is a Kernel record and event stream, not a transcript. It contains a DAG of bounded work nodes, exact status, owner, input artifact hashes, output/evidence receipts, retry lineage, cancellation, and next predicate.

### Memory and knowledge

- Keep Kernel/local SQLite plus FTS5 as the default durable floor and prompt-recall fallback.
- Treat verbatim artifacts and accepted Kernel events as truth-bearing sources. Summaries, extracted facts, Graphify output, Context Mode output, and provider memories are derived proposals with provenance.
- Add lifecycle hygiene before enrichment: scoped forget/tombstone, retention, supersession, and projection-deletion convergence.
- Optional retrieval providers return candidate Kernel memory IDs and scores only. Forge rehydrates current rows and reapplies project scope, trust, supersession, deletion, freshness, exclusion, and token-budget filters before context injection.
- External providers are asynchronous, rebuildable projections fed from a Kernel outbox. Provider failure cannot block or change the local result.
- OpenViking, Mem0, Graphiti, and Graphify remain benchmark adapters or offline tools until a blinded evaluation proves a material gain. No provider SDK enters the default install.

### Runtime, skills, and harnesses

- The Kernel exposes contracts; the runtime chooses how a host performs work.
- Keep one canonical skill registry. A skill identity is namespace plus name plus pinned source/version/hash, not a directory basename.
- Compile invocation policy (`model` or `user`) into the registry and resolver. User-only skills cannot be auto-triggered or called by another skill.
- Refuse ambiguous skill collisions by default, show both provenances, and provide an explicit pinned override. Preserve the existing higher-scope precedence only when it resolves to one reviewed identity.
- Load trigger metadata first and skill bodies only after resolution. Load referenced files only when the selected skill needs them.
- Define a small `HarnessAdapter` capability contract around existing execution seams: start, send, observe, cancel, resume if supported, capability snapshot, permission request, and normalized receipt. Unsupported capabilities are explicit results, not skipped tests.
- Keep the certified built-in host set separate from dispatch targets. Claude, Codex, Cursor, and Hermes can remain certified hosts while OpenCode, Pi, and DeepSeek Harness are capability-tested outbound adapters through Agent Companion. This adds compatibility without claiming identical host semantics.
- Agent Config remains canonical operator routing policy. It compiles a versioned policy snapshot. Agent Companion validates the selected route, performs the external execution, and returns receipts. Neither owns project truth.

## Plugin model

Do not make everything a plugin. The Kernel, event schema, authority checks, local memory floor, and CLI envelopes stay core.

Permit four extension slots only where implementations already vary:

1. harness adapter;
2. skill package/source;
3. memory projector/search candidate source;
4. observer/review adapter.

Each manifest declares identity, version, capabilities, required permissions, compatible contract versions, configuration schema, provenance, and entry point. Activation follows discover -> validate -> resolve dependencies -> request permissions -> start -> health receipt. Deactivation reverses registered effects in reverse order. Failed activation leaves the previous active set unchanged. A plugin may not register arbitrary Kernel mutations.

From DeepSeek Harness/Cordis, adopt scoped services, capability lookup, nested composition, lifecycle receipts, and reversible edge effects. Do not replace Forge's Kernel, CLI, or work graph with Cordis context or make every internal function dynamically patchable.

## Selectivity and performance budgets

Measure Kernel, memory, and whole-system paths separately.

### Kernel

- Benchmark service time and CLI wall time independently on cold and warm runs.
- Reuse Forge's existing promotion rule: a candidate may not exceed 1.25 times the exact-baseline p95. Record an absolute service and CLI wall budget only after the fixed corpus exposes the current process-startup and query split; do not optimize SQL when process startup is the bottleneck.
- No optional extension may add work to issue/claim mutation latency. Projection work starts after commit through bounded outbox consumers.
- Batch event and projection writes where ordering permits; keep claim/expected-revision checks in the same transaction as the mutation.

### Memory

- Preserve the existing 1,000-row, 100-sample local recall p95 gate of 250 ms. A provider has a 1.5 second hard deadline and may only enrich; the total prompt hook remains below the existing 4.5 second deadline.
- Retrieval begins only for meaningful queries, uses scope and trust filters before ranking, returns a bounded candidate set, and respects an explicit token ceiling.
- Record local/provider latency, candidates considered, filtered reasons, injected IDs, tokens, timeout/fallback, and provenance without logging raw sensitive content.

### Whole system

- Scheduler dispatches only ready DAG leaves, one owner per artifact, with bounded configured concurrency and event-driven wakeups. More agents are not a success metric; critical-path time and accepted evidence are.
- Skill discovery reads a compact index. No recursive plugin scan or support-file load occurs on every prompt.
- Cache immutable registry/capability snapshots by content hash; invalidate on source, config, executable, or contract-version change.
- `forge status` and handoff output use bounded projections instead of rebuilding every transcript or re-querying every adapter.

## Slop to remove or defer

- Do not add a universal plugin interface over the whole product.
- Do not add OpenViking, Mem0, Graphiti, Graphify, or a vector database to the default runtime.
- Do not let direct memory MCP calls inject prompt context or create authority.
- Do not copy external skill suites into every harness or auto-install unreviewed skills.
- Do not add another workflow engine, task store, event log, model catalog, dashboard, or planner.
- Do not preserve stale command surfaces or generated mirrors as sources of truth.
- Do not build adapters for unsupported capabilities before a concrete certification case exists.
- Do not optimize agent count. Optimize the critical path and evidence quality.

## Delivery sequence

### Phase 0: reconcile truth and measure

- Reconcile current accepted decisions with the stale research plan and current issue graph.
- Add fixed performance/evidence fixtures for Kernel commands, recall selection, registry resolution, and adapter capability snapshots.
- Record current p50/p95, context bytes/tokens, and write counts before code changes.

Gate: reproducible baseline bound to exact commit and environment; no architectural claim rests only on prose.

### Phase 1: durable run and authority envelope

Finish and reconcile the shared contracts under issue `85be2945-ab34-4e3c-abd3-893ee7ea3b4e`. Reuse the existing WorkPacket, RunReceipt, process-lifecycle, memory-contract, Kernel event, and issue-service implementations. Persist the missing run/authority linkage in the Kernel and add a named `AuthorityBundle` or `TerminalPolicy` only where current fields cannot express the invariant. Do not add a second store, receipt schema, or scheduler.

Gate: crash/resume, stale revision, lease loss, cancel, and terminal-policy fixtures reproduce deterministically.

### Phase 2: deterministic skills

Resolve issue `da760874-32c4-4011-99a2-88abe865e667`: compile namespaced identity, provenance, invocation mode, precedence, collision diagnostics, and lazy references into the existing registry/sync path.

Gate: current reviewed projections remain byte-identical except explicit collision/invocation fixtures; user-only invocation is enforced.

### Phase 3: harness execution

Combine the adapter registry (`6f2dbe75-29ea-442e-a175-c7de13aa3c52`), permission semantics (`84c942f3-b7e0-4416-a7d3-11b6c783c0bc`), Agent Config compilation (`ce785690-af5d-4a40-bc95-bc99d0ac9125`), identity (`7b60525b-a1e2-4c94-a6b4-81fa76459a24`), and Agent Companion bridge (`8d14651d-03a6-4727-8204-2a05ad7fb280`) behind one versioned capability/receipt contract.

Gate: identical offline contract fixtures pass for every supported adapter; unsupported cells fail explicitly; retries never duplicate effects.

### Phase 4: memory lifecycle, then optional benchmarks

Implement forget/tombstone, retention, supersession, and projection reconciliation using existing memory contracts and FTS5. Then benchmark local FTS5 versus local plus OpenViking, Mem0, Graphiti, or Graphify candidates. Productionize at most one provider only if hard privacy/deletion gates pass and the paired recall improvement is material.

Gate: zero cross-project or deleted-memory injection; local fallback is identical during provider failure; no raw content in evaluation evidence.

### Phase 5: plugins and scheduling

Only after Phases 1-3 are stable, implement the four-slot lifecycle (`4d831b25-66f5-4aed-b664-49131f7da797`), Kernel-to-plan reconciliation (`732bd0fa-61bb-40ac-801d-de2468507cff`), cross-harness certification (`8d3786a0-6d1d-4df8-8893-a7c5b710b54c`), and measured DAG scheduling. Windows progress/backpressure (`1fc448fa-7b76-4c52-a3c1-86be3bbb9dea`) is a targeted adapter reliability fix, not a new runtime layer.

Gate: activation rollback, restart recovery, bounded concurrency, no lost work, and no authority mutation from observers.

## First implementation slice proposed in v1

Start with Phase 0 only: extend the existing `scripts/benchmark.js` surface with targeted `kernel-core` and `memory-recall` groups plus a base-versus-candidate JSON comparison. Reuse current benchmark profiles, eval-evidence hashing, promotion limits, readiness/concurrency fixtures, and memory holdouts. This is dependency-safe because it adds measurement before behavior, introduces no runtime dependency, and tells later slices whether the cost sits in process startup, Kernel queries, recall selection, or optional-provider fallback. If the current benchmark surface already measures these exact paths and comparisons, skip the slice and take the smallest missing skill-collision diagnostic.

First-slice acceptance: exact SHA/runtime/platform binding; content-hashed artifacts; no result-order, isolation, supersession, or fail-open regression; memory p95 at or below 250 ms; candidate latency at or below 1.25 times baseline; candidate tokens at or below 1.20 times baseline; no new telemetry service or blended score.

## Review loop

Round 1 sends this exact file and `review-rubric.md` independently to the four requested model routes. The integrator records attributed scores and only changes the plan for evidence-backed objections. Round 2 sends the full revised plan to the same routes. A third and final round runs only if the published convergence gate is not met. Missing models remain `INCOMPLETE`; dissent is preserved.

## Falsifiers

- If the current registry already detects and refuses every ambiguous collision with provenance and invocation enforcement, the proposed first slice is unnecessary.
- If measured Kernel latency is dominated by process startup, optimize command/session reuse before SQL indexes or caches.
- If a provider cannot return only stable Kernel IDs, prove scoped deletion, or preserve identical local fallback, it cannot become a memory projection.
- If capability adapters require host-specific policy in the Kernel, the adapter boundary is wrong.
- If two phases need the same new abstraction before either has a second implementation, keep the concrete implementation and defer the abstraction.
