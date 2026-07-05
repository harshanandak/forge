# Design: Command Creator & Eval

- **Slug**: command-creator-and-eval
- **Date**: 2026-03-10
- **Status**: Draft
- **Branch**: feat/command-creator-and-eval
- **Worktree**: .worktrees/command-creator-and-eval

---

## Purpose

Forge ships 11 slash commands (`.claude/commands/*.md`) and 6 skills (`skills/*/SKILL.md`). Currently there is:
- **No way to test commands** — HARD-GATE enforcement, dead references, cross-command contracts are unchecked
- **No way to test skills** — trigger accuracy and output quality are unmeasured
- **No automated sync** — 8 agents each need adapted command files, but changes to canonical commands require manual propagation
- **No improvement loop** — when a command or skill has issues, fixing is ad-hoc with no before/after measurement

Real bugs exist today: `/status` references `openspec list` (removed), `/rollback` still says 9 stages, `GEMINI.md` has `/merge` instead of `/premerge`. These are caught by humans reading files, not by any automated check.

**Goal**: Ship infrastructure to validate, sync, and iteratively improve both commands and skills — with a one-source-of-truth sync mechanism so one file change updates all agents.

---

## Success Criteria

### PR-A: Static Command Validator + Sync Infrastructure
1. `forge check-agents` CLI command exists and passes on clean repo
2. Static validator catches: dead references (e.g., `openspec list`), stale stage names (`/check` vs `/validate`), missing HARD-GATE blocks, inconsistent stage counts
3. Cross-command contract tests verify: /plan output matches /dev input expectations, /dev output matches /validate expectations, etc.
4. `scripts/sync-commands.js` reads canonical `.claude/commands/*.md` → generates agent-specific adapter files for all 8 supported agents
5. `forge check-agents --sync-check` verifies all agent files are in sync with canonical source
6. Works on Windows (bash/Git Bash compatible)

### PR-B: Command Improvement Loop (Scope B → C)
1. Grader agent (adapted from skill-creator) evaluates command execution transcripts against expectations
2. `run_eval.sh` runs a command in a disposable worktree, captures transcript, grades output
3. At least 3 eval scenarios per command (happy path, error path, edge case)
4. First targets: `/status` and `/validate` (simplest to eval — deterministic output)
5. `improve_command.py` (Scope C): analyzes failures, proposes command rewrites, re-tests, compares before/after
6. User approval gate before any command modification is applied

### PR-C: Skill Optimization
1. Eval loop runs on all 6 skills in `skills/` using installed skill-creator plugin patterns
2. Trigger accuracy measured: does Claude invoke the skill when it should? Does it NOT invoke when it shouldn't?
3. At least 5 test queries per skill (3 should-trigger, 2 should-not-trigger)
4. Description improvement loop with train/test split (60/40) to prevent overfitting
5. Before/after benchmark comparison for each skill

---

## Out of Scope

- Creating new commands or skills (only testing/improving existing ones)
- Cross-agent behavioral testing (testing if Cursor/OpenCode/etc. actually execute commands correctly — that's runtime testing, not config validation)
- Merging forge-2w3 or forge-ctc (separate work streams)
- Modifying the 7-stage workflow itself

---

## Dependencies

```
forge-ctc (in_progress) ← stale ref cleanup, running in parallel session
    ↓ blocks
forge-2w3 (in_progress) ← agent command parity (70+ adapter files)
    ↓ blocks
forge-agr ← fix global CLAUDE.md

PR-A ← no blockers, can start now
    ↓ enhances
forge-2w3 ← sync script makes adapter generation trivial

PR-B ← depends on PR-A (uses validator infrastructure)
PR-C ← no blockers, parallel with everything
```

**Ship order**: PR-A and PR-C ship first (no deps). PR-B ships after PR-A. forge-2w3 uses PR-A's sync script when unblocked.

---

## Approach Selected

### Architecture: One Source of Truth + Adapter Sync

**Canonical source**: `.claude/commands/*.md` (already exists, 11 files)

**Sync mechanism**: `scripts/sync-commands.js` — reads each canonical command and generates agent-specific files with correct frontmatter, extension, and directory path.

Why `.claude/commands/` stays canonical (not a new `commands/` dir):
- Already exists with full content
- Claude Code is the primary development agent
- Moving would break existing workflows for zero benefit

**Adapter transforms per agent**:

| Agent | Directory | Extension | Frontmatter Transform | Tier |
|-------|-----------|-----------|----------------------|------|
| Claude Code | `.claude/commands/` | `.md` | None (canonical) | 1 |
| Cursor | `.cursor/skills/<name>/` | `.md` | Strip all frontmatter (migrated from commands to skills in v2.4+) | 1 |
| Cline | `.clinerules/workflows/` | `.md` | Strip all frontmatter | 1 |
| OpenCode | `.opencode/commands/` | `.md` | Keep `description:` | 1 |
| GitHub Copilot | `.github/prompts/` | `.prompt.md` | Add `name:`, `description:`, `tools:` | 1 |
| Kilo Code | `.kilocode/workflows/` | `.md` | Keep `description:`, add `mode: code` | 2 |
| Roo Code | `.roo/commands/` | `.md` | Keep `description:`, add `mode: code` | 2 |
| Codex | `.codex/skills/<name>/` | `SKILL.md` | Single combined file (special case) | 2 |

**Tier 1** (5 agents): Full workflow — commands + PreToolUse hooks + MCP + subagents. Can enforce HARD-GATEs.
**Tier 2** (3 agents): Partial — commands + MCP + subagents, but no PreToolUse hooks. Commands work as prompts but can't enforce gates.

**Dropped agents** (with rationale):
- Antigravity (Google): Not in AGENTS.md, not actively maintained (PR #54)
- Windsurf: Dropped in PR #54
- Continue: CLI still in alpha, no hooks, no in-conversation subagents
- Blackbox AI: No custom command directory, no hooks, no third-party MCP support

### Static Validator: grep-based, no AI runtime

Pattern checks (all regex/grep):
1. **Dead references**: Scan for strings that reference removed features (`openspec`, `/merge`, `/check` as stage name)
2. **HARD-GATE structure**: Every command that claims HARD-GATEs has matching open/close blocks
3. **Stage count consistency**: All files agree on 7 stages
4. **Cross-command contracts**: /plan mentions output files that /dev expects as input
5. **Sync drift**: Compare canonical vs adapted files (content hash minus frontmatter)

### Behavioral Eval: Adapted from skill-creator

Reuse from skill-creator plugin (90% compatible):
- **Grader agent** (`agents/grader.md`): evaluates transcripts against assertions
- **Schemas** (`references/schemas.md`): `evals.json`, `grading.json` adapted for commands
- **Viewer**: HTML report generation

New for commands:
- **Disposable worktree execution**: Each eval runs `claude -p "/command-name" --output-format stream-json` inside a temp worktree
- **HARD-GATE assertion type**: "Did the command stop when the gate condition was unmet?"
- **Contract assertions**: "Does /plan's output contain a task list file that /dev would find?"

### Claude CLI Eval Execution (Research Findings)

**Invocation**: `claude -p "/command" --output-format stream-json --verbose --no-session-persistence --max-turns N`

**Stream-json output**: NDJSON (one JSON object per line). Key event types:
- `assistant` — complete message with `content[]` array (text + tool_use blocks)
- `stream_event` — incremental events (content_block_start/delta/stop)
- `result` — final result when agent finishes

**Detecting tool calls**: Parse `assistant` events → `content[].type == "tool_use"` → `name` + `input`

**Windows compatibility**: skill-creator uses `select.select()` (Unix-only). **Fix**: Use threading-based reader with `queue.Queue` for portable pipe reading.

**Critical env var**: Must strip `CLAUDECODE` from subprocess env to allow nested `claude -p` calls.

**Built-in worktree**: `claude --worktree <name>` creates disposable worktree automatically. Auto-cleaned if no changes. Alternative to manual `git worktree add`.

**Eval set format** (adapted from skill-creator):
```json
[
  {"command": "/status", "scenario": "clean_repo", "assertions": ["lists beads", "shows branch"]},
  {"command": "/validate", "scenario": "failing_tests", "assertions": ["reports test failures", "does NOT declare success"]}
]
```

### Improvement Loop (Scope C)

Adapted from skill-creator's `improve_description.py`:
- Analyze eval failures
- Use Claude with extended thinking to propose command rewrites
- Re-run evals on proposed rewrite
- Compare before/after scores
- **User approval gate** before applying any change (never auto-modify)

---

## Constraints

- **Windows compatible**: All scripts must work in Git Bash on Windows
- **No `select.select()` on pipes**: skill-creator's `run_eval.py` uses this (Unix-only) — our adaptation must use subprocess with timeout instead
- **User approval for modifications**: Scope C improvement loop NEVER auto-applies changes
- **Deterministic-first targets**: Start with commands that have measurable output (/status, /validate) before attempting subjective ones (/plan, /dev)
- **No new dependencies**: Use existing tools (bun, bash, gh CLI, claude CLI)

---

## Edge Cases

1. **Command references skill that doesn't exist**: /plan references `parallel-web-search` — validator should verify the skill exists in `skills/`
2. **Circular cross-command deps**: /review references /validate which references /dev — contract checker must handle cycles
3. **Agent doesn't support all 7 commands**: Some agents may only get a subset — sync script reads agent capabilities from `lib/agents/*.plugin.json`
4. **Frontmatter extraction fails**: Canonical command has non-standard frontmatter — sync script should error clearly, not silently produce broken files
5. **Worktree already exists during eval**: Eval creates temp worktrees — must handle cleanup on failure and concurrent runs
6. **Cursor skills migration**: Cursor v2.4+ uses `.cursor/skills/` not `.cursor/commands/` — sync script must generate skills directory structure, not flat files

---

## Ambiguity Policy

**One source of truth resolves ambiguity**: When there's a question about what a command should do, the canonical `.claude/commands/*.md` file is authoritative. All adapted files must match.

For implementation decisions:
- **Low-risk** (formatting, file organization): Make reasonable choice, document in commit message
- **Scope-changing** (new assertion types, changing which commands to target): Pause and ask user

---

## Beads Integration

### New Issues to Create

| ID | Title | Type | Priority | Depends On |
|----|-------|------|----------|------------|
| forge-jfw | PR-A: Static command validator + sync infrastructure | feature | P1 | None |
| forge-agp | PR-B: Command behavioral eval + improvement loop | feature | P2 | forge-jfw |
| forge-1jx | PR-C: Skill optimization via eval loop | feature | P2 | None |

### Existing Issues Affected

| ID | How Affected |
|----|-------------|
| forge-2w3 | PR-A's sync script replaces manual adapter creation (Tasks 3-11) |
| forge-30k | PR-A's static validator overlaps with doc link checker — may merge or share infra |
| forge-ctc | Must complete before forge-2w3 can use sync script |

---

## Technical Research

### Confirmed Agent Command Formats (8 agents)

| Agent | Directory | Extension | Required Frontmatter | Optional Frontmatter | Source |
|-------|-----------|-----------|---------------------|---------------------|--------|
| Claude Code | `.claude/commands/` | `.md` | `description` | — | Official docs |
| Cursor | `.cursor/skills/<name>/` | `.md` | **None** (skills are plain markdown) | — | [cursor.com/docs/context/commands](https://cursor.com/docs/context/commands) |
| Cline | `.clinerules/workflows/` | `.md` | None | `description`, `author`, `version`, `globs`, `tags` | [docs.cline.bot/features/slash-commands/workflows](https://docs.cline.bot/features/slash-commands/workflows) |
| OpenCode | `.opencode/commands/` | `.md` | `description` | `agent`, `model`, `subtask` | [opencode.ai/docs/commands](https://opencode.ai/docs/commands/) |
| GitHub Copilot | `.github/prompts/` | `.prompt.md` | None strictly | `name`, `description`, `agent`, `tools`, `model` | [code.visualstudio.com/docs/copilot/customization/prompt-files](https://code.visualstudio.com/docs/copilot/customization/prompt-files) |
| Kilo Code | `.kilocode/workflows/` | `.md` | `description` | `arguments`, `mode`, `model` | [kilo.ai/docs/features/slash-commands/workflows](https://kilo.ai/docs/features/slash-commands/workflows) |
| Roo Code | `.roo/commands/` | `.md` | `description` | `argument-hint`, `mode` | [docs.roocode.com/features/slash-commands](https://docs.roocode.com/features/slash-commands) |
| Codex | `.codex/skills/<name>/` | `SKILL.md` | `name`, `description` | — | [developers.openai.com/codex/skills](https://developers.openai.com/codex/skills/) |

**Key findings:**
- Cursor migrated from `.cursor/commands/` to `.cursor/skills/` in v2.4+ (use `/migrate-to-skills`)
- Cursor is the only agent with NO frontmatter support — sync strips everything
- `description` is the universal common field across all agents that support frontmatter
- 8 agents total (dropped: Antigravity, Windsurf, Continue, Blackbox AI)
- No documented content length limits for any agent

### Agent Capability Tiers (New Research)

Full capability matrix verified from official documentation (March 2026):

| Capability | Claude Code | Cursor | Cline | OpenCode | Copilot | Kilo Code | Roo Code | Codex |
|---|---|---|---|---|---|---|---|---|
| **Custom commands** | `.claude/commands/` | `.cursor/skills/` | `.clinerules/workflows/` | `.opencode/commands/` | `.github/prompts/` | `.kilocode/workflows/` | `.roo/commands/` | Skills (`SKILL.md`) |
| **PreToolUse hooks** | Yes | Yes (can deny) | Yes (can cancel) | Yes (plugin system) | Yes (`.github/hooks/`) | No (permission config only) | No (file-event hooks only) | No (approval modes only) |
| **Subagents** | Yes (full) | Yes (8 parallel) | Yes (read-only) | Yes (`@general`, `@explore`) | Yes (sequential IDE, parallel `/fleet`) | Yes (Orchestrator + 4 parallel) | Yes (Orchestrator, sequential) | Yes (worktree-based, experimental) |
| **MCP (3rd party)** | Yes | Yes | Yes + Marketplace | Yes (local + remote + OAuth) | Yes | Yes + Marketplace | Yes + Marketplace | Yes |
| **Always-on rules** | `.claude/rules/` | `.cursor/rules/*.mdc` | `.clinerules/*.md` | `AGENTS.md` | `.github/instructions/` | `.kilocode/rules/` + `AGENTS.md` | `.roo/rules/` | `AGENTS.md` |
| **Custom modes** | No | No | No | Yes (plan, build) | No | Yes (5 built-in + custom) | Yes (5 built-in + custom) | No |
| **Skills** | Yes | Yes | No | Yes (`SKILL.md`) | No | Yes (`SKILL.md`) | Yes | Yes (`SKILL.md`) |

**Tier 1 — Full workflow enforcement** (commands + hooks + MCP): Claude Code, Cursor, Cline, OpenCode, GitHub Copilot
**Tier 2 — Partial workflow** (commands + MCP, no hook enforcement): Kilo Code, Roo Code, Codex

**Sources**: cursor.com/docs, docs.cline.bot, opencode.ai/docs, docs.github.com, kilo.ai/docs, docs.roocode.com, developers.openai.com/codex

### Existing Linting Tools (Critical Discovery)

| Tool | Scope | Install | Rules |
|------|-------|---------|-------|
| **agnix** | Multi-agent (10+ formats) | `npx agnix .` or `cargo install agnix-cli` | 231 rules from official specs. CLAUDE.md, AGENTS.md, SKILL.md, hooks, MCP, Cursor rules, Copilot prompts, Cline rules, Windsurf rules. Supports `--fix`, `--strict`, watch mode, JSON/SARIF output. |
| **cclint** | Claude Code only | `npx @carlrannaberg/cclint` | Agent frontmatter, command definitions, tool permissions, hooks, CLAUDE.md best practices. Custom Zod schemas. |

**Impact on PR-A**: Instead of building `forge check-agents` from scratch, evaluate using **agnix** as the base validator and adding Forge-specific checks on top (cross-command contracts, sync drift, dead Forge-specific references like `openspec`, stage count consistency).

### DRY Check Results — Existing Reusable Code

| File | What It Does | Reuse For |
|------|-------------|-----------|
| `test/structural/command-files.test.js` | Validates command files (existence, truncation, HARD-GATE counts, balanced code blocks) | **Extend** with frontmatter validation, dead ref checks, sync drift |
| `lib/plugin-manager.js` | Loads/validates `lib/agents/*.plugin.json` with schema validation | Agent capability detection for sync script |
| `scripts/behavioral-judge.sh` | Frontmatter extraction via grep, `check-lock-sync` subcommand | Pattern for YAML parsing in sync script |
| `lib/agents-config.js` | Agent metadata generation | Template for sync script structure |
| `.github/workflows/detect-command-file-changes.yml` | CI trigger on `.claude/commands/**` changes | Trigger sync validation in CI |
| `.github/workflows/check-agentic-workflow-sync.yml` | MD ↔ LOCK.yml sync validation | Model for cross-file validation |

**DRY conclusion**: PR-A's static validator should extend `test/structural/command-files.test.js`, not create a new file. The sync script and cross-reference checker are genuinely new.

### OWASP Top 10 Analysis

| Category | Risk | Applies? | Mitigation |
|----------|------|----------|------------|
| A01 Broken Access Control | Sync overwrites user customizations | Low | Warn before overwriting modified files; `--force` flag required |
| A02 Cryptographic Failures | — | N/A | — |
| A03 Injection | `run_eval.sh` passes command names to shell | **Medium** | Validate names against `[a-z-]+` regex; quote all variables |
| A04 Insecure Design | Improvement loop could propose bad content | Low | User approval gate; diff shown for review |
| A05 Security Misconfiguration | Sync generates agent permission configs | **Medium** | Follow existing deny/ask/allow patterns; never auto-allow dangerous ops |
| A06-A07 | — | N/A | — |
| A08 Data Integrity | Generated files committed to git | Low | Git provides integrity; sync includes content hash verification |
| A09 Logging | Eval transcripts contain full conversations | Low | Store in `.forge/eval-logs/` (gitignored); warn on env var detection |
| A10 SSRF | — | N/A | — |

### TDD Test Scenarios

**PR-A Static Validator (extend `test/structural/command-files.test.js`):**
1. Happy path: clean repo with all commands → all checks pass
2. Dead reference: `/status` contains `openspec list` → test catches it
3. Sync drift: `.cursor/commands/plan.md` content differs from canonical → `sync-check` test flags it
4. Missing HARD-GATE: command claims gate but has no closing block → test warns
5. Stage count: all files agree on 7 stages → pass; file says 9 → fail
6. Cross-command contract: /plan output mentions task file → /dev input expects same file → pass

**PR-B Behavioral Eval:**
1. Happy path: `/status` in clean worktree → grader confirms expected output sections
2. HARD-GATE enforcement: `/plan` on non-master branch → grader confirms it stopped
3. Cross-command contract: /plan creates task file → /dev finds it
4. Error path: `/validate` with failing tests → grader confirms it reports failures

**PR-C Skill Optimization:**
1. Trigger accuracy: `parallel-web-search` triggers on "search for recent news about X"
2. Non-trigger: `parallel-web-search` does NOT trigger on "read this file"
3. Improvement: description rewrite improves trigger accuracy on test set (60/40 split)
4. No regression: improved description doesn't trigger on previously-correct non-trigger queries

---

## Sources

- [Anthropic skill-creator plugin](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/skill-creator)
- [Agent command parity design doc](docs/plans/2026-03-04-agent-command-parity-design.md)
- [Agent instructions sync research](docs/research/agent-instructions-sync.md)
- [skills.sh portable runner pattern](skills/)
- [agnix — multi-agent linter](https://github.com/agent-sh/agnix)
- [cclint — Claude Code linter](https://github.com/carlrannaberg/cclint)
- [OpenCode commands docs](https://opencode.ai/docs/commands/)
- [Cursor commands docs](https://cursor.com/docs/context/commands)
- [Cline workflows docs](https://docs.cline.bot/features/slash-commands/workflows)
- [Kilo Code workflows](https://kilo.ai/docs/features/slash-commands/workflows)
- [Kilo Code skills](https://kilo.ai/docs/customize/skills)
- [Roo Code slash commands](https://docs.roocode.com/features/slash-commands)
- [Roo Code hooks](https://github.com/RooCodeInc/Roo-Code/discussions/6147)
- [GitHub Copilot prompt files](https://code.visualstudio.com/docs/copilot/customization/prompt-files)
- [GitHub Copilot hooks](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-hooks)
- [Codex skills](https://developers.openai.com/codex/skills/)
- [Codex MCP](https://developers.openai.com/codex/mcp/)
- [Cursor skills (migrated from commands)](https://cursor.com/docs/context/commands)
- [Cursor hooks](https://cursor.com/docs/hooks)
- [Cline hooks](https://docs.cline.bot/features/hooks)
- [OpenCode plugins/hooks](https://opencode.ai/docs/plugins)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code headless mode](https://code.claude.com/docs/en/headless)
