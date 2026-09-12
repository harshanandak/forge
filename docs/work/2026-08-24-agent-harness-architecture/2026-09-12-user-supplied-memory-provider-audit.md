# User-supplied memory-provider audit

**Captured:** 2026-09-12 from an earlier audit supplied in this planning conversation.

**Original recommendation:** Core-first, optional projections later.

**Authority:** Historical research input and proposed experiment policy. It does not change the accepted [Memory product ownership](../2026-08-09-forge-product-restructure/plan.md) or approve any provider.
**Evidence limit:** The supplied report described primary-source research and tracked `origin/master` inspection as rung 2. It explicitly did not install or benchmark a provider. Product APIs, licenses, repository state, and Forge defects must be refreshed before an experiment or implementation.

## Recommended dispositions

The report read the dictated “graphiphy” as **Graphify**, with 85% confidence, and also checked Graphiti and Microsoft GraphRAG.

| System | Proposed Forge role | Historical disposition |
|---|---|---|
| [Graphify](https://github.com/Graphify-Labs/graphify) | Repository graph for dependency paths, blast radius, and architecture navigation | Best first optional plugin candidate |
| [OpenViking](https://github.com/volcengine/OpenViking) | External context provider and cross-harness reference implementation | Laboratory connector only |
| [Graphiti](https://github.com/getzep/graphiti) | Temporal and relational memory projection | Repair or demote the existing experiment before adding providers |
| [Mem0](https://github.com/mem0ai/mem0) | Personal or conversational memory retrieval experiment | Defer until a concrete requirement exists |
| [GraphRAG](https://github.com/microsoft/graphrag) | One-shot analysis of large, stable document collections | Skip for operational memory |

The stable recommendation was to keep Forge Kernel plus SQLite FTS5 as the authority and default. External systems remain optional, rebuildable projections and must beat Forge's measured baseline.

## Graphify

The report considered Graphify the strongest immediate optional candidate because its local code graph is deterministically extracted with tree-sitter and distinguishes `EXTRACTED`, `INFERRED`, and `AMBIGUOUS` edges.

Proposed Forge surface:

- `codegraph.query`
- `codegraph.path`
- `codegraph.affected`

Every result should carry the exact Git SHA and remain derived evidence. A code-graph benchmark should measure path and affected-file correctness; memory Recall@5 alone is not an adequate Graphify evaluation.

The report separately warned against copying the small `remember`/`compact`/`recall` bundle from [deepedge-ai-tech/graphify](https://github.com/deepedge-ai-tech/graphify), because those verbs duplicate Forge's existing memory surface.

## OpenViking

Mechanisms proposed for adaptation:

- Progressive L0/L1/L2 context loading.
- Separate fast retrieval from deeper session-aware search.
- Observable retrieval trajectories.
- Canonical content with rebuildable indexes.
- Session commits with auditable memory diffs.
- Capability matrices across Codex, OpenCode, Pi, DSH, and other harnesses.

The report also recorded significant boundaries: OpenViking was alpha-stage, operated its own filesystem, vector index, sessions, skills, hooks, server, and authority model, and its main project used AGPL-3.0 at the time inspected. It therefore proposed no core bundling or authority role. A later out-of-process connector could use HTTP or MCP, initially read-only with automatic capture disabled.

The [Agent Plugins package](https://docs.openviking.ai/en/agent-integrations/15-agent-plugins) and historical [cross-harness capability matrix](https://docs.openviking.ai/en/agent-integrations/16-capability-reference) supported a specific lesson: MCP plus a skill may be portable, while automatic recall/capture still depends on host lifecycle support. Recheck documentation and licensing before any experiment.

## Mem0

The report described the inspected OSS design as ADD-only LLM extraction plus semantic, BM25, and entity ranking. It warned that contradictory facts could accumulate, graph memory had moved to the managed platform, and headline results included proprietary optimizations. Its source was the then-current [Mem0 migration guide](https://docs.mem0.ai/migration/oss-v2-to-v3).

These mechanisms were proposed only as benchmark candidates, not authority. If evaluated, use curated Forge records or `infer=false`; otherwise the experiment measures LLM extraction errors and retrieval together. Revisit Mem0 only after a concrete personal-preference or conversational-memory requirement appears.

## Graphiti

The report found Graphiti's temporal model relevant but operationally heavy, with deletion semantics needing runtime proof. It also reported that Forge publicly documented Graphiti while the inspected read path was empty and its emitter incomplete, citing historical local locations `docs/guides/memory-backends.md:15` and `lib/memory/router.js:202`.

That Forge defect claim is historical and must be checked against the current tracked ref. The lasting rule is that any existing experiment should be made honest—implemented, clearly limited, or removed—before another provider is admitted.

Graphiti remains a laboratory candidate for temporal retrieval only when the benchmark identifies temporal failures that FTS5 cannot handle acceptably. Production deletion, restart, rebuild, and provider-failure behavior must be demonstrated first.

## GraphRAG

The proposed use was one-shot analysis of large, stable document collections. It was not recommended for live operational memory because its operating model and cost did not match continuous project authority and session retrieval.

## Proposed architecture

```text
Kernel events and memory rows -- sole truth
                 |
                 v
      ContextSelector + SQLite FTS5
 scope / trust / freshness / supersession / token budget
                 |
                 v
             agent context

Optional projection:
Kernel outbox -> provider index -> candidate Kernel IDs
                                  |
                                  v
                    Kernel rehydrates and re-authorizes
                                  |
                                  v
                        ContextSelector
```

External providers should return Kernel IDs, scores, and evidence references. Forge then rechecks scope, trust, deletion, supersession, and budget. Providers do not inject context directly and do not confirm LLM-generated facts.

The **Forge Memory product contains this Kernel authority**. Individual retrieved memories and provider projections remain non-authoritative inputs.

## Proposed sequence

### 1. Make the existing surface honest

- Remove or correct configuration documented as having no effect.
- Update obsolete storage descriptions to the actual Kernel SQLite and FTS5 model.
- Describe providers as optional enrichment projections, not alternative authority backends.
- Preserve the existing local-first backend behavior. The historical source pointer was `packages/memory/src/backend-registry.js:108`; verify against the current exact ref.

### 2. Finish lifecycle hygiene

- Add or prove logical forget and tombstones, retention, redaction, and verified projection deletion.
- Keep logical deletion distinct from physical secure erasure; SQLite, WAL files, backups, and remote provider copies require stronger verification.
- Keep summaries and extracted facts as proposals with source references, consistent with the accepted design.

### 3. Run a blinded provider benchmark

Compare `FTS5` against `FTS5 + provider`; do not evaluate the provider as a replacement for the local floor.

Hard gates proposed in the supplied report:

- Zero cross-project leakage.
- Zero stale or forbidden injection.
- 100% mapping from returned results to source records.
- Verified deletion after restart and rebuild.
- Unchanged FTS5 results when the provider fails.

Quality admission threshold proposed in the report:

- At least a repeatable five-point overall Recall@5 improvement, **or**
- At least a ten-point improvement on semantic, temporal, or relational cases,
- with no material precision loss.

Use synthetic, privacy-safe source records and score returned source IDs rather than LLM-generated answers. A synthetic win is the regression floor, not user-journey proof.

### 4. Admit candidates narrowly

1. Evaluate Graphify first for code-navigation and blast-radius cases if its dedicated benchmark passes.
2. Evaluate Graphiti for temporal queries and OpenViking for progressive context delivery in laboratory mode.
3. Productionize at most one enrichment provider, and only when it wins a demonstrated need with acceptable operational cost.
4. Revisit Mem0 only for a concrete personal or conversational requirement.

## Deferred and rejected expansion

The report called out the following as architecture or product slop unless later evidence creates a need:

- “Everything is a plugin” as an ontology; plugins are packaging and capabilities describe behavior.
- Separate provider-specific `remember`, `recall`, and `compact` skills; Forge owns those verbs once.
- Direct provider MCP access that bypasses Kernel authorization and evidence receipts.
- Automatic ingestion of raw transcripts, tool output, or issue history.
- Treating summaries, extracted entities, or graph edges as truth.
- Empty adapter methods or synchronous interfaces that pretend remote providers are local.
- No-op configuration retained for a hypothetical future.
- Committed graph or vector artifacts without exact-source and freshness stamps.
- Per-harness implementations of the same policy.
- Provider marketplace, dashboard, automatic provider selection, or vector database before one adapter proves measurable value.
- Auto-invocation collisions. The supplied ordering proposal was user invocation, project pin, package priority, then global fallback; accepted current skill rules must still be checked before implementation.

Marketplace, cloud skill sync, generic provider dashboards, broad automatic provider selection, and vector storage remain deferred until an admitted product need and measured evidence justify them.

## Original options

- **A — Core-first, optional projections later (recommended):** keep Kernel and FTS5 authoritative, finish lifecycle and evidence, then benchmark optional providers.
- **B — Graph-first:** complete Graphiti before lifecycle cleanup.
- **C — External-platform-first:** adopt OpenViking or Mem0 as the memory system.

These options are preserved as historical recommendation context. No provider was selected, installed, or benchmarked by the supplied audit or this archival task.
