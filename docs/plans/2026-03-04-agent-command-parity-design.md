# Design: Agent Command Parity

- **Slug**: agent-command-parity
- **Date**: 2026-03-04
- **Status**: Draft

---

## Purpose

Every major AI coding agent (Claude Code, Cursor, Codex CLI, OpenCode, Cline, Windsurf, Aider, Kilo, Roo, Continue, Copilot) should have the full Forge workflow implemented using that agent's **native mechanism** — whether that's slash commands, workflow files, rules/context injection, or prompt files.

Currently only Claude Code has complete command support. Cursor/Cline/Codex/OpenCode/Windsurf have partial or no implementation. Stage count is inconsistent across files (7 vs 9 stages). The `check → validate` rename exists only in feat/superpowers-gaps (PR 50).

**Critically**: Since Forge is used as a framework across many projects, manually cross-checking every agent after each change is not viable. This feature also ships `forge check-agents` — a CLI command any project can run to automatically verify all agent configs are complete and consistent. This becomes part of every project's `/check` stage.

---

## Success Criteria

1. **Claude Code**: Already complete — verify stays correct after PR 50 merge
2. **Codex CLI**: Native `/commands` implemented for all 7 workflow stages
3. **OpenCode**: `.opencode/commands/` populated with all 7 stage command files
4. **Windsurf**: `.windsurf/workflows/` populated with all stage workflow files
5. **Kilo Code**: `.kilocode/workflows/` populated
6. **Cursor**: `.cursorrules` + `.cursor/rules/*.mdc` complete and accurate, `.cursor/skills/` populated
7. **Cline/Roo**: `.clinerules` updated, `.cline/skills/` and `.roo/commands/` populated
8. **Aider**: `.aider.conf.yml` + AGENTS.md sufficient
9. **Continue**: `.continue/prompts/` populated
10. **GitHub Copilot**: `.github/copilot-instructions.md` + `.github/prompts/` populated
11. **All configs consistent**: Same 7-stage workflow, same command names (post-PR-50 = `/validate` not `/check`)
12. **Plugin catalog updated**: `lib/agents/*.plugin.json` reflects actual capabilities (e.g., Codex CLI `commands: true`)
13. **`forge check-agents` CLI command**: Runs automatically in any project using Forge; verifies all agent configs are complete, consistent, and match their plugin spec. Ships as part of `forge` CLI.

---

## Out of Scope

- Inventing new workflow stages — the 7-stage workflow is frozen pending PR 50 merge
- Implementing the workflow logic itself (commands already exist in `.claude/commands/`)
- Cross-agent testing infrastructure (separate feature)
- Merging PR 50 (user does that manually)

---

## Dependencies

- **PR 50 must merge first** (`feat/superpowers-gaps`) — it contains `check → validate` rename and other fixes; all agent files in this plan use `/validate` naming
- This work branches from master **after** PR 50 merges

---

## Approach Selected

**Native mechanism per agent**: Each agent gets the files appropriate to its actual command system. The source of truth for command content is `.claude/commands/*.md` (which will have `validate.md` post-PR-50). All other agent files are adapters of this source.

**Agent priority order** (most powerful native command support first):
1. Claude Code — already complete, verify after PR 50 merge
2. OpenCode — native commands (`commands: true`, `.opencode/commands/`)
3. Codex CLI — native `/commands` (confirmed by UI screenshot; format TBD from research)
4. Windsurf — workflow files (`.windsurf/workflows/`)
5. Kilo Code — workflow files (`.kilocode/workflows/`)
6. Roo Code — command files (`.roo/commands/`)
7. Continue — prompt files (`.continue/prompts/`)
8. GitHub Copilot — prompt files (`.github/prompts/`)
9. Cursor — context injection only (`.cursorrules` + `.cursor/rules/*.mdc` + skills)
10. Cline — context injection (`.clinerules` + skills)
11. Aider — config + AGENTS.md context

**Build order**:
1. Research: confirm exact file format for each agent (especially Codex CLI, Windsurf, Kilo, Roo, Continue, Copilot)
2. Implement priority 2–8 (native command/workflow/prompt files)
3. Implement priority 9–11 (context-injection agents — update rules/context files)
4. Update plugin catalog (`lib/agents/*.plugin.json`) to reflect actual capabilities
5. Update AGENTS.md to be the consistent, authoritative cross-agent reference
6. Build `forge check-agents` CLI command — validates all agent configs in any project using Forge

---

## Constraints

- Command content must be consistent across all agents (same steps, same HARD-GATEs)
- No introducing new workflow logic — just adapting existing `.claude/commands/` content
- File formats must match each agent's actual spec (confirmed via research, not assumed)
- `ambiguity policy`: Pause and ask user if any agent's format is unexpected

---

## Edge Cases

- **Codex CLI `/commands` in UI = deprecated prompts (global only)**: Project-level support is via Skills at `.agents/skills/`. Use skills system, not deprecated prompts directory.
- **Cursor commands are Claude Code extension commands**: Users running Claude Code extension inside Cursor already get all `.claude/commands/`. No separate Cursor command files needed — focus on `.cursorrules` + `.cursor/rules/*.mdc` for native Cursor AI users.
- **Continue uses `.prompt` extension, not `.md`**: `invokable: true` frontmatter required to enable slash command.
- **Copilot uses `.prompt.md` double extension**: File must be in `.github/prompts/`.
- **Some agents don't support hooks**: Windsurf (`.windsurf/hooks.json`) and Copilot (`.github/hooks/*.json`, Preview) support hooks. Codex CLI, Roo, Kilo, Continue do not. Only implement hooks for agents confirmed above.
- **PR 50 not merged when starting /dev**: Do not start /dev until PR 50 is merged — all files use `/validate`, not `/check`
- **Plugin.json out of sync**: Multiple plugin files have wrong capability flags — `cursor.plugin.json` says `commands: false` (correct — Cursor uses extension), Codex CLI plugin is missing entirely, hooks flags are all unset.

---

## Ambiguity Policy

If any agent's native command format is discovered to differ from what was researched, **pause and ask the user** before implementing. Document the finding and proposed approach, then wait for approval.

---

## Technical Research

### Agent Command/Workflow File Formats (Confirmed)

| Agent | Command Dir | File Extension | Key Frontmatter | Hooks |
|-------|------------|----------------|-----------------|-------|
| Claude Code | `.claude/commands/` | `.md` | `description:` | `.claude/settings.json` PreToolUse/PostToolUse |
| OpenCode | `.opencode/commands/` | `.md` | `description`, `agent`, `model`, `subtask` | Plugin JS/TS: 25+ events |
| Windsurf | `.windsurf/workflows/` | `.md` | None required | `.windsurf/hooks.json`: 12 events |
| Kilo Code | `.kilocode/workflows/` | `.md` | None | None |
| Roo Code | `.roo/commands/` | `.md` | `description`, `argument-hint`, `mode` | None |
| Continue | `.continue/prompts/` | `.prompt` | `name`, `description`, `invokable: true` | None |
| Copilot | `.github/prompts/` | `.prompt.md` | `name`, `description`, `agent`, `model`, `tools` | `.github/hooks/*.json`: 8 events (Preview) |
| Codex CLI | `.agents/skills/<name>/SKILL.md` | `SKILL.md` | `name`, `description` | None shipped |
| Cursor | Via Claude Code extension (`.claude/commands/`) | — | — | — |
| Cline | `.clinerules` context only | — | — | — |
| Aider | `.aider.conf.yml` + AGENTS.md | — | — | — |

### OWASP Top 10 Analysis

This feature writes config/instruction files — no user input processing, no auth, no network calls from config files themselves. Risk surface is minimal:

- **A01 Broken Access Control**: N/A — no access control in config files
- **A02 Cryptographic Failures**: N/A
- **A03 Injection**: Low risk — hook scripts run shell commands. Mitigate: all hook scripts in `.windsurf/hooks.json` and `.github/hooks/*.json` use hardcoded paths, no user input interpolated.
- **A05 Security Misconfiguration**: Moderate — agent permission configs (opencode.json, `.codex/config.toml`) must not over-grant. Mitigate: follow existing deny/ask/allow patterns established in current configs.
- **A08 Software and Data Integrity**: Low — config files are checked into git, integrity protected by version control.
- **Others (A04, A06, A07, A09, A10)**: Not applicable to static config files.

### TDD Test Scenarios (for `forge check-agents`)

1. **Happy path**: Project with all agent dirs populated → `forge check-agents` exits 0, prints "All agents: OK"
2. **Missing command file**: Project missing `.opencode/commands/validate.md` → exits non-zero, prints which file is missing for which agent
3. **Inconsistent stage count**: `.windsurfrules` says 9 stages, plugin says 7 → check flags inconsistency
4. **Unknown agent format in plugin**: plugin.json references directory that doesn't exist → check warns, doesn't error (agent may not be installed)
5. **Wrong file extension**: `.continue/prompts/validate.md` instead of `validate.prompt` → check flags extension error

### Sources

- [OpenAI Codex CLI Skills](https://developers.openai.com/codex/skills/)
- [OpenCode Commands](https://opencode.ai/docs/commands/)
- [Windsurf Workflows](https://docs.windsurf.com/windsurf/cascade/workflows)
- [Windsurf Hooks](https://docs.windsurf.com/windsurf/cascade/hooks)
- [Kilo Code Workflows](https://kilo.ai/docs/customize/workflows)
- [Roo Code Commands](https://docs.roocode.com/features/slash-commands)
- [Continue Prompt Files](https://docs.continue.dev/customize/deep-dives/prompts)
- [GitHub Copilot Prompts](https://code.visualstudio.com/docs/copilot/customization/prompt-files)
- [GitHub Copilot Hooks](https://code.visualstudio.com/docs/copilot/customization/hooks)
