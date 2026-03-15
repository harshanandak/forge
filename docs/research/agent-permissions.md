# Research: Per-Agent Permissions Configuration

**Feature slug**: `agent-permissions`
**Beads issue**: forge-bo2
**Date**: 2026-02-24

---

## Objective

Every AI agent supported by Forge has its own permission/auto-approval system for terminal commands and file operations. Currently Forge ships no default permission config for any agent, meaning developers hit approval prompts constantly for safe, routine commands (git status, ls, bun run, bd list, etc.).

**Goal**: Ship project-level permission config files for all supported agents so that safe commands auto-run out of the box, while destructive commands still require explicit approval.

---

## Codebase Analysis

### What already exists

| File | Agent | Status |
| ---- | ----- | ------ |
| `AGENTS.md` | Universal | ✅ Exists — workflow instructions only |
| `docs/SETUP.md` | All agents | ✅ Exists (635 lines) — no permissions section |
| `lib/agents/*.plugin.json` | 11 agents | ✅ All 11 plugin definitions exist |
| `.claude/settings.json` | Claude Code | ✅ Exists — project-level permissions present |
| `opencode.json` | Kilo/OpenCode | ❌ Missing |
| `.codex/config.toml` | Codex CLI | ❌ Missing |
| `.cursor/rules/permissions-guidance.mdc` | Cursor | ❌ Missing |

### Affected files

- `docs/SETUP.md` — add permissions section
- `opencode.json` — new file at project root
- `.codex/config.toml` — new file (directory must be created)
- `.cursor/rules/permissions-guidance.mdc` — new file (directory must be created)

### Integration points

- `docs/SETUP.md` has per-agent sections — permissions guidance slots naturally into each agent's section
- `.cursor/rules/` is referenced in `cursor.plugin.json` — adding a `.mdc` file there fits the existing pattern
- The `forge setup` command will need to be updated separately to copy these files to new projects (separate issue)

---

## Research Findings

### Agent Permission System Comparison

#### Claude Code — `.claude/settings.json`
- **Format**: JSON, `permissions.allow` array
- **Syntax**: `"Bash(git status:*)"` — command prefix with wildcard
- **Scope**: Project-level (committed) + global (`~/.claude/settings.json`) + local (gitignored)
- **Granularity**: Per-tool (Bash, Read, Edit, WebFetch, Skill, Task, MCP)
- **Evaluation**: First match in allow/deny wins
- **Status**: Already configured in this project's `.claude/settings.json`

#### Kilo Code + OpenCode — `opencode.json` (shared format)
- **Format**: JSON, `permission` object with nested patterns
- **Syntax**: `"git status *": "allow"` inside `bash` block
- **Scope**: Project root (project-level) OR `~/.config/kilo/opencode.json` (global)
- **Granularity**: bash, edit, external_directory, MCP, browser
- **Evaluation**: **Last matching rule wins** — put deny rules at the bottom
- **States**: `"allow"`, `"ask"`, `"deny"`
- **Sources**: [Kilo Code docs](https://kilo.ai/docs/features/auto-approving-actions), [OpenCode docs](https://opencode.ai/docs/permissions/)

#### OpenAI Codex CLI — `.codex/config.toml`
- **Format**: TOML
- **Syntax**: `approval_policy = "on-request"` + `sandbox_mode = "workspace-write"`
- **Scope**: `.codex/config.toml` (project) OR `~/.codex/config.toml` (global)
- **Granularity**: Policy-level (untrusted/on-request/never) + sandbox restrictions
- **States**: `untrusted` (approve all), `on-request` (agent decides), `never` (no prompts)
- **Best default**: `on-request` — agent uses built-in risk model, only asks when uncertain
- **Also supports**: `--full-auto` flag and `--yolo` (dangerous bypass)
- **Sources**: [Codex CLI config reference](https://developers.openai.com/codex/config-reference/)

#### Cursor — IDE Settings (YOLO Mode)
- **Format**: UI-only — configured in Cursor Settings > Features > Chat & Composer
- **Syntax**: `Bash(git status *)` in allow/deny lists (same format as Claude Code)
- **Scope**: IDE-level, not version-controlled — cannot be shipped as project file
- **Granularity**: Fine-grained per-command allow/deny lists
- **Approach for Forge**: Document recommended settings in `.cursor/rules/permissions-guidance.mdc`
- **Sources**: Cursor Settings UI

### Risk-Based Command Classification

| Risk Level | Commands | Default action |
| ---------- | -------- | -------------- |
| **Safe (read-only)** | git status/log/diff/branch, ls, cat, grep, find, pwd, which, bd list/show/stats | `allow` |
| **Safe (local write, reversible)** | git add, git commit, git stash, git checkout, bun/npm run, mkdir, touch, cp, mv | `allow` |
| **Medium (remote-affecting)** | git push, gh pr create, gh issue create | `allow` (intentional dev action) |
| **Careful (needs attention)** | git reset --hard, git rebase | `ask` |
| **Dangerous (destructive)** | rm -rf, git push --force, drop database | `deny` |

### Key Design Decisions

**Decision 1: Include `git push:*` in allow list**
- Reasoning: Developers push intentionally, constant prompting breaks flow
- Evidence: Volleyball project already allows it in settings.local.json
- Alternative: Keep as `ask` (rejected — too much friction for normal PRs)

**Decision 2: `on-request` not `never` for Codex CLI**
- Reasoning: `never` skips ALL prompts including network access and external edits; `on-request` lets the agent's risk model handle edge cases
- Evidence: Codex docs recommend `on-request` for interactive development
- Alternative: `never` for power users (can be documented as option)

**Decision 3: Documentation-only for Cursor**
- Reasoning: Cursor permissions are IDE-level settings, not project files — nothing to commit
- Evidence: No `settings.json`-like project file exists for Cursor
- Alternative: None — this is a platform limitation

---

## TDD Test Scenarios

Since these are config files (not code), traditional unit tests don't apply. Verification is manual:

1. **opencode.json validity** — JSON parses without errors; `git status` and `bd list` run without prompt in Kilo Code or OpenCode
2. **.codex/config.toml validity** — TOML parses correctly; Codex CLI reads file at startup
3. **.cursor/rules/ presence** — File appears in Cursor's Rules panel; content is accurate
4. **docs/SETUP.md section** — Section is readable, links work, global config snippet is copy-pasteable and correct

---

## Security Analysis

### OWASP Top 10 Relevance

| Risk | Relevance | Mitigation |
| ---- | --------- | ---------- |
| **A01 Broken Access Control** | Medium — overly broad allow lists could let agents run unintended commands | Explicit deny rules for `rm -rf`, `git push --force`, `git reset --hard` |
| **A05 Security Misconfiguration** | Medium — shipping overly permissive defaults would be misconfigured | Conservative defaults: `approval_policy = "on-request"` |
| **A09 Security Logging** | Low — agent commands aren't logged by these configs | Mitigated by git history and Beads tracking |

### Agent-Specific Security Notes

- **opencode.json**: Deny rules must be at the bottom (last match wins) — putting them first would be ineffective
- **Codex CLI**: `sandbox_mode = "workspace-write"` prevents file access outside project root — keep this
- **Never ship**: `--dangerously-bypass-approvals-and-sandbox` (Codex) or global `"*": "allow"` (opencode.json)

---

## Scope Assessment

**Type**: Tactical (config files + docs update, no business logic)
**Complexity**: Low — all config formats researched, no code changes needed
**Parallelization**: All 3 config files can be created simultaneously; docs/SETUP.md update is sequential after
**Estimated files**: 4 new files, 1 modified

**Branch**: `feat/agent-permissions`

---

## Sources

- [Kilo Code - Auto-Approving Actions](https://kilo.ai/docs/features/auto-approving-actions)
- [OpenCode - Permissions](https://opencode.ai/docs/permissions/)
- [Codex CLI - Config Reference](https://developers.openai.com/codex/config-reference/)
- Forge project codebase analysis (2026-02-24)

---

## Next Step

```bash
/plan agent-permissions
```
