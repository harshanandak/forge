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

**Build order**:
1. Research phase: confirm exact command format for each agent (especially Codex CLI `/` commands)
2. Implement agents with native command files first (Codex, OpenCode, Windsurf, Kilo, Roo, Continue, Copilot)
3. Implement context-injection agents (Cursor, Cline, Aider) — update their rules/context files
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

- **Codex CLI command format unknown**: Research before implementing — screenshot shows `/ for commands` but format is TBD
- **Some agents don't support hooks**: Only implement hooks for agents that actually support them (confirmed per-agent)
- **PR 50 not merged when starting /dev**: Do not start /dev until PR 50 is merged — all files use `/validate`, not `/check`
- **Plugin.json out of sync**: `cursor.plugin.json` currently says `commands: false` but Codex plugin may be missing entirely — update all to match reality

---

## Ambiguity Policy

If any agent's native command format is discovered to differ from what was researched, **pause and ask the user** before implementing. Document the finding and proposed approach, then wait for approval.

---

## Technical Research

*(To be filled in Phase 2)*
