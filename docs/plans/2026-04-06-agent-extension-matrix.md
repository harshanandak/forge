# AI Coding Agent Extension/Customization Matrix (Early 2026)

## Capability Matrix

| Capability | Claude Code | GitHub Copilot | Cursor | Kilo Code | OpenCode | Codex CLI |
|---|---|---|---|---|---|---|
| **Hooks** | PreToolUse, PostToolUse, Stop hooks in `settings.json` (block/modify tool calls) | `.github/hooks/*.json` — shell commands at agent workflow points | No hooks system | No dedicated hooks | Plugin hooks: `tool.execute.before`, `tool.execute.after`, `session.compacting`, etc. | No hooks |
| **Subagent Spawning** | Agent tool spawns isolated subagents from `.claude/agents/*.md` | Built-in subagents (runtime, not user-configured); custom agents can delegate | No subagent spawning | Task tool invokes subagents; built-in `general` + `explore`; custom via `kilo.jsonc` or `.kilo/agents/*.md` | Built-in `general` + `explore` subagents; custom agents in `.opencode/agents/*.md` | No subagent spawning |
| **Skills** | `.claude/skills/<name>/SKILL.md` — on-demand loaded context | `.github/skills/<name>/SKILL.md` (also reads `.claude/skills/`, `.agents/skills/`) | No skills system | `.kilo/skills/<name>/SKILL.md` — Agent Skills spec; global + project + mode-specific | `.opencode/skills/` directory (follows Agent Skills spec) | No skills |
| **Commands** | `.claude/commands/*.md` (slash commands, deprecating in favor of skills) | `.github/prompts/*.prompt.md` (reusable prompt templates with variables) | No command files | `.kilo/commands/*.md` (slash commands with frontmatter: agent, model, subtask) | `.opencode/commands/*.md` or `command` in `opencode.json` (slash commands with `$ARGUMENTS`) | No commands |
| **Rules** | `.claude/rules/*.md` + `CLAUDE.md` (always-on, hierarchical) | `.github/copilot-instructions.md` (repo-wide) + `.github/instructions/*.instructions.md` (path-specific) + `AGENTS.md` | `.cursor/rules/*.mdc` (rule files with frontmatter for globs/always-on) | `.kilo/rules/` + custom instructions + `AGENTS.md` support | `AGENTS.md` at repo root + `~/.config/opencode/instructions.md` | `~/.codex/AGENTS.md` + `AGENTS.md` at repo root + per-directory `AGENTS.md` |
| **Plugin System** | Plugin architecture via `plugin.json`, skills, hooks, agents, commands in package | MCP servers; Copilot Extensions (GitHub Apps acting as agents) | MCP servers only | MCP servers; custom modes in `kilo.jsonc` | Full plugin API (JS/TS): `.opencode/plugins/` or npm packages; hooks, custom tools, themes | No plugin system |
| **Custom Agents** | `.claude/agents/*.md` with frontmatter (tools, model, prompt) | `.github/agents/AGENT-NAME.md` (repo) or org-level in `.github-private` repo | No custom agents | Custom agents in `kilo.jsonc` or `.kilo/agents/*.md` with mode/model/permissions | Custom agents in `.opencode/agents/*.md` or `opencode.json` with permissions | No custom agents |
| **Config Location** | `.claude/settings.json`, `CLAUDE.md`, `.claude/` directory tree | `.github/copilot-instructions.md`, `.github/instructions/`, `.github/hooks/`, `.github/agents/`, `.github/skills/`, `.github/prompts/` | `.cursor/rules/`, `.cursorrules` (legacy), Cursor Settings UI | `kilo.jsonc` (project or global), `.kilo/` directory tree | `opencode.json` (project), `~/.config/opencode/` (global), `.opencode/` directory tree | `~/.codex/AGENTS.md`, `codex.json` (model/provider config) |
| **MCP Support** | Yes (`.mcp.json`) | Yes (`mcp.json`, repo settings for cloud agent) | Yes (Cursor Settings > MCP) | Yes (in `kilo.jsonc`) | Yes (in `opencode.json`) | Yes |

## Key Takeaways

- **Most extensible**: OpenCode (full plugin API with JS/TS hooks) and Claude Code (hooks + agents + skills + plugin architecture)
- **Best enterprise model**: GitHub Copilot (org-level agents, path-specific instructions, cloud agent with hooks)
- **Fastest-growing**: Kilo Code now matches Claude Code's agent/skill/command model almost 1:1
- **Most minimal**: Codex CLI (AGENTS.md only, no hooks/skills/plugins/commands)
- **Cursor**: Still rules-only; no hooks, subagents, skills, or plugin system beyond MCP
- **Convergence**: All 6 agents now support AGENTS.md and MCP; Agent Skills spec is emerging as cross-agent standard
