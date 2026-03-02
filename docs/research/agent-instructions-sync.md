# Research: Agent Instructions Sync

**Feature slug**: `agent-instructions-sync`
**Beads issue**: TBD
**Date**: 2026-02-25

---

## Objective

Forge ships `AGENTS.md` as the universal workflow instruction file, plus agent-specific files (`CLAUDE.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`, `.clinerules`). Currently these files are **independent and already out of sync** (GEMINI.md still has `/merge` instead of `/premerge`). There is no mechanism to keep them consistent.

**Goal**: Establish a clear sync strategy so all agent instruction files stay accurate, understand which agents load which files, and warn users about the OpenCode global fallback issue.

---

## Codebase Analysis

### Current File State

| File | Exists | Status |
|------|--------|--------|
| `AGENTS.md` | ✅ | Canonical — has full workflow with change classification |
| `CLAUDE.md` | ✅ | Modified this session — now thin wrapper pointing to AGENTS.md (Option A, failed) |
| `GEMINI.md` | ✅ | **Stale** — still has `/merge` instead of `/premerge` for stage 8 |
| `.cursorrules` | ✅ | Unknown sync state |
| `.windsurfrules` | ✅ | Unknown sync state |
| `.clinerules` | ✅ | Unknown sync state |
| `.github/copilot-instructions.md` | ❌ | Missing (plugin defines it) |
| `.aider.conf.yml` | ❌ | Created on `feat/agent-permissions` branch (uncommitted) |
| `opencode.json` | ❌ | Created on `feat/agent-permissions` branch (uncommitted) |
| `.codex/config.toml` | ❌ | Created on `feat/agent-permissions` branch (uncommitted) |

### Agent rootConfig Mapping (from `lib/agents/*.plugin.json`)

| Agent | rootConfig file | Loads AGENTS.md natively? |
|-------|----------------|--------------------------|
| Claude Code | `CLAUDE.md` | ❌ No |
| Google Antigravity | `GEMINI.md` | ❌ No |
| Cursor | `.cursorrules` | ✅ Yes (AGENTS.md listed as co-founder) |
| Windsurf | `.windsurfrules` | ✅ Yes (auto-discovers at root + subdirs) |
| Cline | `.clinerules` | ✅ Yes (listed on agents.md) |
| Roo Code | `.clinerules` | ✅ Yes |
| GitHub Copilot | `.github/copilot-instructions.md` | ✅ Yes (Copilot Coding Agent) |
| Kilo Code | (none specified) | ✅ Yes — reads `AGENTS.md` natively |
| OpenCode | (none specified) | ✅ Yes — but also loads `CLAUDE.md` as fallback (see below) |
| Aider | `.aider.conf.yml` | ⚠️ Needs `read: AGENTS.md` in config |
| Codex CLI | `.codex/config.toml` | ✅ Yes — `AGENTS.md` is primary instruction file |

### Existing Sync Tooling

**None exists.** The `lib/agents-config.js` generates `AGENTS.md` on first setup, and `lib/plugin-manager.js` discovers plugins — but there is no `--sync` flag, no regeneration command, and no validation that agent files match `AGENTS.md`. Changes to `AGENTS.md` require manual updates to all other files.

---

## Web Research Findings

### Which Agents Natively Load AGENTS.md

**Verified from official docs and agents.md:**

- **Windsurf**: Auto-discovers `AGENTS.md` at root and all subdirectories. Scoped by directory. ([Windsurf docs](https://docs.windsurf.com/windsurf/cascade/agents-md))
- **Cursor**: Listed as founding contributor of AGENTS.md format. Known bug: background agents don't load it. ([Cursor forum](https://forum.cursor.com/t/background-agents-do-not-load-agents-md/132446))
- **GitHub Copilot**: Copilot Coding Agent respects `AGENTS.md`. ([agents.md](https://agents.md/))
- **Kilo Code**: Loads `AGENTS.md` only. Falls back to `AGENT.md`. No `CLAUDE.md` loading. ([Kilo Code docs](https://kilo.ai/docs/customize/agents-md))
- **OpenCode**: Loads `AGENTS.md` first. Falls back to `CLAUDE.md` at project level AND `~/.claude/CLAUDE.md` globally (see issue below).
- **Codex CLI**: `AGENTS.md` is primary instruction file. `project_doc_fallback_filenames` config allows custom fallbacks. ([Codex docs](https://developers.openai.com/codex/config-reference/))
- **Aider**: Does NOT auto-load. Requires `read: AGENTS.md` in `.aider.conf.yml`. ([Aider docs](https://aider.chat/docs/usage/conventions.html))
- **Claude Code**: Does NOT load `AGENTS.md`. Loads `CLAUDE.md` only.
- **Antigravity**: Does NOT load `AGENTS.md`. Loads `GEMINI.md` only. ([Antigravity docs](https://antigravity.google/docs/agent))

### Key Finding: Two Separate Audiences

Most agents read `AGENTS.md` natively. Only Claude Code and Antigravity use proprietary files. This means:
- `AGENTS.md` = primary, full-content file (serves ~9 agents)
- `CLAUDE.md` = Claude Code only
- `GEMINI.md` = Antigravity only

No agent loads all three simultaneously. No context bloat risk from triple-loading.

---

## OpenCode Global Fallback Issue

### What Happens

OpenCode's loading order (verified from [OpenCode rules docs](https://opencode.ai/docs/rules/) and [GitHub issue #9282](https://github.com/anomalyco/opencode/issues/9282)):

1. **Project level**: `AGENTS.md` → `CLAUDE.md` → `CONTEXT.md` (first match wins, others skipped)
2. **Global level**: `~/.config/opencode/AGENTS.md` → `~/.claude/CLAUDE.md` (first match wins)
3. **Project + global are combined** — both are concatenated into the system prompt

**The problem**: If a user has no `~/.config/opencode/AGENTS.md`, OpenCode silently falls back to `~/.claude/CLAUDE.md` — which may contain personal instructions, API keys, workflow notes, and sensitive context irrelevant to the Forge project.

### Can Forge Fix This?

**No.** This is controlled by the user's machine. Forge cannot create `~/.config/opencode/AGENTS.md` for users.

### Mitigation

Warn users in `docs/SETUP.md`:
- Describe the fallback behavior
- Recommend creating `~/.config/opencode/AGENTS.md` with personal global preferences
- Note that if no global file exists, their `~/.claude/CLAUDE.md` will be loaded by OpenCode

---

## Option A Test Results (Soft Instruction)

**Approach**: Add instruction in `CLAUDE.md` — "Read AGENTS.md using the Read tool at the start of every session"

**Test**: Fresh session, asked "What are the stages of the workflow?" and "What is the workflow for this project?"

**Result**: ❌ Failed. Claude Code answered from `.claude/rules/workflow.md` and `CLAUDE.md` without reading `AGENTS.md`. The instruction was ignored because existing context was sufficient to answer. Critical/Standard/Tactical change classification (only in AGENTS.md) was never mentioned.

**Conclusion**: Soft instructions inside auto-loaded files are unreliable. Cannot depend on AI behavior for synchronization.

---

## Key Design Decisions

**Decision 1: AGENTS.md is the source of truth — keep it full**
- Reasoning: The majority of agents (9 out of 11) load AGENTS.md natively
- Alternative: Distribute content across agent-specific files (rejected — unmaintainable)

**Decision 2: CLAUDE.md and GEMINI.md contain their own accurate summaries (Option B)**
- Reasoning: Claude Code and Antigravity never load AGENTS.md; they need their own files
- Approach: Sync script keeps the workflow table in CLAUDE.md and GEMINI.md accurate with AGENTS.md
- What stays in CLAUDE.md only: build commands, MCP setup, git workflow, USER section (project-specific)
- What gets synced from AGENTS.md: the 9-stage workflow table and stage commands

**Decision 3: Agents that load AGENTS.md natively get no extra file**
- Agents like Kilo Code, Codex, Windsurf already get full content from AGENTS.md
- No need to maintain separate files for them

**Decision 4: Warn about OpenCode global fallback, don't try to fix it**
- Reasoning: Cannot create files on user's machine from project repo
- Mitigation: Clear warning in docs/SETUP.md with exact fix instructions

**Decision 5: Add Codex CLI to the supported agents list**
- Codex CLI is a prominent agent currently missing from Forge's agent table in AGENTS.md and GEMINI.md
- `.codex/config.toml` already created on `feat/agent-permissions` branch

**Decision 6: Fix Aider's AGENTS.md loading**
- Aider doesn't auto-load AGENTS.md — needs `read: AGENTS.md` in `.aider.conf.yml`
- The `.aider.conf.yml` created on `feat/agent-permissions` should include this

---

## TDD Test Scenarios

Config files — no unit tests applicable. Verification is manual:

1. **Sync accuracy**: After sync script runs, diff CLAUDE.md workflow table against AGENTS.md — should be identical
2. **GEMINI.md stage 8**: Must show `/premerge`, not `/merge`
3. **OpenCode warning**: `docs/SETUP.md` must contain warning about global fallback with fix instructions
4. **Aider AGENTS.md**: `.aider.conf.yml` must contain `read: AGENTS.md`
5. **Codex in agent table**: AGENTS.md supported agents table must list Codex CLI

---

## Security Analysis

| Risk | Relevance | Mitigation |
|------|-----------|------------|
| **A01 Broken Access Control** | Low — instruction files are read-only | N/A |
| **A05 Security Misconfiguration** | Medium — OpenCode global fallback could leak personal instructions/keys from `~/.claude/CLAUDE.md` | Document warning; recommend global OpenCode rules file |
| **A09 Security Logging** | Low | N/A |

---

## Scope Assessment

**Type**: Tactical (config files + docs update, sync script)
**Complexity**: Low-Medium
**Files affected**:
- `CLAUDE.md` — rewrite to sync workflow table from AGENTS.md, keep project-specific sections
- `GEMINI.md` — rewrite to sync workflow table from AGENTS.md, fix `/merge` → `/premerge`
- `AGENTS.md` — add Codex CLI to supported agents table
- `.aider.conf.yml` — add `read: AGENTS.md`
- `docs/SETUP.md` — add OpenCode global fallback warning + permissions section
- `scripts/sync-agent-instructions.sh` (new) — sync script to keep files consistent

**Branch**: `feat/agent-instructions-sync` (new) or extend `feat/agent-permissions`

---

## Sources

- [agents.md — supported agents list](https://agents.md/)
- [Windsurf AGENTS.md docs](https://docs.windsurf.com/windsurf/cascade/agents-md)
- [Kilo Code AGENTS.md docs](https://kilo.ai/docs/customize/agents-md)
- [OpenCode rules docs](https://opencode.ai/docs/rules/)
- [OpenCode GitHub issue #9282 — project + global files are combined](https://github.com/anomalyco/opencode/issues/9282)
- [Aider conventions docs](https://aider.chat/docs/usage/conventions.html)
- [Codex CLI config reference](https://developers.openai.com/codex/config-reference/)
- [Antigravity Getting Started — Google Codelabs](https://codelabs.developers.google.com/getting-started-google-antigravity)
- [Cursor forum — background agents AGENTS.md bug](https://forum.cursor.com/t/background-agents-do-not-load-agents-md/132446)

---

## Next Step

```bash
/plan agent-instructions-sync
```
