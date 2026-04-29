# Research: obra/superpowers — Integration Analysis for Forge

**Feature slug**: `superpowers`
**Date**: 2026-02-26
**Sources**: All claims below cite exact URLs.

---

## What Is Superpowers?

**Repository**: https://github.com/obra/superpowers
**Author**: Jesse Vincent (@obra) — keyboard designer at keyboard.io, creator of K-9 Mail for Android, former Perl 5 project lead
**Description**: "An agentic skills framework & software development methodology that works."
**License**: MIT
**Version**: v4.3.1 (2026-02-21)
**Language**: Shell
**Stars**: ~62,000 (4th most installed plugin in Claude Code marketplace, surpassed GitHub's own plugin)
**Source**: https://www.threads.com/@obrajesse/post/DVANeBYEfuF/ — Jesse Vincent's own announcement

Superpowers is a **Claude Code plugin** (also supports Cursor, Codex, OpenCode) that ships a library of 14 composable "skills" — structured instructions the agent reads and follows automatically. Skills trigger based on context, not user commands. The agent reads the right skill before taking action.

---

## Installation

### Claude Code (Native Plugin Marketplace)
```bash
/plugin marketplace add obra/superpowers-marketplace
/plugin install superpowers@superpowers-marketplace
```
Marketplace repo: https://github.com/obra/superpowers-marketplace

### Cursor
```text
/plugin-add superpowers
```

### Codex / OpenCode
Manual: Fetch and follow `.codex/INSTALL.md` or `.opencode/INSTALL.md`

**Source**: https://github.com/obra/superpowers/blob/main/README.md

---

## Repository Structure

```
superpowers/
├── .claude-plugin/          # Claude Code plugin manifest
├── .codex/                  # Codex integration
├── .cursor-plugin/          # Cursor integration
├── .opencode/               # OpenCode integration
├── agents/
│   └── code-reviewer.md     # Custom code-reviewer agent definition
├── commands/                # CLI commands
├── docs/
│   ├── README.codex.md
│   ├── README.opencode.md
│   ├── plans/               # Design docs written here
│   └── testing.md
├── hooks/                   # Git hooks
├── lib/                     # Shared libraries
├── skills/                  # 14 skills (core value)
└── tests/
```

**Source**: https://github.com/obra/superpowers (file tree)

---

## The 14 Skills (Full List)

| Skill | Purpose |
|-------|---------|
| `brainstorming` | Socratic design refinement with hard gate — MUST complete before any code |
| `writing-plans` | Break approved design into 2-5 minute tasks with exact file paths and code |
| `executing-plans` | Batch execution with human checkpoints |
| `subagent-driven-development` | Dispatch fresh subagent per task, two-stage review |
| `dispatching-parallel-agents` | Concurrent subagent workflows |
| `test-driven-development` | Enforced RED-GREEN-REFACTOR cycle with anti-patterns reference |
| `systematic-debugging` | 4-phase root cause analysis (root-cause-tracing, defense-in-depth, condition-based-waiting) |
| `verification-before-completion` | Verify fix actually works before declaring done |
| `requesting-code-review` | Pre-review checklist |
| `receiving-code-review` | Structured response to feedback |
| `using-git-worktrees` | Isolated workspace per task on new branch |
| `finishing-a-development-branch` | Merge/PR decision workflow, worktree cleanup |
| `writing-skills` | Meta-skill: create new skills following best practices |
| `using-superpowers` | Introduction and dispatch logic |

**Source**: https://github.com/obra/superpowers/tree/main/skills

---

## Core Workflow (How It Runs)

```
1. brainstorming      → Explore context → ask questions one at a time → propose 2-3 approaches
                        → present design in sections → user approves → write design doc to
                        docs/plans/YYYY-MM-DD-<topic>-design.md → commit

2. using-git-worktrees → Create isolated workspace on new branch → run project setup
                         → verify clean test baseline

3. writing-plans      → Break approved design into tasks (2-5 min each)
                        → each task: exact file paths, complete code, verification steps

4. subagent-driven-development OR executing-plans
                      → Fresh subagent per task
                        → Two-stage review: (1) spec compliance, (2) code quality

5. test-driven-development → RED fails → GREEN passes → REFACTOR → commit
                             → Deletes code written before tests

6. requesting-code-review → Reviews against plan, reports by severity
                            → Critical issues block progress

7. finishing-a-development-branch → Verify tests → present options (merge/PR/keep/discard)
                                    → clean up worktree
```

**Key mechanic**: Skills auto-trigger based on context. The agent checks for relevant skills before any task. No user command needed.

**Source**: https://github.com/obra/superpowers/blob/main/README.md and https://blog.fsck.com/2025/10/09/superpowers/

---

## The HARD-GATE Pattern

The brainstorming skill uses explicit blocking tags:

```
<HARD-GATE>
Do NOT invoke any implementation skill, write any code, scaffold any project,
or take any implementation action until you have presented a design and the user
has approved it. This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>
```

**Why this matters**: This is a structural enforcement mechanism — not a soft instruction. It explicitly names forbidden actions and conditions. Soft instructions ("read AGENTS.md first") fail. Hard gates with explicit prohibitions work.

**Source**: brainstorming/SKILL.md content from https://github.com/obra/superpowers/blob/main/skills/brainstorming/SKILL.md

---

## Community Reception

| Source | Signal |
|--------|--------|
| Hacker News | 435 points, 231 comments — https://news.ycombinator.com/item?id=45547344 |
| Simon Willison | "Jesse is one of the most creative users of coding agents I know" — https://simonwillison.net/2025/Oct/10/superpowers/ |
| Cornell Innovation Hub | "How I Built a 3600 Line Feature in 4 Hours Without Writing a Single Line of Code" — https://innovationhub.ai.cornell.edu/articles/how-i-built-a-3600-line-feature-in-4-hours-without-writing-a-single-line-of-code/ |
| Claude Code Marketplace | 4th most installed plugin, surpassed GitHub — https://www.threads.com/@obrajesse/post/DVANeBYEfuF/ |
| r/ClaudeCode | "actually delivers" — https://www.reddit.com/r/ClaudeCode/comments/1r9y2ka/ |
| Dev Genius | "the Claude plugin that enforces TDD, subagents, and planning" — https://blog.devgenius.io/superpowers-explained-the-claude-plugin-that-enforces-tdd-subagents-and-planning-c7fe698c3b82 |

---

## Forge vs Superpowers: Side-by-Side

### What Both Do (Overlap)

| Capability | Forge | Superpowers |
|-----------|-------|------------|
| TDD enforcement | `/dev` RED-GREEN-REFACTOR | `test-driven-development` skill |
| Planning phase | `/plan` command + Beads | `writing-plans` skill |
| Code review | `/review` command | `requesting-code-review` + `receiving-code-review` |
| Parallel agents | Parallel AI skills | `dispatching-parallel-agents` skill |
| PR workflow | `/ship`, `/premerge` | `finishing-a-development-branch` |

### What Superpowers Has That Forge Doesn't

| Gap | Superpowers Solution | Forge Status |
|-----|---------------------|-------------|
| **Design before code** | `brainstorming` skill with HARD-GATE | No equivalent — `/plan` goes straight to beads/branch |
| **Git worktree isolation** | `using-git-worktrees` skill | Not in Forge workflow |
| **Systematic debugging** | `systematic-debugging` (4 phases) | No equivalent |
| **Verification before done** | `verification-before-completion` | Implicit in `/check` but not explicit |
| **Meta-skill authoring** | `writing-skills` skill | No equivalent |
| **Two-stage code review** | spec compliance → code quality | Single-stage review |
| **Hard gate enforcement** | `<HARD-GATE>` tags | Soft instructions only |
| **Design docs** | Saved to `docs/plans/YYYY-MM-DD-*.md` | Research docs only (`docs/research/`) |
| **Plugin distribution** | Claude Code + Cursor marketplace | Not distributable as plugin |

### What Forge Has That Superpowers Doesn't

| Capability | Forge | Superpowers Status |
|-----------|-------|-------------------|
| **Web research stage** | `/research` + parallel AI search | No research phase |
| **Formal spec proposals** | OpenSpec (`openspec/changes/`) | No equivalent |
| **Issue tracking** | Beads (`bd create`, `bd update`) | `obra/issue-cards` (separate repo, not integrated) |
| **Multi-agent file support** | AGENTS.md/CLAUDE.md/GEMINI.md | Claude Code + Cursor only |
| **Security analysis** | OWASP per feature in `/dev` | No security phase |
| **Full PR lifecycle** | `/ship`, `/review`, `/premerge`, `/verify` | Only `finishing-a-development-branch` |
| **SonarCloud integration** | `/sonarcloud` command | None |
| **Greptile integration** | `.claude/rules/greptile-review-process.md` | None |
| **Post-merge verification** | `/verify` | None |

---

## Integration Options

### Option A: Install Superpowers Plugin Alongside Forge (Non-Breaking)

Install Superpowers as a Claude Code plugin. It adds its skills to your agent's context. Forge commands continue to work. Superpowers skills auto-trigger for gaps Forge doesn't cover.

**Benefit**: Immediately gets brainstorming gate, systematic debugging, git worktrees, verification
**Risk**: Workflow overlap — both have planning, review phases. Agent may get confused about which to use.
**Verdict**: Valid short-term, but needs clear role definition in AGENTS.md/CLAUDE.md

**Source on overlap concerns**: https://www.reddit.com/r/ClaudeCode/comments/1qlsdjb/superpowers_vs_gsd_vs_others/

### Option B: Cherry-Pick Key Skills Into Forge (Best Fit)

Import specific Superpowers skills into Forge's `skills/` directory:
- `brainstorming` → insert between `/research` and `/plan` as a new stage
- `systematic-debugging` → add as `/debug` command
- `writing-skills` → use for authoring new Forge skills
- `verification-before-completion` → integrate into `/check` command
- HARD-GATE pattern → add to `/research`, `/plan`, `/dev` commands

**Benefit**: Gets Superpowers' best ideas without workflow collision
**Risk**: Maintenance burden — skills diverge from upstream
**Verdict**: Best long-term approach for Forge as a standalone workflow

### Option C: Replace OpenSpec With Superpowers' `writing-plans`

Superpowers' `writing-plans` creates detailed task-level implementation plans. OpenSpec creates formal architecture proposals with `proposal.md`, `tasks.md`, `design.md`.

**Assessment**: These solve different problems.
- `writing-plans` → task-level implementation checklist (tactical)
- OpenSpec → architecture-level proposals requiring approval (strategic)
- **Do not replace** — they are complementary. OpenSpec for "what to build", `writing-plans` for "how to build it."

### Option D: Adopt HARD-GATE Pattern Into Forge Commands (Quickest Win)

Add `<HARD-GATE>` blocks to existing Forge commands. Example for `/plan`:

```
<HARD-GATE>
Do NOT proceed to /dev or write any code until:
1. Research doc exists at docs/research/<slug>.md
2. Beads issue is created and in_progress
3. Branch exists at feat/<slug>
</HARD-GATE>
```

**Benefit**: Addresses the core scope discipline problem without changing workflow
**Risk**: None — purely additive
**Verdict**: Should be done immediately regardless of other options

---

## Key Insight: Skills vs Commands

Superpowers skills auto-trigger. Forge uses explicit commands (`/plan`, `/dev`). These are philosophically different:

- **Forge**: User explicitly controls each stage. Good for learning, transparency.
- **Superpowers**: Agent decides when to invoke skills. Good for autonomy, fewer user interruptions.

For Forge's use case (multi-agent support, OpenSpec, Beads, full PR lifecycle), the explicit command model is correct. But Superpowers' brainstorming gate and systematic debugging are worth importing as skills, not auto-triggers.

---

## Related obra Repos Worth Knowing

| Repo | Description | URL |
|------|-------------|-----|
| `obra/superpowers-marketplace` | Claude Code plugin marketplace | https://github.com/obra/superpowers-marketplace |
| `obra/issue-cards` | AI-optimized CLI issue tracker (similar to Beads) | https://github.com/obra/issue-cards |
| `obra/coderabbit-review-helper` | Extract CodeRabbit PR reviews for AI agent consumption | https://github.com/obra/coderabbit-review-helper |

---

## Recommendations for Forge

**Priority 1 (Quick wins, no new features needed):**
1. Adopt `<HARD-GATE>` pattern in `/research`, `/plan`, `/dev` commands — prevents stage-skipping
2. Add `brainstorming` as a new stage between `/research` and `/plan` (or make it optional in `/plan`)
3. Add `verification-before-completion` logic to `/check` command

**Priority 2 (New skills):**
4. Port `systematic-debugging` as `/debug` command
5. Port `writing-skills` as `/skill` command for authoring new Forge skills
6. Add git worktree support to `/dev` command (isolated implementation)

**Priority 3 (Infrastructure):**
7. Explore distributing Forge as a Claude Code plugin (`.claude-plugin/` directory) — same distribution model as Superpowers
8. Add two-stage code review to `/review` command (spec compliance first, then code quality)

**What NOT to take:**
- Don't replace Beads with `obra/issue-cards` — Beads has cross-session persistence and is already integrated
- Don't replace OpenSpec with `writing-plans` — different purpose levels
- Don't install Superpowers plugin directly — workflow collision risk until roles are defined

---

## Sources Index

| # | URL | Used For |
|---|-----|---------|
| 1 | https://github.com/obra/superpowers | Repo structure, README, skills list |
| 2 | https://github.com/obra/superpowers/blob/main/README.md | Workflow, installation, philosophy |
| 3 | https://blog.fsck.com/2025/10/09/superpowers/ | Origin story, session-start hook |
| 4 | https://simonwillison.net/2025/Oct/10/superpowers/ | Community reception, feelings journal mention |
| 5 | https://news.ycombinator.com/item?id=45547344 | HN reception (435 pts, 231 comments) |
| 6 | https://www.threads.com/@obrajesse/post/DVANeBYEfuF/ | 4th most installed in Claude marketplace |
| 7 | https://github.com/obra/superpowers-marketplace | Marketplace companion repo |
| 8 | https://github.com/obra/issue-cards | Related obra issue tracker |
| 9 | https://github.com/obra/coderabbit-review-helper | Related obra PR review tool |
| 10 | https://mcpmarket.com/server/superpowers | MCP market listing |
| 11 | https://www.reddit.com/r/ClaudeCode/comments/1r9y2ka/ | User experience reports |
| 12 | https://www.reddit.com/r/ClaudeCode/comments/1qlsdjb/superpowers_vs_gsd_vs_others/ | Comparison with GSD workflow |
| 13 | https://www.reddit.com/r/ClaudeCode/comments/1ra8rdy/plan_mode_vs_superpowers_brainstorming_which/ | Plan mode vs brainstorming comparison |
| 14 | https://blog.devgenius.io/superpowers-explained-the-claude-plugin-that-enforces-tdd-subagents-and-planning-c7fe698c3b82 | Technical explanation |
| 15 | https://innovationhub.ai.cornell.edu/articles/how-i-built-a-3600-line-feature-in-4-hours-without-writing-a-single-line-of-code/ | Real-world results |
| 16 | https://sitepoint.com/agentic-engineering-superpowers-framework-agent-capabilities/ | Architecture patterns analysis |
| 17 | https://st0012.dev/links/2026-01-15-a-claude-code-workflow-with-the-superpowers-plugin/ | `/superpowers:brainstorm` and `/superpowers:write-plan` usage |
| 18 | https://medium.com/vibe-coding/every-ai-tool-has-plan-mode-none-of-them-do-it-right-6bd540155690 | Plan mode vs Superpowers brainstorming |
| 19 | https://dev.to/tumf/superpowers-the-technology-to-persuade-ai-agents-why-psychological-principles-change-code-quality-2d2f | Psychological principles in AI instructions |
