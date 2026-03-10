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
- **No automated sync** — 11 agents each need adapted command files, but changes to canonical commands require manual propagation
- **No improvement loop** — when a command or skill has issues, fixing is ad-hoc with no before/after measurement

Real bugs exist today: `/status` references `openspec list` (removed), `/rollback` still says 9 stages, `GEMINI.md` has `/merge` instead of `/premerge`. These are caught by humans reading files, not by any automated check.

**Goal**: Ship infrastructure to validate, sync, and iteratively improve both commands and skills — with a one-source-of-truth sync mechanism so one file change updates all agents.

---

## Success Criteria

### PR-A: Static Command Validator + Sync Infrastructure
1. `forge check-agents` CLI command exists and passes on clean repo
2. Static validator catches: dead references (e.g., `openspec list`), stale stage names (`/check` vs `/validate`), missing HARD-GATE blocks, inconsistent stage counts
3. Cross-command contract tests verify: /plan output matches /dev input expectations, /dev output matches /validate expectations, etc.
4. `scripts/sync-commands.sh` reads canonical `.claude/commands/*.md` → generates agent-specific adapter files for all 11 supported agents
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

**Sync mechanism**: `scripts/sync-commands.sh` — reads each canonical command and generates agent-specific files with correct frontmatter, extension, and directory path.

Why `.claude/commands/` stays canonical (not a new `commands/` dir):
- Already exists with full content
- Claude Code is the primary development agent
- Moving would break existing workflows for zero benefit

**Adapter transforms per agent**:

| Agent | Directory | Extension | Frontmatter Transform |
|-------|-----------|-----------|----------------------|
| Claude Code | `.claude/commands/` | `.md` | None (canonical) |
| OpenCode | `.opencode/commands/` | `.md` | Keep `description:` |
| Cursor | `.cursor/commands/` | `.md` | Strip all frontmatter |
| Cline | `.clinerules/workflows/` | `.md` | Strip all frontmatter |
| Windsurf | `.windsurf/workflows/` | `.md` | Strip all frontmatter |
| Kilo Code | `.kilocode/commands/` | `.md` | Keep `description:`, add `mode: code` |
| Roo Code | `.roo/commands/` | `.md` | Keep `description:`, add `mode: code` |
| Continue | `.continue/prompts/` | `.prompt` | Add `name:`, `invokable: true` |
| GitHub Copilot | `.github/prompts/` | `.prompt.md` | Add `name:`, `description:`, `tools:` |
| Antigravity | `.agents/workflows/` | `.md` | Keep `description:` |
| Codex (ext) | `.agents/skills/forge-workflow/` | `SKILL.md` | Single combined file (special case) |

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
6. **Command too long for some agents**: Continue has ~4000 token limit for .prompt files — sync script should warn if adapted content exceeds known limits

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
| TBD | PR-A: Static command validator + sync infrastructure | feature | P1 | None |
| TBD | PR-B: Command behavioral eval + improvement loop | feature | P2 | PR-A |
| TBD | PR-C: Skill optimization via eval loop | feature | P2 | None |

### Existing Issues Affected

| ID | How Affected |
|----|-------------|
| forge-2w3 | PR-A's sync script replaces manual adapter creation (Tasks 3-11) |
| forge-30k | PR-A's static validator overlaps with doc link checker — may merge or share infra |
| forge-ctc | Must complete before forge-2w3 can use sync script |

---

## Technical Research

*(To be completed in Phase 2)*

### Web Research Topics
- Agent command file format specs (confirm from official docs)
- Claude CLI `--output-format stream-json` behavior for command evaluation
- Existing command linting tools in AI agent ecosystem

### OWASP Top 10 Analysis
*(To be completed in Phase 2)*

### TDD Test Scenarios (Preliminary)

**PR-A Static Validator:**
1. Happy path: clean repo with all commands → `forge check-agents` exits 0
2. Dead reference: `/status` contains `openspec list` → validator catches it, exits non-zero
3. Sync drift: `.cursor/commands/plan.md` differs from canonical → `--sync-check` flags it
4. Missing HARD-GATE: command claims gate but has no closing block → validator warns

**PR-B Behavioral Eval:**
1. Happy path: `/status` in clean worktree → grader confirms expected output sections
2. HARD-GATE enforcement: `/plan` on non-master branch → grader confirms it stopped
3. Cross-command contract: /plan creates task file → /dev finds it

**PR-C Skill Optimization:**
1. Trigger accuracy: `parallel-web-search` triggers on "search for X" query
2. Non-trigger: `parallel-web-search` does NOT trigger on "read this file" query
3. Improvement: description rewrite improves trigger accuracy on test set

---

## Sources

- [Anthropic skill-creator plugin](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/skill-creator)
- [Agent command parity design doc](docs/plans/2026-03-04-agent-command-parity-design.md)
- [Agent instructions sync research](docs/research/agent-instructions-sync.md)
- [skills.sh portable runner pattern](skills/)
