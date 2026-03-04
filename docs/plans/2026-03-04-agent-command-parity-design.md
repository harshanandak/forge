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
2. **OpenCode**: `.opencode/commands/` — 7 stage command files
3. **Cursor**: `.cursor/commands/` — 7 stage command files (beta v1.6+; distinct from `.cursor/rules/`)
4. **Cline**: `.clinerules/workflows/` — 7 stage workflow files (v3.13+; distinct from `.clinerules` rules)
5. **Windsurf**: `.windsurf/workflows/` — 7 stage workflow files
6. **Kilo Code**: `.kilocode/commands/` — 7 stage command files
7. **Roo Code**: `.roo/commands/` — 7 stage command files
8. **Continue**: `.continue/prompts/` — 7 `.prompt` files with `invokable: true`
9. **GitHub Copilot**: `.github/prompts/` — 7 `.prompt.md` files
10. **Codex CLI**: `.agents/skills/forge-workflow/SKILL.md` — skills system (best available; no project-level `/` commands)
11. **Aider**: `.aider.conf.yml` + AGENTS.md — natural language (no slash command support)
12. **All configs consistent**: Same 7-stage workflow, same command names (post-PR-50 = `/validate` not `/check`)
13. **Plugin catalog updated**: `lib/agents/*.plugin.json` — correct capabilities for all agents (Cursor `commands: true`, Cline `commands: true`, Codex `commands: false`)
14. **`forge check-agents` CLI command**: Verifies all agent configs are complete and consistent; ships as part of Forge CLI.

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

**Agent priority order** (true slash commands first, then best-effort):
1. Claude Code — already complete, verify after PR 50 merge
2. OpenCode — `.opencode/commands/*.md`
3. Cursor — `.cursor/commands/*.md` (beta since v1.6 — confirmed real slash commands)
4. Cline — `.clinerules/workflows/*.md` (added v3.13 — confirmed real slash commands)
5. Windsurf — `.windsurf/workflows/*.md`
6. Kilo Code — `.kilocode/commands/*.md`
7. Roo Code — `.roo/commands/*.md`
8. Continue — `.continue/prompts/*.prompt` (with `invokable: true`)
9. GitHub Copilot — `.github/prompts/*.prompt.md`
10. Codex CLI — `.agents/skills/forge-workflow/SKILL.md` (no `/` commands; uses `$skillname` or implicit)
11. Aider — `.aider.conf.yml` + AGENTS.md (natural language only)

**Build order**:
1. Research: confirm exact file format for each agent (especially Codex CLI, Windsurf, Kilo, Roo, Continue, Copilot)
2. Implement priority 2–8 (native command/workflow/prompt files)
3. Implement priority 9–11 (context-injection agents — update rules/context files)
4. Update plugin catalog (`lib/agents/*.plugin.json`) to reflect actual capabilities
5. Update AGENTS.md to be the consistent, authoritative cross-agent reference
6. Build `forge check-agents` CLI command — validates all agent configs in any project using Forge

---

## Constraints

- **UX parity**: User types `/plan`, `/dev`, `/validate`, `/ship`, `/review`, `/premerge`, `/verify` — same command names in every agent, same resulting behavior. The agent handles it natively or via context, but the UX is identical.
- **Context-injection agents must be actionable**: For Cursor native/Cline/Aider — config files must read as "when you see `/plan`, do X" not "here is documentation about X". Imperative, not descriptive.
- Command content must be consistent across all agents (same steps, same HARD-GATEs)
- No introducing new workflow logic — just adapting existing `.claude/commands/` content
- File formats must match each agent's actual spec (confirmed via research, not assumed)
- Ambiguity policy: Pause and ask user if any agent's format is unexpected

---

## Edge Cases

- **Codex CLI `/commands` in UI = built-in system commands only**: No project-level custom slash commands. Use Skills at `.agents/skills/forge-workflow/SKILL.md` — invoked with `$forge-workflow` or implicitly. The `/` menu shown in UI is not extensible per-project.
- **Cursor has TWO separate systems**: `.cursor/rules/*.mdc` = persistent context injected every prompt (NOT commands). `.cursor/commands/*.md` = true slash commands (beta v1.6+, triggered on-demand with `/`). We implement both.
- **Cline has TWO separate systems**: `.clinerules/*.md` = persistent rules. `.clinerules/workflows/*.md` = true slash commands (v3.13+). We implement workflows for commands.
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
