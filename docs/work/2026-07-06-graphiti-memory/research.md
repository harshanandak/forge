# Graphiti as the Engine for Forge Recall/Memory — Research + Design

**Date:** 2026-07-06
**Status:** Research + design only (no implementation, no PR)
**Author:** research subagent (for `main`)

> **TL;DR** — Graphiti (getzep/graphiti) is a **Python** framework that turns a
> stream of "episodes" (text/JSON/messages) into a **bi-temporal knowledge
> graph** stored in a graph DB (Neo4j / FalkorDB / Kuzu / Neptune), using an
> **LLM + embedder** to extract entities and relationships. It is genuinely
> better than flat JSONL/vector RAG for *evolving* facts. But it is **not
> local-first the way Forge is**: the cheap default still wants an LLM API key
> (OpenAI) and a running graph DB. The clean integration is **not to
> reimplement it in Node** — it's to have Forge *optionally* wire Graphiti's
> **MCP server** into each agent's `.mcp.json` (the "usable in any agent" win),
> and mirror `forge remember`/`forge recall` onto its `add_memory`/`search_*`
> tools when configured. Recommend **post-0.1.0, opt-in**.

---

## Part 1 — How Graphiti actually works (primary sources)

### 1.1 What it is / the problem it solves

Graphiti is "a framework for building and querying **temporal context graphs**
for AI agents." Unlike static knowledge graphs, it tracks **how facts change
over time**, keeps **provenance** back to source data, and supports both
prescribed and learned ontology. Unlike flat RAG / vector memory, it
"continuously integrates user interactions, structured and unstructured
enterprise data … into a coherent, queryable graph" and supports **incremental
updates and precise historical queries without full graph recomputation."
(Sources: [README](https://github.com/getzep/graphiti),
[Zep docs overview](https://help.getzep.com/graphiti/getting-started/overview),
[arXiv 2501.13956 — the Zep/Graphiti paper](https://arxiv.org/abs/2501.13956).)

The core object is a **Context Graph** = a temporal knowledge graph of
entities (nodes) + relationships (edges/facts), where each fact is a *triplet*
("Kendra" —loves→ "Adidas shoes"). What makes it distinct from decades of KG
work is that it **autonomously builds** the graph from unstructured input and
**handles changing relationships while preserving history**.

### 1.2 Episodes → entities + edges

- **Episode** = the unit of ingestion. You hand Graphiti a chunk of text, a
  JSON document, or a message and call **`add_episode()`** (MCP: `add_memory`).
- The raw episode is **preserved verbatim as provenance**. It is then passed
  through an **LLM** that extracts **entities (nodes)** and **relationships
  (edges)**. Every node and edge keeps a pointer back to the episode that
  produced it → full lineage from derived fact to source.
- Extraction is multi-step: node extraction → node dedup/resolution → edge
  extraction → per-edge resolution → temporal stamping → attribute extraction.
  Optionally **community detection** produces higher-level summaries
  (`build_communities`).
- Ontology can be **prescribed** (define entity/edge types up front as Pydantic
  models) or **learned** (let structure emerge). Start simple, evolve later.

### 1.3 Bi-temporal tracking (the headline feature)

Every edge carries **two timelines**:

1. **Valid time** — when the fact was true in the real world ("Maria has been
   on lisinopril since 2024-03-01"). Modeled as `valid_at` / `invalid_at`.
2. **System / transaction time** — when Graphiti *learned* it ("ingested
   2024-03-02T14:21Z"). Modeled as `created_at` / `expired_at`.

When new information conflicts with an old fact, Graphiti **invalidates the old
edge (sets `invalid_at`/`expired_at`) — it does not delete it**. This lets you
query **"what is true now"** *or* **"what was true at time T"**, and preserves
historical accuracy without large-scale recomputation. This is the key
advantage over a flat store where an update overwrites or appends noise.
(Sources: README "Temporal Fact Management"; Zep blog
[Beyond Static Knowledge Graphs](https://blog.getzep.com/beyond-static-knowledge-graphs/);
[arXiv paper](https://arxiv.org/abs/2501.13956).)

### 1.4 Architecture + hard requirements

**Graph database (mandatory — pick one):**

| Backend | Notes |
|---|---|
| **Neo4j** | v5.26+. Production default in docs; separate server/Docker. |
| **FalkorDB** | **Default** for the MCP server (combined Docker container). Redis-based, lighter than Neo4j. |
| **Kuzu** | Embedded (in-process, no server). **DEPRECATED** per current README — upstream unmaintained, emits `DeprecationWarning`, will be removed. |
| **Amazon Neptune** | Cloud/managed option. |
| **FalkorDB "lite" (embedded)** | `pip install graphiti-core[falkordblite]` — embedded FalkorDB, **requires Python 3.12+**. The most promising "no server" path now that Kuzu is deprecated. |

**A graph DB is mandatory.** There is no "just SQLite" mode. The lightest local
options today are embedded FalkorDB-lite (Py 3.12+) or a single FalkorDB Docker
container.

**LLM + embedder (mandatory for extraction):**

- **Defaults to OpenAI** for *both* LLM inference and embeddings — README:
  "Ensure that an `OPENAI_API_KEY` is set." (`MODEL_NAME` selects the model.)
- Native support: **OpenAI, Anthropic, Gemini, Groq, Azure OpenAI** (LLM);
  **OpenAI, Voyage, Sentence Transformers, Gemini** (embeddings).
- **Any OpenAI-compatible endpoint** works: DeepSeek, Together, OpenRouter, and
  **local servers — Ollama, vLLM, llama.cpp, LM Studio**.

**Fully local / offline?** Yes, *technically*: Graphiti + embedded FalkorDB (or
FalkorDB Docker) + **Ollama** for both LLM and embeddings, e.g.
`ollama pull deepseek-r1:7b` (LLM) + `ollama pull nomic-embed-text`
(embeddings). But this means the user must run Ollama and a graph DB — a heavy
stack, and small local models degrade extraction quality.

### 1.5 Retrieval (search)

Hybrid retrieval, "without reliance on LLM summarization":

- **Semantic** (embedding cosine) **+ keyword (BM25 / full-text) + graph
  traversal**, fused.
- **Reranking** — e.g. reranking edge results by **graph distance** from a
  `center_node_uuid`; predefined "search recipes" for node search.
- Temporal filters on search (`valid_at` / `invalid_at` date ranges).
- **Latency:** search is comparatively cheap — roughly **~80–300 ms** on top of
  your reasoner (it does *not* require an LLM call for a plain search).

### 1.6 Cost / latency of ingest (the real tax)

- **`add_episode` is LLM-heavy.** Each episode fires *multiple* LLM calls
  (node extraction → dedup → edge extraction → per-edge resolution →
  timestamping → attributes) plus embedding calls. Community reports put a
  single extraction call at **~300–1500 ms**, and a full episode at several
  calls → this is where **cost and latency land**.
- Guidance from the community/maintainers: **ingest asynchronously** (off the
  critical path), retrieve synchronously; default concurrency is set low to
  avoid provider 429s (raise it if too slow). There are open issues asking for
  cheaper/no-LLM extraction (#1193, #1299).
- **Implication for Forge:** writing a memory is no longer a instant local file
  append — it becomes an async, billable, LLM-mediated operation. That is a
  real behavioral change for `forge remember`.

### 1.7 The Graphiti MCP server (the important part for Forge)

There is an official (experimental) **MCP server** in `graphiti/mcp_server/`
that exposes the graph over the Model Context Protocol, so **any MCP client —
Claude, Cursor, Codex, etc. — gets graph memory** without any Node/Python glue
of ours.

**Tools it exposes** (current README):
`add_memory` (add episode; supports bi-temporal `reference_time`, custom
extraction instructions, saga chaining), `add_triplet` (add a fact directly,
bypassing LLM extraction), `search_nodes`, `search_memory_facts` (edges; with
`valid_at`/`invalid_at` filters), `get_episodes`, `get_episode_entities`
(provenance), `get_entity_edge`, `delete_entity_edge`, `delete_episode`,
`build_communities`, `summarize_saga`, `clear_graph`, `get_status`. Data is
partitioned by **`group_id`** (namespacing — one graph, many scopes).

**Prerequisites:** Python 3.10+, an LLM API key (or local provider), an
MCP-capable client, and **Docker + Docker Compose** for the default combined
**FalkorDB + MCP** container (`docker compose up`). Neo4j alternative via a
separate compose file. Transports: **stdio** (Claude Desktop et al.) and
**HTTP** at `/mcp/` (Cursor et al.).

**Client config** looks like (stdio, run via `uv`):

```json
{
  "mcpServers": {
    "graphiti-memory": {
      "transport": "stdio",
      "command": "/path/to/uv",
      "args": ["run","--isolated","--directory","/path/to/graphiti/mcp_server",
               "--project",".","main.py","--transport","stdio"],
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j", "NEO4J_PASSWORD": "password",
        "OPENAI_API_KEY": "sk-...", "MODEL_NAME": "gpt-5.5"
      }
    }
  }
}
```

This shape maps **1:1** onto how Forge already writes `.mcp.json` (see §2.1).

### 1.8 Language reality: Graphiti is Python; Forge is Node.js

Graphiti is **Python** (`pip install graphiti-core`; `graphiti-core[…]`
extras). Forge is a Node.js CLI. Integration boundaries, concretely:

| Option | What it requires | Verdict |
|---|---|---|
| **(a) Run the Graphiti MCP server as a sidecar; the *agent* talks to it directly** | Forge writes an `.mcp.json` entry + docs a graph DB (FalkorDB Docker) + an LLM key. Forge itself never speaks to Graphiti — the agent does, over MCP. | **Recommended.** Least glue, delivers the "any agent" promise, keeps Forge's core dependency-free. |
| **(b) Forge shells out to a Python process/service** | Bundle/generate a small Python wrapper; Forge spawns it (or calls a local HTTP `/mcp` endpoint) for `remember`/`recall`. Adds Python runtime dependency to the Forge CLI path. | Viable as a thin secondary path so `forge recall` works outside an agent, but adds a Python dep to a Node tool. Do only if CLI parity is required. |
| **(c) REST / Zep Cloud API** | Use hosted **Zep** (the commercial product built on Graphiti) instead of self-hosting. No local graph DB; notes leave the machine. | Easiest ops, worst for local-first/privacy. Offer as an opt-in "cloud" mode only. |
| **(d) Node reimplementation** | Re-build bi-temporal extraction + graph store in JS. | **Infeasible / anti-goal.** Throws away the reason to adopt Graphiti; huge surface; diverges from upstream. Do not. |

---

## Part 2 — Designing the Forge integration

### 2.0 Where Forge is today (grounding)

- **Flat store (live):** `lib/memory-store.js` — `append/list/search` over
  **JSONL**; `forge remember` (`lib/commands/remember.js`) and `forge recall`
  (`lib/commands/recall.js`) use it. Simple, instant, offline, no deps.
- **Kernel store (orphaned):** `lib/project-memory.js` writes `kernel_memories`
  (a kernel read model) with `content`, `confidence`, `supersedes[]`,
  `beadsRefs[]`; `lib/memory/typed-api.js` wraps it. It has the *shape* of a
  temporal/superseding memory but **nothing traverses it** — the intended
  temporal-knowledge-graph design (`docs/work/2026-04-28-skeleton-pivot/
  agent-memory-architecture.md`, `2026-06-06-kernel-backlog-memory-roadmap/
  plan.md`) was never built.
- **MCP wiring (live):** `lib/commands/setup.js` `setupClaudeMcpConfig()` writes
  `.mcp.json` with an `mcpServers` block (currently Context7). **This is the
  exact hook to add a `graphiti-memory` server.**

Graphiti is essentially the *productized version of what `kernel_memories`
gestured at* (supersedes → edge invalidation; confidence/provenance →
episodes). So the design question is: adopt Graphiti as that engine, or finish
building the kernel layer ourselves. This doc recommends **adopting Graphiti,
optionally, without ripping out the local store.**

### 2.1 Recommended architecture

**Principle: three tiers, Graphiti is the top opt-in tier; the local store is
always the floor.** Forge must keep working with zero external services.

```
  forge remember "<note>"                 forge recall "<query>"
        │                                        │
        ▼                                        ▼
  ┌─────────────────── memory router (lib/memory/router.js) ───────────────────┐
  │  backend = config.memory.backend  (default: "local")                       │
  │                                                                            │
  │  "local"    → memory-store.js (JSONL)         [always available, offline]  │
  │  "kernel"   → project-memory.js (SQLite)      [structured, still local]    │
  │  "graphiti" → Graphiti MCP/HTTP  ── add_memory / search_memory_facts ──┐   │
  └────────────────────────────────────────────────────────────────────────┼───┘
                                                                           │
                    (agent path — the real prize)                         │
   agent (Claude/Codex/Cursor) ──MCP──►  graphiti-memory server ──────────┘
                                              │
                                    ┌─────────┴─────────┐
                                    ▼                   ▼
                              graph DB              LLM + embedder
                         (FalkorDB Docker /      (OpenAI default, or
                          embedded / Neo4j)       Ollama for offline)
```

Two consumers of Graphiti, same server:

1. **Agent-native (primary):** Forge configures `graphiti-memory` into the
   agent's `.mcp.json`. The agent calls `add_memory`/`search_*` **directly** —
   richest experience, zero Forge runtime coupling. This is the **"extension
   usable in any agent"** the user described.
2. **CLI parity (secondary, optional):** `forge remember`/`recall` proxy to the
   same server (HTTP `/mcp` or a spawned client) so the CLI stays useful outside
   an agent. If Graphiti isn't configured, the router silently falls back to
   `local`.

**Coexistence with `kernel_memories`:** don't fork the story further. Make the
kernel layer the **structured local fallback** (tier "kernel") and treat
Graphiti as the superset engine. `supersedes` → edge invalidation;
`confidence` → edge attribute; `beadsRefs` → `group_id`/entity links. Migration
(§2.4) replays kernel/JSONL notes as episodes.

### 2.2 "Usable in any agent" via `.mcp.json`

The win is exactly that Forge's `setup` writes the Graphiti MCP server into each
agent's config — the same mechanism already used for Context7
(`setup.js:1766`). Concretely, when `memory.backend = graphiti`, `forge setup`
adds:

```json
"graphiti-memory": {
  "transport": "stdio",
  "command": "uv",
  "args": ["run","--directory","<graphiti>/mcp_server","main.py","--transport","stdio"],
  "env": { "FALKORDB_URI": "redis://localhost:6379",
           "OPENAI_API_KEY": "${OPENAI_API_KEY}", "GROUP_ID": "<project>" }
}
```

Because MCP is agent-agnostic, the *same* block serves Claude Code, Cursor, and
any MCP client — Forge just needs per-agent config paths (it already resolves
these for Context7). For Codex/others without MCP, fall back to the CLI proxy.

### 2.3 Concrete Forge changes (plan, not code)

1. **Config keys** (`.forge/config.yaml`):
   `memory.backend: local | kernel | graphiti` (default `local`);
   `memory.graphiti.transport` (stdio|http), `.mcpServerPath`, `.graphDb`
   (falkordb|falkordb-lite|neo4j), `.dbUri`, `.llmProvider`, `.model`,
   `.embedder`, `.groupId` (defaults to project id), `.apiKeyEnv`.
2. **Memory router** (`lib/memory/router.js`): single dispatch used by both
   commands; picks backend from config; **hard fallback to `local`** whenever
   Graphiti is unreachable/unconfigured (never break `remember`/`recall`).
3. **`forge remember` → `add_memory`**: map note + tags → episode
   (`source="text"` or `"json"`), pass `group_id`, optional `reference_time`.
   Make it **fire-and-forget/async** (ingest is slow); confirm queued.
4. **`forge recall` → `search_memory_facts` (+ `search_nodes`)**: return facts
   with validity windows and provenance; expose a `--at <time>` flag for
   historical queries (the bi-temporal payoff).
5. **`forge setup` wiring**: when backend=graphiti, write the `.mcp.json`
   entry (§2.2) for each detected agent; optionally emit a
   `docker-compose.yml`/print `docker compose up` for FalkorDB; a
   `forge memory doctor` to check DB + key + server reachability.
6. **A `memory` skill** (`skills/memory/SKILL.md`): teach agents *when/how* to
   use graph memory — write durable facts as episodes, prefer `search_memory_facts`
   before assuming, use `group_id` per project, respect provenance. Update
   AGENTS.md's "use `forge remember`" line to point at the skill.
7. **Migration** (§2.4).

### 2.4 Migration of existing notes

- One-shot `forge memory migrate`: read JSONL (`memory-store`) + `kernel_memories`
  (`project-memory`) and **replay each as an episode** via `add_memory`, using
  the note's timestamp as `reference_time` so bi-temporal history is
  approximately reconstructed; map `supersedes` chains by ingesting oldest→newest
  so Graphiti invalidates superseded facts naturally; carry `beadsRefs`/tags
  into `group_id`/text. Keep the JSONL as an immutable backup; migration is
  **additive and reversible** (Graphiti is a separate store).

### 2.5 Trade-offs & risks (honest)

- **Dependency weight vs. Forge's ethos.** Forge's selling point is local-first,
  low-dep, offline, SQLite-only. Graphiti brings **Python + a graph DB (Docker
  or Py3.12 embedded) + an LLM API key**. That is a *large* jump from "append a
  line to a JSONL file." Must be strictly **opt-in**; the default install must
  stay zero-dep.
- **Cost + latency on every write.** `add_memory` = multiple LLM calls (~sub-second
  to a couple seconds, billable). `forge remember` stops being instant/free.
  Needs async ingest + a visible cost story.
- **Privacy.** With the default OpenAI provider, **every note is sent to an LLM
  for entity extraction.** For a dev-notes/memory tool this is a real concern.
  The offline (Ollama) path fixes privacy but is heavy and lower quality.
- **Offline story is weak by default.** True offline needs Ollama + local graph
  DB; otherwise Graphiti requires network + API key. The `local` tier must
  remain the guaranteed-offline floor.
- **Operational complexity.** Docker/graph DB lifecycle, MCP server process,
  version drift with an *experimental* upstream MCP server, Kuzu already
  deprecated (backend churn risk). More moving parts to support.
- **Maturity.** MCP server is labeled experimental; open issues around
  extraction cost. Betting core memory on it carries upstream risk.
- **Upside if accepted:** genuinely better recall (temporal, relational,
  provenance-tracked), and it's **agent-agnostic** via MCP — one config serves
  every agent, which is squarely on Forge's "usable in any agent" north star.

### 2.6 Open decisions the USER must make

1. **Opt-in vs default?** Recommend **opt-in**; keep `local` as default. Confirm.
2. **Default graph DB** if enabled: **FalkorDB (Docker)** for simplicity,
   **FalkorDB-lite (embedded, Py3.12)** for no-server, or **Neo4j** for
   production? (Kuzu is out — deprecated.)
3. **Default LLM/embedder:** OpenAI (best quality, costs + sends notes out) vs
   **Ollama** (local/private, heavier, weaker extraction) vs OpenRouter
   (matches the user's existing OpenRouter setup).
4. **Self-host Graphiti vs Zep Cloud** (managed REST). Local-first argues
   self-host; Zep is least ops.
5. **Agent-only (MCP) vs also CLI parity?** MCP-only is far less glue; CLI
   parity needs a Python/HTTP proxy.
6. **Do we still finish `kernel_memories`** as the structured local tier, or let
   it stay a thin fallback and invest in the Graphiti path?
7. **Scope of `group_id`:** per-project, per-repo, or global-user memory?

### 2.7 Effort / phasing

- **Not a 0.1.0 item.** 0.1.0 should ship the clean **local**
  (`remember`/`recall`) story and, at most, the **memory router seam** +
  config keys so Graphiti can slot in later without churn. Adding Python + a
  graph DB + LLM keys as a headline 0.1.0 feature contradicts the local-first
  0.1.0 promise.
- **Phase A (0.1.0, small):** introduce `lib/memory/router.js` + `memory.backend`
  config (default `local`), unify `remember`/`recall` behind it, add a
  `memory` skill stub. Pure Node, no new deps. ~1–2 days.
- **Phase B (post-0.1.0, opt-in Graphiti via MCP):** `forge setup` writes the
  `graphiti-memory` `.mcp.json` entry; docs + `forge memory doctor`; the
  `memory` skill teaches agents. No Forge↔Graphiti runtime coupling. ~3–5 days
  incl. docs/testing (excludes the user running Docker/Ollama).
- **Phase C (optional, later):** CLI parity proxy (`remember`/`recall` → MCP/HTTP)
  + `forge memory migrate` for JSONL/kernel notes. ~3–5 days.

---

## Sources

- Graphiti README — https://github.com/getzep/graphiti
- Graphiti MCP server README — https://github.com/getzep/graphiti/tree/main/mcp_server
- Zep docs (overview / MCP / configuration / searching) — https://help.getzep.com/graphiti/getting-started/overview
- Zep paper "Zep: A Temporal Knowledge Graph Architecture for Agent Memory" — https://arxiv.org/abs/2501.13956
- Zep blog "Beyond Static Knowledge Graphs" — https://blog.getzep.com/beyond-static-knowledge-graphs/
- Neo4j blog "Graphiti: Knowledge graph memory for an agentic world" — https://neo4j.com/blog/developer/graphiti-knowledge-graph-memory/
- Cost/latency discussion — getzep/graphiti issues #1193, #1299; community write-ups (Medium/Substack surveys of Letta/Mem0/Graphiti/Cognee)
- Forge code: `lib/memory-store.js`, `lib/project-memory.js`, `lib/memory/typed-api.js`, `lib/commands/{remember,recall,setup}.js`; design docs `docs/work/2026-04-28-skeleton-pivot/agent-memory-architecture.md`, `docs/work/2026-06-06-kernel-backlog-memory-roadmap/plan.md`
