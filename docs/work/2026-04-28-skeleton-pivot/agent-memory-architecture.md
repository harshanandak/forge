# Forge Agent Memory Architecture

**Date:** 2026-04-29
**Status:** Design proposal
**Context:** Forge has been framing "memory" as `beads + memories.jsonl` (issue tracking with FTS). This doc argues that framing is too narrow and proposes a structured taxonomy mapped to specific storage backends.

---

## TL;DR

A coding agent does not have one memory — it has at least **six**, each with different write rates, retention rules, and retrieval semantics. Conflating them into "issue tracking with FTS" causes the most common AI failure modes: stale decisions reloaded as truth, accumulated session detritus polluting search, and "skills" that never compound across runs. Forge should ship a typed memory layer with **per-category storage** (event log, KV, FTS, code-as-memory, derived view) and an explicit API surface (`remember`, `recall`, `forget`, `compact`).

---

## 1. Background: what the literature actually says

| System | Core idea | Lesson for Forge |
|---|---|---|
| **MemGPT / Letta** ([arXiv 2310.08560](https://arxiv.org/abs/2310.08560)) | OS-style hierarchical memory: `main context` (in-window) + `recall storage` (chat history) + `archival storage` (KV / vector). Agent moves data between tiers via tool calls. | Memory is *tiered*, not flat. The agent itself decides what to page in. Forge's working set vs. archive distinction maps cleanly here. |
| **Generative Agents** ([Park et al., 2023](https://arxiv.org/abs/2304.03442)) | Append-only **memory stream** of natural-language observations. Retrieval ranks by `recency + importance + relevance`. Periodic **reflection** synthesizes high-level summaries. | Hybrid scoring beats pure semantic similarity. Reflection (LLM-generated summaries of older memory) is a *write* operation, not just a read trick. |
| **Voyager** ([arXiv 2305.16291](https://arxiv.org/abs/2305.16291)) | Ever-growing **skill library** of executable code; new skills retrieved by embedding when curriculum proposes a new task. | Procedural memory should be *executable artifacts*, not prose. Forge skills are already this — but they don't currently accumulate from sessions. |
| **Mem0** | Distinguishes short-term (session) vs. long-term (extracted facts). LLM extracts and dedupes facts on write. | Write-time extraction prevents memory rot. Don't dump raw transcripts; distill. |
| **LlamaIndex `Memory`** | `StaticMemoryBlock` (pinned facts) + `FactExtractionMemoryBlock` + `VectorMemoryBlock`. Composed at retrieval. | Multiple block types compose at the prompt level. No single "memory store." |
| **LangChain (post-deprecation)** | Old `BufferMemory`, `SummaryMemory`, `VectorStoreRetrieverMemory` are deprecated in favor of LangGraph checkpointing — i.e. **state, not memory**. | The industry has converged: short-term = checkpoint, long-term = explicit store. Forge should not blur this. |
| **Anthropic Claude memory** ([blog, 2025-09-11](https://www.anthropic.com/news/memory)) | **Project-scoped** memory, user-editable, incognito mode. | Cross-project contamination is a real failure. Per-project boundary + user inspectability are non-negotiable. |
| **Cognitive science** | Declarative (episodic + semantic) vs. non-declarative (procedural). Working memory is separate. | Map agent storage to these — different access patterns require different stores. |

---

## 2. Memory categories Forge actually needs

Mapping cognitive types to concrete coding-agent artifacts:

| # | Category | Cognitive analog | Concrete examples |
|---|---|---|---|
| 1 | **Decisions** | Semantic | "We chose Bun over npm because Windows perf"; "Stage names are `/validate` not `/check`"; OWASP findings accepted/deferred |
| 2 | **Session episodes** | Episodic | "On 2026-04-28 I ran /dev on feat/skeleton-pivot, hit a Lefthook test-env failure, fixed by X" |
| 3 | **Skills / playbooks** | Procedural | The `greptile-resolve.sh` workflow; "how to handle pre-push test-env fixture failures"; auto-invocation matchers |
| 4 | **Working state** | Working | Current branch, current task list cursor, in-flight subagent results, "we're mid-RED phase on task 3" |
| 5 | **Issue graph** | Relational/semantic | Beads issues + dependencies + blockers + status; reads & writes constantly during /dev |
| 6 | **Audit trail** | Episodic (raw) | Append-only log of every tool call, hook fire, command run — used only for debugging |
| 7 | **Preferences** | Semantic (user-pinned) | "Never run `gh pr merge`"; "Prefix unused params with `_`"; explicit user instructions promoted from CLAUDE.md |

Forge's current `memories.jsonl` collapses **at least 1, 2, 3, 7** into one undifferentiated stream — that's the framing problem.

---

## 3. Read/write patterns per category

| Category | Write rate | Read rate | Lifetime | Retrieval mode |
|---|---|---|---|---|
| Decisions | rare (per /plan) | every stage | forever (until superseded) | symbolic key + FTS |
| Session episodes | high (per turn) | only on resume / debug | rolling 30d, then compact | recency-weighted, time-range |
| Skills | rare (per learning) | auto-invoke matcher | forever | trigger-pattern match |
| Working state | very high | very high | until task complete | direct key lookup |
| Issue graph | high | very high | forever | graph traversal + FTS |
| Audit trail | every tool call | rare (debugging only) | rolling 7d | time-range scan |
| Preferences | rare | every prompt | forever, user-editable | always loaded |

These rates are 3–6 orders of magnitude apart. **One backend cannot serve all of them well.**

---

## 4. Storage backends — one per pattern

| Category | Backend | Rationale |
|---|---|---|
| Decisions | **Markdown files in `docs/plans/`** + SQLite FTS5 index | Already exists. Human-readable, git-tracked, supersedable. |
| Session episodes | **Append-only JSONL** (`.beads/interactions.jsonl`-style) + nightly LLM-reflection compactor → `docs/sessions/<date>.md` | Cheap writes, periodic summarization keeps recall cheap. |
| Skills | **Code on disk** (`.claude/skills/*.md` + `scripts/*.sh`) + trigger index | Voyager's lesson: procedural memory is executable. Already the model — make accumulation explicit. |
| Working state | **JSON checkpoint** (`.forge/state.json`), per-worktree | LangGraph's pattern. Atomic, fast, scoped to worktree. |
| Issue graph | **Beads (Dolt)** | Already in place. Graph + FTS. Don't reinvent. |
| Audit trail | **Append-only JSONL**, rotated weekly, never indexed | Optimize for write; humans grep when needed. |
| Preferences | **Plain markdown** (`CLAUDE.md`, `MEMORY.md`) loaded into every prompt | User must be able to edit by hand. No magic. |

**Vector store?** Skip it for now. FTS5 over markdown plus filename/keyword conventions covers ~90% of coding-agent recall, with zero embedding-model lock-in or staleness issues. Revisit only if recall demonstrably fails.

---

## 5. API surface

```
forge.remember(category, key, value, {ttl, importance})
forge.recall(query, {category?, since?, limit?, mode: "symbolic"|"semantic"|"hybrid"})
forge.forget(category, key)               # explicit removal — privacy critical
forge.compact(category, {strategy})       # reflection / summarization pass
forge.checkpoint(state) / forge.resume()  # working-state shortcut
```

Two key invariants:

1. **`category` is required on writes.** No "throw it in the bag" mode. Forces the agent to think about retention.
2. **`forge.recall` returns provenance** (`{value, source, written_at, written_by}`). Agents must cite, not paraphrase, to prevent hallucinated memories.

---

## 6. Anti-patterns specific to coding agents

1. **Memory-as-context-leak.** Dumping the last N session transcripts into every prompt. Token cost compounds; relevance collapses. Use `recall(query, limit=K)` with hybrid scoring.
2. **Stale-decision reload.** Loading "we chose X" from 2025 when the team migrated to Y in 2026. Decisions need *supersedes/superseded-by* edges, like ADRs. Hallucination here is worse than no memory.
3. **Cross-project contamination.** Anthropic's project-scoped boundary is mandatory. A coding agent that remembers Project A's secrets while working on Project B is a security incident, not a feature.

## 7. Patterns Forge should adopt

1. **Generative-Agents-style retrieval scoring** for episodic recall: `score = α·recency + β·importance + γ·semantic_match`. Importance set by user (`forge remember --pin`) or LLM-judged on write.
2. **Voyager-style skill accumulation.** When /dev solves a recurring problem (e.g. "Lefthook test-env race"), an end-of-session reflection step promotes it to `.claude/skills/` with a trigger pattern. Compounds across sessions.
3. **MemGPT-style tiering.** `working` (always loaded) → `recall` (loaded on query) → `archival` (loaded on explicit `forge.recall`). The agent pages between tiers via tool calls; the user sees and controls the boundaries.

---

## 8. The big open question

**Should Forge memory be agent-private or user-visible-and-editable by default?**

- **Agent-private** (MemGPT, Letta) → richer, denser, evolves freely, but failures (hallucination, drift) are invisible until they ship bad code.
- **User-editable** (Anthropic Claude memory, CLAUDE.md, ADRs) → slower to grow, but every memory is auditable and correctable. Matches Forge's existing "everything is git-tracked markdown" ethos.

Recommendation: **user-editable for categories 1, 3, 7 (decisions, skills, preferences); agent-private but inspectable for 2, 4, 6 (episodes, working state, audit).** Issues (5) are already user-editable via `bd`.

---

## 9. Verdict

> **"Issue tracking + memories.jsonl" is the wrong framing.**

It conflates seven distinct memory types into two flat stores, guarantees retrieval-quality decay as the JSONL grows, and ships none of the patterns the literature has converged on (typed categories, hybrid scoring, reflection compaction, skill accumulation, supersedes edges, project boundaries).

The right framing is a **typed memory layer**: six categories, five backends (most of which Forge already has — `docs/plans`, `.claude/skills`, `.forge/state.json`, Beads, JSONL), plus a thin `forge.remember/recall/forget/compact` API that enforces categorization at write time and provenance at read time.

Practically: Forge does **not** need a new database, embeddings, or vector store. It needs (a) a category dimension on every memory write, (b) a reflection/compaction pass for episodic memory, (c) a skill-promotion pipeline for procedural memory, and (d) project-scoped boundaries borrowed verbatim from Anthropic's design.

That's a **convention + light tooling** problem, not a storage problem — which is exactly the kind of problem Forge is well-positioned to solve.
