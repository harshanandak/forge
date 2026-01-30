# Forge - 9-Stage TDD Workflow

A TDD-first workflow for AI coding agents. Ship features with confidence.

## Commands (9 Stages)

| Stage | Command | Description |
|-------|---------|-------------|
| 1 | `/status` | Check current context, active work, recent completions |
| 2 | `/research` | Deep research with web search, document to docs/research/ |
| 3 | `/plan` | Create implementation plan, branch, OpenSpec if strategic |
| 4 | `/dev` | TDD development (RED-GREEN-REFACTOR cycles) |
| 5 | `/check` | Validation (type/lint/security/tests) |
| 6 | `/ship` | Create PR with full documentation |
| 7 | `/review` | Address ALL PR feedback |
| 8 | `/merge` | Update docs, merge PR, cleanup |
| 9 | `/verify` | Final documentation verification |

## Workflow Flow

```
/status → /research → /plan → /dev → /check → /ship → /review → /merge → /verify
```

## Core Principles

- **TDD-First**: Write tests BEFORE implementation (RED-GREEN-REFACTOR)
- **Research-First**: Understand before building, document decisions
- **Security Built-In**: OWASP Top 10 analysis for every feature
- **Documentation Progressive**: Update at each stage, verify at end

## Prerequisites

- Git, GitHub CLI (`gh`)
- Beads (recommended): `npm i -g @beads/bd && bd init`
- OpenSpec (optional): `npm i -g @fission-ai/openspec && openspec init`

## Toolchain Quick Reference

### Beads (Issue Tracking)
```bash
bd ready                    # Find unblocked work (start here!)
bd create "Title" -p 2      # Create issue with priority
bd update <id> --status in_progress
bd comments <id> "note"     # Add comment
bd close <id>               # Complete
bd sync                     # Git sync (always at session end!)
```

### OpenSpec (Specs - AI Commands)
```bash
/opsx:new                   # Start change
/opsx:ff                    # Generate all planning docs
/opsx:apply                 # Implement tasks
/opsx:verify                # Validate
/opsx:archive               # Complete
```

### GitHub CLI
```bash
gh pr create --title "..." --body "..."
gh pr view <n>
gh pr merge <n> --squash --delete-branch
```

## Quick Start

1. `/status` - Check where you are
2. `/research <feature-name>` - Research the feature
3. `/plan <feature-slug>` - Create formal plan
4. `/dev` - Implement with TDD
5. `/check` - Validate everything
6. `/ship` - Create PR

## Stage Details

### 1. Status (`/status`)

Check current context before starting work:
- Active issues (via Beads if installed)
- Recent completions
- Current branch state
- OpenSpec proposals in progress

### 2. Research (`/research <feature-name>`)

Research before building:
- Web search for best practices
- Security analysis (OWASP Top 10)
- Existing patterns in codebase
- Document to `docs/research/<feature>.md`

### 3. Plan (`/plan <feature-slug>`)

Create implementation plan:
- Create feature branch
- Define scope and approach
- Create tracking issue (Beads)
- OpenSpec proposal if strategic

### 4. Development (`/dev`)

TDD implementation:
- RED: Write failing test
- GREEN: Make it pass
- REFACTOR: Clean up
- Commit after each GREEN cycle

### 5. Check (`/check`)

Validate everything:
- Type checking
- Linting
- Unit tests
- Integration tests
- Security scan

### 6. Ship (`/ship`)

Create pull request:
- Push branch
- Create PR with documentation
- Link to research doc
- List test coverage

### 7. Review (`/review`)

Address ALL feedback:
- GitHub Actions failures
- Code review comments
- Security scan issues
- Automated tool feedback

### 8. Merge (`/merge`)

Complete the work:
- Update documentation
- Squash merge PR
- Archive OpenSpec (if used)
- Close tracking issues

### 9. Verify (`/verify`)

Final documentation check:
- All docs updated
- Cross-references valid
- Examples work
- README current

## Directory Structure

```
your-project/
├── AGENTS.md                    # This file (universal)
├── CLAUDE.md                    # Claude Code
├── GEMINI.md                    # Google Antigravity
├── .cursorrules                 # Cursor
├── .windsurfrules               # Windsurf
├── .clinerules                  # Cline/Roo Code
├── .github/
│   └── copilot-instructions.md  # GitHub Copilot
│
├── .claude/commands/            # Claude Code commands
├── .agent/workflows/            # Antigravity workflows
├── .cursor/rules/               # Cursor rules
├── .windsurf/workflows/         # Windsurf workflows
├── .kilocode/workflows/         # Kilo Code workflows
├── .opencode/commands/          # OpenCode commands
├── .continue/prompts/           # Continue prompts
├── .roo/commands/               # Roo Code commands
│
└── docs/
    ├── planning/
    │   └── PROGRESS.md
    ├── research/
    │   └── TEMPLATE.md
    └── WORKFLOW.md
```

## Skills (Universal SKILL.md Format)

The `forge-workflow` skill is installed to all supporting agents:
- `.claude/skills/forge-workflow/SKILL.md`
- `.agent/skills/forge-workflow/SKILL.md` (Antigravity)
- `.cursor/skills/forge-workflow/SKILL.md`
- `.windsurf/skills/forge-workflow/SKILL.md`
- `.kilocode/skills/forge-workflow/SKILL.md`
- `.cline/skills/forge-workflow/SKILL.md`
- `.continue/skills/forge-workflow/SKILL.md`
- `.opencode/skills/forge-workflow/SKILL.md`

## Supported Agents

This workflow works with ALL major AI coding agents:

| Agent | Instructions | Commands | Skills |
|-------|-------------|----------|--------|
| Claude Code | CLAUDE.md | .claude/commands/ | .claude/skills/ |
| Google Antigravity | GEMINI.md | .agent/workflows/ | .agent/skills/ |
| Cursor | .cursorrules | .cursor/rules/ | .cursor/skills/ |
| Windsurf | .windsurfrules | .windsurf/workflows/ | .windsurf/skills/ |
| Kilo Code | AGENTS.md | .kilocode/workflows/ | .kilocode/skills/ |
| OpenCode | AGENTS.md | .opencode/commands/ | .opencode/skills/ |
| Cline | .clinerules | AGENTS.md | .cline/skills/ |
| Roo Code | .clinerules | .roo/commands/ | - |
| Continue | .continuerules | .continue/prompts/ | .continue/skills/ |
| GitHub Copilot | .github/copilot-instructions.md | .github/prompts/ | - |
| Aider | AGENTS.md (via config) | In-chat | - |

## License

MIT

---

See `docs/WORKFLOW.md` for the complete workflow guide.
See `docs/TOOLCHAIN.md` for comprehensive tool reference.
