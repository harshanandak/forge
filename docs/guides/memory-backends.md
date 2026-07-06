# Forge Memory

Forge gives agents **durable project memory** through two verbs:

```bash
forge remember "<note>" [--tag <label>]...   # write a lasting fact
forge recall  "[query]"  [--limit N]         # read it back
```

Both route through a small **backend router** (`lib/memory/router.js`). The
backend is chosen by `memory.backend` in `.forge/config.yaml`:

| Backend | Storage | Needs | When |
|---|---|---|---|
| **`local`** (default) | flat JSONL at `.forge/memory/notes.jsonl` | nothing — offline, instant | always the floor |
| **`graphiti`** | temporal **knowledge graph** over MCP | graph DB + LLM | evolving, relational, temporal recall |

`local` and `graphiti` are the only public `memory.backend` values.

> **The local backend is the default and the guaranteed offline floor.** You do
> not need to configure anything to use `forge remember` / `forge recall`. The
> Graphiti backend is strictly **opt-in** and never changes the default path.

Precedence for selecting the backend:
`FORGE_MEMORY_BACKEND` env → `memory.backend` in config → `local`.

Check the active backend any time:

```bash
forge doctor            # reports the memory backend (+ graphiti reachability, non-fatal)
```

## Local (default) — nothing to set up

Notes are appended to `.forge/memory/notes.jsonl`, committed with your repo, and
searched by case-insensitive substring across note text and tags. No services,
no network, no keys. This is what ships and what most projects should use.

## Opt into Graphiti (knowledge-graph memory)

[Graphiti](https://github.com/getzep/graphiti) (getzep/graphiti) is a Python
framework that turns notes ("episodes") into a **bi-temporal knowledge graph**:
an LLM extracts entities and facts, every fact carries two timelines (when it
was true in the world, and when the system learned it), and superseded facts are
**invalidated, not deleted** — so you can query "what is true now" or "what was
true at time T", with a pointer back to the source (provenance). It is served to
any MCP agent through Graphiti's **MCP server**; Forge only wires it in.

Forge does **not** bundle or reimplement Graphiti. This PR ships the config +
router seam and documents how to run Graphiti; **automatically writing the MCP
server into your agent's config is a fast-follow** (a per-harness renderer that
consumes the descriptor in `lib/memory/graphiti-mcp.js`). Until then you add the
server entry yourself (template below). Design rationale and trade-offs:
[`docs/work/2026-07-06-graphiti-memory/research.md`](../work/2026-07-06-graphiti-memory/research.md).

### 1. Turn it on (config)

Set the backend in `.forge/config.yaml` — additive and reversible:

```yaml
memory:
  backend: graphiti
  graphiti:
    # --- active today (validated by the router / forge doctor) ---
    transport: stdio            # stdio | http
    mcpServerPath: ./graphiti/mcp_server   # required — path to the Graphiti checkout's mcp_server dir
    graphDb: falkordb           # falkordb | falkordb-lite | neo4j
    apiKeyEnv: OPENAI_API_KEY    # referenced by NAME — never store the key here
    # --- reserved: consumed by the fast-follow MCP renderer; NO EFFECT yet ---
    dbUri: redis://localhost:6379
    llmProvider: openai
    model: gpt-5.5
    groupId: <your-project>
```

Only `mcpServerPath` is required today (it's what `forge doctor` checks and what
the descriptor threads into the launch args). The keys under "reserved" have no
effect until the per-harness MCP renderer lands — set them now only if you like,
they are no-ops until then.

Forge exposes the MCP server as a harness-agnostic **descriptor** (see
`lib/memory/graphiti-mcp.js`, `buildGraphitiServerDescriptor`) so a per-harness
renderer can wire it into the right place for each agent (Claude `.mcp.json`,
Cursor `.cursor/mcp.json`, Codex `config.toml`). That wiring lands as a
fast-follow; the descriptor's env values are `${VAR}` references only — Forge
never writes a secret into any committed config. The rendered entry looks like:

```json
"graphiti-memory": {
  "transport": "stdio",
  "command": "uv",
  "args": ["run","--isolated","--directory","./graphiti/mcp_server",
           "--project",".","main.py","--transport","stdio"],
  "env": {
    "FALKORDB_URI": "${FALKORDB_URI}",
    "OPENAI_API_KEY": "${OPENAI_API_KEY}",
    "MODEL_NAME": "${MODEL_NAME}",
    "GROUP_ID": "${GRAPHITI_GROUP_ID}"
  }
}
```

### 2. Run the graph DB + MCP server

Graphiti needs a **graph database** and an **LLM/embedder**. The documented
default is **FalkorDB** (a light, Redis-based graph DB via Docker) with an
OpenAI-compatible model. Roughly:

```bash
# a) graph DB (FalkorDB) — or run the Graphiti combined Docker Compose
docker run -p 6379:6379 -it --rm falkordb/falkordb:latest

# b) the Graphiti MCP server (from a graphiti checkout)
git clone https://github.com/getzep/graphiti
cd graphiti/mcp_server
export OPENAI_API_KEY=sk-...          # or point at an OpenAI-compatible endpoint
uv run --isolated --directory . --project . main.py --transport stdio
```

Set `memory.graphiti.mcpServerPath` in `.forge/config.yaml` to the checkout's
`mcp_server` directory so `forge doctor` can see it.

**Alternatives** (all documented in the design doc):

- **Graph DB:** FalkorDB (Docker, default) · FalkorDB-lite (embedded, Python
  3.12+, no server) · Neo4j (production). Set `memory.graphiti.graphDb` +
  `dbUri` accordingly (Neo4j uses `NEO4J_URI` plus `NEO4J_USER` and
  `NEO4J_PASSWORD`).
- **LLM/embedder:** OpenAI (best quality) · any OpenAI-compatible endpoint
  (OpenRouter, DeepSeek, Together) · **Ollama** for a fully local/offline stack
  (`ollama pull deepseek-r1:7b` + `ollama pull nomic-embed-text`). Set
  `memory.graphiti.llmProvider` / `model` / `apiKeyEnv`.

### 3. Use it

Once wired, **agents** call the graph directly over MCP:

- `add_memory` — record a durable fact/decision as an episode (scope with
  `group_id`). Ingestion is LLM-backed, so treat writes as async.
- `search_memory_facts` — retrieve facts/edges (with validity windows) before
  assuming.
- `search_nodes` — find entities and summaries.

The **`memory` skill** ([`skills/memory/SKILL.md`](../../skills/memory/SKILL.md))
teaches agents when and how to use these. `forge remember` / `forge recall` keep
working from the CLI — when the graph backend is selected they still write to the
local JSONL store as a safety floor, so a note is never lost.

## Privacy & cost (read before enabling)

- **Privacy:** with an LLM provider like OpenAI, **every note you add as an
  episode is sent to that LLM** for entity/fact extraction. For private dev
  notes this matters — use the Ollama/local path if that is a concern.
- **Cost + latency:** `add_memory` fires **multiple LLM calls** per episode, so
  writes are billable and take from sub-second to a couple of seconds. Prefer
  async ingest; retrieval is cheap.
- **Ops:** you run and maintain a graph DB + the (experimental) Graphiti MCP
  server. This is a real jump from "append a line to a JSONL file" — which is
  exactly why it is opt-in and the local backend stays the default.

## Turning it off

Remove `memory.backend` (and the `memory.graphiti` block) from
`.forge/config.yaml` — the router falls straight back to `local`. Your local
JSONL notes were never touched. If you manually added a `graphiti-memory` entry
to your agent's MCP config, delete it too (Forge did not write one).
