# Design: Project Memory

- **Slug**: project-memory
- **Date**: 2026-04-26
- **Status**: Implemented
- **Issue**: forge-xdh7
- **Parent epic**: forge-f3lx

---

## Purpose

Forge needs one project-local memory format that every supported agent can read and write without depending on that agent's private memory system. The memory stores durable project context such as decisions, preferences, policies, and reusable notes.

This complements Beads issue tracking. Beads remains the source of truth for issue lifecycle, workflow stages, ownership, dependencies, and task status. Project memory stores cross-session context that is useful even when it is not tied to one issue.

The research conclusion is that current agent products mostly share instructions, not writable memory. `AGENTS.md`, `CLAUDE.md`, Cursor rules, Cline Memory Bank, and OpenCode rules are prompt/documentation surfaces. Claude auto memory and similar product-native stores are useful, but they are agent-specific and often machine-local. Forge should therefore own the canonical project memory and let agent-specific systems consume it through adapters.

---

## Success Criteria

1. Store memory in a file-based, agent-agnostic location under `.forge/memory/`.
2. Define a stable entry schema with `key`, `value`, `source-agent`, `timestamp`, and `tags`.
3. Provide `lib/project-memory.js` with `read`, `write`, `search`, and `list` exports.
4. Support Claude, Cursor, Codex, Cline, and OpenCode by avoiding agent-specific runtime assumptions.
5. Keep the first implementation local and deterministic, with no MCP server dependency.

---

## Format Spec

Project memory is stored as newline-delimited JSON at:

```text
.forge/memory/entries.jsonl
```

Each line is one entry:

```json
{"key":"policy.stage-order","value":"Run /plan before /dev for standard feature work.","source-agent":"Codex","timestamp":"2026-04-26T00:00:00.000Z","tags":["policy","workflow"],"scope":"project","confidence":0.95,"beads-refs":["forge-xdh7","forge-f3lx"]}
```

JSONL is used instead of one large JSON array because it is easier to inspect, diff, merge, and repair. Writes still upsert by `key`, so the canonical store does not accumulate duplicate current records for the same memory key.

Entry fields:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `key` | string | yes | Stable unique identifier. Writes upsert by key. |
| `value` | JSON value | yes | String, number, boolean, object, array, or null. |
| `source-agent` | string | yes | Agent that wrote the entry, such as `Claude`, `Cursor`, `Codex`, `Cline`, or `OpenCode`. |
| `timestamp` | ISO-compatible string | yes | Caller-provided or generated at write time. |
| `tags` | string array | yes | Search and grouping labels. |
| `scope` | string | no | Suggested applicability, such as `repo`, `project`, `workflow`, `package:<name>`, or `path:<glob>`. |
| `confidence` | number | no | Writer confidence from `0` to `1`; useful when surfacing inferred context. |
| `supersedes` | string array | no | Older memory keys replaced by this entry. |
| `beads-refs` | string array | no | Related Beads issue IDs. This is a reference only, not lifecycle state. |

The JavaScript API accepts and returns `sourceAgent` while persisting `source-agent` on disk. This keeps the disk format language-neutral without making JavaScript callers use bracket notation.

---

## API

`lib/project-memory.js` exports:

- `read(projectRoot, key, options)` returns one entry or `null`.
- `write(projectRoot, entry, options)` validates and upserts one entry by `key`.
- `search(projectRoot, query, options)` performs case-insensitive search across key, JSON-serialized value, source agent, tags, and optional metadata.
- `list(projectRoot, options)` returns all entries in file order.

`options.filePath` can override the storage file for tests or future adapters.

---

## Coexistence With Beads

Beads owns workflow state:

- issue IDs, including `forge-xdh7`
- parent/child relationships, including `forge-f3lx`
- status, dependencies, priorities, claims, comments, and stage transitions
- task progress and validation metadata

Project memory owns reusable context:

- durable decisions that apply across issues
- coding or workflow preferences
- project-local policies
- repeated troubleshooting notes
- agent-neutral context that should not live only in Claude, Cursor, Codex, Cline, or OpenCode private stores

Memory entries may reference Beads IDs in `key`, `value`, or `tags`, but memory does not replace Beads records or duplicate issue lifecycle state.

---

## Coexistence With Agent-Specific Stores

Agent-specific stores remain useful for private or product-native behavior. They should be treated as caches, views, or personal notes. Forge project memory is the shared baseline:

- Claude can mirror selected context from its memory into `.forge/memory/entries.jsonl`.
- Cursor rules can read or summarize project memory without making `.cursor/` the source of truth.
- Codex skills can use project memory as project-local reusable context.
- Cline and OpenCode can write the same format without needing Claude or Codex conventions.

If agent-specific memory conflicts with project memory, the project memory entry should be treated as the portable project-level record until a new entry updates it.

Adapter model:

1. Canonical store: `.forge/memory/entries.jsonl`.
2. Read-only prompt adapters: generated summaries for `AGENTS.md`, `CLAUDE.md`, Cursor `.mdc` rules, Cline Memory Bank, and OpenCode rules.
3. Write adapters: Forge CLI or MCP tools that validate schema and write back to the canonical store.
4. Agent-private stores: allowed to cache or summarize Forge memory, but not treated as authoritative.

---

## Technical Research

Verified patterns:

- `AGENTS.md` is an open, Markdown-based instruction format used across many coding agents. It is designed as a predictable place for agent instructions, not as a structured writable memory database. Source: https://agents.md/
- Claude Code separates checked-in project instructions from auto memory. Claude auto memory is stored under `~/.claude/projects/<project>/memory/`, shared across worktrees for the same repo on one machine, and not shared across machines or cloud environments. Source: https://code.claude.com/docs/en/memory
- Anthropic's memory tool is closer to the right abstraction for Forge: the model uses memory operations, but the client controls storage and can implement file, database, cloud, or encrypted backends. Source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool
- Codex aggregates `AGENTS.md` and related instruction files into user instructions at session initialization. This is prompt/context loading, not an agent-neutral writeable memory store. Source: https://openai.com/index/unrolling-the-codex-agent-loop/
- Cursor project rules live under `.cursor/rules` and act as persistent reusable prompt context. They can encode project knowledge, but they are Cursor-specific adapter files. Source: https://docs.cursor.com/ru/context/rules
- Cline Memory Bank is a structured documentation method that preserves project knowledge in files and explicitly works with any AI that can read docs. This validates the file-backed direction, but Forge still needs a stricter schema for agent-neutral writes. Source: https://docs.cline.bot/features/memory-bank
- OpenCode reads project `AGENTS.md` and can combine custom instruction files, again reinforcing instruction sharing rather than shared writable memory. Source: https://open-code.ai/en/docs/rules
- MCP roots and tools provide the most plausible future shared API. Roots define filesystem boundaries; tools expose structured operations that agents can invoke. Sources: https://modelcontextprotocol.io/specification/2025-06-18/client/roots and https://modelcontextprotocol.io/specification/2025-06-18/server/tools

Conclusion: democratized Forge memory should be repo-owned, schema-validated, inspectable in Git, and adapter-driven. Agent-native memory should consume or mirror Forge memory, not own the canonical record.

---

## Future MCP Surfacing

Future MCP support can expose the same file-backed data through tools such as:

- `project_memory.list`
- `project_memory.read`
- `project_memory.write`
- `project_memory.search`

The MCP server should use `lib/project-memory.js` rather than introducing a second storage path. MCP responses should preserve the schema and include enough metadata for agents to cite the source entry.

MCP should be the first-class shared write path because it gives all supporting agents the same tool contract. A future server should:

- use MCP roots to locate the current project and prevent writes outside the workspace;
- expose read/search/list tools as low-risk operations;
- expose write as a validation-gated operation;
- optionally return resource links or embedded resources for memory entries and generated summaries.

---

## Out of Scope

- Replacing Beads issue tracking or workflow stage metadata.
- Synchronizing memory to a remote service.
- Conflict-free replicated editing across concurrent agents.
- Storing secrets, credentials, tokens, or private user data.
- Adding CLI commands or MCP tools in this change.
- Migrating existing Claude, Cursor, Codex, Cline, or OpenCode memory stores.
- Auto-generating agent-specific prompt/rule files in this change.

---

## Ambiguity Policy

For schema additions, prefer additive optional fields under a future `version` bump. Do not change the meaning of existing fields without a migration plan and tests.
