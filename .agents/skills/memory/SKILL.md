---
name: memory
description: >
  Capture and retrieve durable project memory the right way -- and, when the graph
  backend is enabled, use temporal knowledge-graph memory. Reach for this whenever
  you are about to write down a lasting fact, decision, convention, or gotcha ("remember
  that...", "note for later", "save this"), or when you need to recall what was learned
  before ("what did we decide about X", "have we seen this"). It explains WHEN to use
  `forge remember` / `forge recall` versus a per-issue `forge issue comment`, how the
  two public backends work (local JSONL default, opt-in Graphiti; kernel is internal-only),
  and -- when Graphiti is enabled -- how to add episodes and search facts via the graphiti-memory MCP tools
  (add_memory, search_memory_facts, search_nodes) with group_id scoping and provenance.
  The local backend is always the offline floor. Not for: issue create/list/close ops
  (issue-basics), workflow status (status), or transient scratch notes.
allowed-tools: Bash, Read, Grep, Glob
terminal: true
---

# Memory

Durable project memory for agents. This skill teaches you where a fact belongs,
which backend is active, and how to use graph memory when it is enabled.

## The one rule

Persistent, project-level knowledge goes to **`forge remember`** — never to a
`MEMORY.md` file, never to a scratch note that dies with the session. Retrieve it
with **`forge recall`**. Both verbs route through one backend router; the default
is a local file store, so they always work offline with zero setup.

## When to use what

- **`forge remember "<note>"`** — a lasting fact that outlives this issue: a
  convention, a decision and its rationale, a non-obvious gotcha, an environment
  quirk, a "we tried X, it failed because Y". Add `--tag <label>` for retrieval.
- **`forge recall "<query>"`** — before assuming, check what is already known.
  Search first; do not re-derive knowledge the project already recorded.
- **`forge issue comment <id> "<note>"`** — progress or context that belongs to
  ONE issue's lifecycle (status, a blocker, a hand-off). Issue-scoped, not global.
- **Rule of thumb:** would a future session on a *different* issue want this? →
  `remember`. Is it only meaningful inside this issue? → `issue comment`.

## Backends (config: `memory.backend` in `.forge/config.yaml`)

The router picks a backend; `remember`/`recall` behave the same from your side.
The public backends are exactly two:

- **`local`** (DEFAULT) — flat JSONL at `.forge/memory/notes.jsonl`. Instant,
  offline, no dependencies, travels with the repo in git. This is the floor and
  is always available.
- **`graphiti`** — opt-in temporal **knowledge graph** served to agents over MCP.
  Richer recall (relational, temporal, provenance-tracked) but needs a graph DB
  and an LLM. See "Graph memory" below. When selected, the CLI still writes to
  the local store as a safety floor; the graph is consumed by agents via MCP.

Check the active backend with `forge doctor` — it reports the memory backend and,
for graphiti, whether the configured MCP server path is present (read-only,
non-fatal).

## Graph memory (when `memory.backend: graphiti`)

Graphiti turns notes into a **bi-temporal knowledge graph**: you add *episodes*
(text/JSON), an LLM extracts *entities* (nodes) and *facts* (edges), and every
fact keeps two timelines — when it was true in the world and when the system
learned it. Superseded facts are **invalidated, not deleted**, so you can ask
"what is true now" or "what was true at time T", with a pointer back to the
source episode (provenance).

When enabled and the `graphiti-memory` MCP server is wired into your agent, use
its tools directly:

- **`add_memory`** — record a durable fact/decision as an episode. Pass a clear
  `name`, the content, and the project `group_id` (namespaces one project's
  memory). Ingestion is LLM-backed, so treat it as async — confirm it queued,
  don't block on it. Prefer this for facts that *evolve* (status, ownership,
  versions, preferences).
- **`search_memory_facts`** — retrieve relationships/facts (edges) for a query,
  with validity windows. Use this before assuming a fact; it returns *current*
  truth plus history.
- **`search_nodes`** — find entities (people, services, components) and their
  summaries.
- Scope every call with the project's `group_id` so memory stays per-project.
- Respect provenance: facts trace back to episodes — cite them when it matters.

If graph memory is unreachable or unconfigured, fall back to `forge remember`
(local) — never lose the note. `forge doctor` surfaces a clear error when the
graphiti backend is selected but not configured.

## Good memory hygiene

- Write **atomic** facts, not essays — one decision or gotcha per note.
- Include the **why**, not just the what (rationale ages better than commands).
- Tag consistently so recall is precise.
- Recall **before** you act on an assumption; record **after** you learn something.

## Setup pointers

- Local is the default — nothing to install.
- To opt into graph memory: set `memory.backend: graphiti` (plus a
  `memory.graphiti` block) in `.forge/config.yaml`, then run FalkorDB + the
  Graphiti MCP server. Wiring the server into each agent's MCP config is a
  follow-up step. Full how-to (graph DB, LLM/embedder, privacy/cost):
  `docs/guides/memory-backends.md`. Design rationale: `docs/work/2026-07-06-graphiti-memory/research.md`.
