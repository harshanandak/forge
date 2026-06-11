# Forge Agent Interface Layer — Beads-Plugin Parity for the Kernel

**Status:** Accepted design direction (D22 in `decisions.md`), issues proposed below, not yet implemented.

## Why this exists

Beads is pleasant for agents not because of Dolt, but because of its **surface**: when an agent session starts in a Beads repo, a hook injects workflow context (`bd prime`), a full skill set is discoverable (`beads:ready`, `beads:show`, `beads:search`, `beads:stats`, `beads:blocked`, `beads:epic`, `beads:comments`, `beads:import/export`, …), every command has JSON output, memory persists via `bd remember`, and CLAUDE.md teaches the contract. The agent never has to figure out *how* to use the tracker — the harness hands it the interface.

If the Forge Kernel replaces Beads without an equivalent surface, agents get a better database and a worse experience. Agent-interface parity is therefore a **named retirement gate** for Beads (D14/D20/D22): the kill list cannot complete while agents still need `bd` ergonomics.

## What Beads provides today (the parity checklist)

| Beads surface | What it does for agents | Forge Kernel equivalent |
|---|---|---|
| SessionStart hook → `bd prime` | Injects workflow context + command reference at session start; re-primes after compaction | `forge prime` — bounded orientation (D21 file-assembly orient) injected by a SessionStart hook |
| `bd ready` (dependency-aware queue) | One command answers "what can I work on" | `forge issue ready` over the derived readiness read model |
| `bd show / list / search / stats / blocked` | Scoped state queries | `forge issue show/list/search/stats` + readiness filters |
| `bd create / update / close / dep add / comments` | Mutations with dependency graph | `forge issue create/update/close/dep/comment` through the Kernel broker (revision + idempotency handled invisibly by the CLI) |
| `bd update --claim` | Work claiming | `forge claim <id>` — DB-enforced lease, not a label |
| `bd remember` / `bd memories` | Persistent agent insights | `forge remember` → KnowledgeStore proposal with provenance (per `agent-memory-federation.md`); `forge recall <query>` |
| `bd formula` / `bd mol` | Structured workflow templates | Already covered by Forge stage skills (`/plan`, `/dev`, …) — explicitly out of scope here |
| ~17 plugin skills + CLAUDE.md contract | Discoverability in the harness | Forge plugin skill set + generated instruction blocks (existing `scripts/sync-commands.js` 7-harness sync) |
| JSONL in git | State travels with repo | D16 portability projection |

## Design

### 1. `forge prime` (session entry point)
- Emits the D21 bounded orientation: project identity + `docs/PROJECT_DESIGN.md` headline decisions + active work item (plan/tasks state) + ready queue + active claims + next_commands.
- Explicit token budget (default ≤ 2K), deterministic truncation (decisions and claims never truncate first).
- Wired as a SessionStart/post-compaction hook in the Forge plugin; plain `forge prime` for harnesses without hooks.
- Replaces `bd prime` in the session hook as a kill-list item.

### 2. Kernel-facing command set (CLI first, skills wrap CLI)
Every command: `--json` mode, stable schemas, `next_commands[]` in output, exit codes meaningful for scripting.

```
forge issue ready|list|show|search|stats
forge issue create|update|close|comment
forge issue dep add|remove
forge claim <id> / forge release <id>
forge recap <issue>          # D21
forge orient                 # D21
forge remember "<insight>" / forge recall <query>
forge sync                   # becomes: export JSONL projection + git-friendly sync (no dolt)
```

Rule: **skills are thin wrappers over CLI commands** — one source of truth, no skill-only behavior. The CLI derives idempotency keys and handles `expected_revision` retry internally; agents never hand-generate either (plan-evaluation A3).

### 3. Plugin packaging and harness parity
- A Forge plugin (hooks + skills + commands) is the Claude Code distribution; the existing `scripts/sync-commands.js` + `AGENT_SKILL_PARITY.md` + harness capability parity contract (PR #186) extend to the kernel command set for the other 6 harness directories.
- Hooks: SessionStart (`forge prime`), PreCompact (save recap pointer), SessionEnd/Stop (export projection + sync reminder).
- Generated agent instructions (CLAUDE.md/AGENTS.md blocks) teach `forge` commands and stop teaching `bd` — this is the final kill-list stage (D20).
- Optional later: an MCP server exposing the same Kernel read/write contract for harnesses with weak CLI ergonomics. Not MVP; the JSON CLI is the contract either way.

### 4. What this layer is NOT
- Not a new workflow engine — stage skills already exist.
- Not agent private memory — `forge remember` writes provenance-backed proposals, not authority (D3, agent-memory-federation).
- Not harness-specific logic in the Kernel — the Kernel exposes one JSON contract; plugins/hooks adapt per harness.

## Acceptance criteria (retirement-gate quality)

1. Fresh clone, no Beads/Dolt installed: a new agent session gets primed context via hook, runs `forge issue ready --json`, claims, comments, closes, and recaps — zero `bd` invocations.
2. `forge prime` output stays within its token budget on this repo (largest real work folder) and includes next_commands.
3. All skills delegate to CLI commands; `sync-commands.js --check` passes across the 7 harness directories.
4. Session hook replacement: `.claude/settings`/hooks reference `forge prime`, not `bd prime`.
5. `forge remember`/`recall` round-trips an insight with source provenance.

## Proposed issues (for Beads/Kernel sync)

- `agent-interface.1` — Define the kernel CLI command contract (`issue`, `claim`, `remember`, JSON schemas, next_commands, exit codes). Depends on: broker driver (D17).
- `agent-interface.2` — Implement `forge prime` (D21 assembly orient + token budget + hook wiring).
- `agent-interface.3` — Implement issue/claim/comment commands over the broker with invisible idempotency/revision handling.
- `agent-interface.4` — Implement `forge remember`/`recall` as KnowledgeStore proposals. Depends on: knowledge layer MVP or interim event-backed store.
- `agent-interface.5` — Package the Forge plugin: hooks (SessionStart/PreCompact/SessionEnd), skills wrapping CLI, marketplace metadata.
- `agent-interface.6` — Extend sync-commands/harness parity to kernel commands across all 7 agent directories; update generated instructions to drop `bd`.
- `agent-interface.7` — Parity acceptance test: scripted fresh-clone agent session exercising criterion 1 end-to-end.

**Lane:** Kernel/TS state foundation (lane 3), after broker driver + D16 projection; gates Beads retirement alongside D20 kill list.
