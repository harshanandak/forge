# MemPalace Research Notes For Forge Roadmap

Source repository: <https://github.com/mempalace/mempalace>

Local inspection path used during planning: `/tmp/mempalace`.

## Inspected files

- `README.md`
- `ROADMAP.md`
- `benchmarks/BENCHMARKS.md`
- `website/concepts/memory-stack.md`
- `website/concepts/the-palace.md`
- `website/concepts/knowledge-graph.md`
- `website/concepts/contradiction-detection.md`
- `mempalace/backends/base.py`
- `mempalace/backends/chroma.py`
- `mempalace/backends/sqlite_exact.py`
- `mempalace/searcher.py`
- `mempalace/knowledge_graph.py`
- `mempalace/layers.py`
- `mempalace/palace.py`
- `mempalace/sources/base.py`

## Decisions that matter for Forge

1. **Verbatim storage first.** MemPalace argues that storing original text and retrieving it can beat extraction-heavy systems because extraction discards context.
2. **Layered context budget.** L0/L1/L2/L3 separates always-loaded context, bounded orientation, scoped recall, and deep search.
3. **Scope metadata.** Wings/rooms/halls are valuable because humans and agents can predictably limit search.
4. **Hybrid retrieval.** Vector search plus BM25/keyword signals improves exact-term recall.
5. **Optional reranking.** LLM reranking can help but should be optional and cost-aware.
6. **Temporal graph facts.** Entities/triples carry validity windows and source links, supporting stale-fact detection.
7. **Backend abstraction.** Storage backends have a narrow contract, typed results, health, capabilities, and conformance expectations.
8. **Concurrency hardening.** Per-palace locks, WAL, non-blocking failures, re-entrant guards, and diagnostics exist because multi-agent writes corrupt indexes otherwise.
9. **Source adapter contract.** Ingest sources declare schemas and produce drawer records with flat metadata; nested facts move to graph/read models.
10. **Security/local-first posture.** Data stays local unless explicitly configured otherwise.

## Forge interpretation

Forge should not copy MemPalace as a product. Forge should borrow the durable design lessons:

- Keep source artifacts verbatim.
- Make extracted knowledge provenance-backed.
- Separate authority from read models.
- Keep local and team authority modes separate.
- Add conformance tests before swapping storage backends.
- Provide bounded orientation for agents instead of flooding prompts.
