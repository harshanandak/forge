# Forge

A 9-stage TDD-first workflow for **ALL AI coding agents**. Ship features with confidence using test-driven development, research-first planning, and comprehensive documentation.

```
/status -> /research -> /plan -> /dev -> /check -> /ship -> /review -> /merge -> /verify
```

## Supported AI Coding Agents

Forge works with **all major AI coding agents** using the universal [AGENTS.md](https://agents.md/) standard:

| Agent | Status | Primary Config | Commands Location |
|-------|--------|----------------|-------------------|
| **Claude Code** | Full | `CLAUDE.md` | `.claude/commands/` |
| **Google Antigravity** | Full | `GEMINI.md` | `.agent/workflows/` |
| **Cursor** | Full | `.cursorrules` | `.cursor/rules/` |
| **Windsurf** | Full | `.windsurfrules` | `.windsurf/workflows/` |
| **Kilo Code** | Full | `AGENTS.md` | `.kilocode/workflows/` |
| **OpenCode** | Full | `AGENTS.md` | `.opencode/commands/` |
| **Continue** | Full | `.continuerules` | `.continue/prompts/` |
| **GitHub Copilot** | Full | `.github/copilot-instructions.md` | `.github/prompts/` |
| **Cline** | Full | `.clinerules` | Via instructions |
| **Roo Code** | Full | `.clinerules` | `.roo/commands/` |
| **Aider** | Full | `AGENTS.md` | Via instructions |

## Installation

### Option 1: npm (Recommended)

```bash
# Step 1: Install the package (minimal: AGENTS.md + docs)
npm install forge-workflow

# Step 2: Configure for your agents (interactive)
npx forge setup
```

Or specify agents directly:

```bash
# Install for specific agents
npx forge setup --agents claude,cursor,windsurf

# Install for all agents
npx forge setup --all
```

### Option 2: bun

```bash
bun add forge-workflow
bunx forge setup
```

### Option 3: curl (Interactive)

```bash
curl -fsSL https://raw.githubusercontent.com/harshanandak/forge/main/install.sh | bash
```

The curl installer is interactive - it will ask which agents you use.

### Option 4: GitHub Template (New projects)

1. Click "Use this template" on GitHub
2. Clone your new repo
3. Run `npx forge setup` to configure

## What Gets Installed

### Minimal Install (npm install)

```
your-project/
├── AGENTS.md                # Universal standard
└── docs/
    ├── WORKFLOW.md          # Complete guide
    ├── planning/PROGRESS.md # Progress tracking
    └── research/TEMPLATE.md # Research template
```

### After Setup (npx forge setup)

Only the agents you select get configured:

```
# If you selected Claude Code + Cursor + Windsurf:

your-project/
├── AGENTS.md                    # Universal standard
├── CLAUDE.md                    # -> linked to AGENTS.md
├── .cursorrules                 # -> linked to AGENTS.md
├── .windsurfrules               # -> linked to AGENTS.md
│
├── .claude/
│   ├── commands/                # 9 workflow commands
│   ├── rules/workflow.md
│   └── skills/forge-workflow/
│
├── .cursor/
│   ├── rules/forge-workflow.mdc
│   └── skills/forge-workflow/
│
├── .windsurf/
│   ├── workflows/               # Converted commands
│   ├── rules/
│   └── skills/forge-workflow/
│
└── docs/
    └── ...
```

## Prerequisites

### Required

- **Git** - Version control
- **GitHub CLI** - For PR workflow
  ```bash
  # macOS
  brew install gh && gh auth login

  # Windows
  winget install GitHub.cli && gh auth login

  # Linux
  sudo apt install gh && gh auth login
  ```

### Recommended

- **Beads** - Issue tracking across sessions
  ```bash
  npm install -g beads-cli && bd init
  ```

### Optional

- **OpenSpec** - Architectural proposals for strategic changes
  ```bash
  npm install -g openspec-cli && openspec init
  ```

## The 9 Stages

| Stage | Command | What It Does |
|-------|---------|--------------|
| 1 | `/status` | Check current context, active work, recent completions |
| 2 | `/research` | Deep research with web search, document findings |
| 3 | `/plan` | Create implementation plan, branch, tracking |
| 4 | `/dev` | TDD development (RED-GREEN-REFACTOR cycles) |
| 5 | `/check` | Validation (type/lint/security/tests) |
| 6 | `/ship` | Create PR with full documentation |
| 7 | `/review` | Address ALL PR feedback |
| 8 | `/merge` | Update docs, merge, cleanup |
| 9 | `/verify` | Final documentation verification |

## Quick Start

```bash
# 1. Check what's happening
/status

# 2. Research your feature
/research user-authentication

# 3. Plan the implementation
/plan user-authentication

# 4. Develop with TDD
/dev

# 5. Validate everything
/check

# 6. Ship it
/ship
```

## Core Principles

### TDD-First
- Write tests BEFORE implementation
- RED: Write failing test
- GREEN: Make it pass
- REFACTOR: Clean up
- Commit after each GREEN cycle

### Research-First
- Understand before building
- Document decisions with evidence
- Use web research for best practices
- Create `docs/research/<feature>.md`

### Security Built-In
- OWASP Top 10 analysis for every feature
- Security tests as part of TDD
- Automated scans + manual review

### Documentation Progressive
- Update docs at each relevant stage
- Verify completeness with `/verify`
- Never accumulate doc debt

## Configuration

Customize commands for your tech stack in your project's `CLAUDE.md` (or `AGENTS.md`):

```markdown
## Build Commands
- Type check: `npm run typecheck`
- Lint: `npm run lint`
- Test: `npm run test`
- Security: `npm audit`
```

## Optional: Beads Issue Tracking

Forge integrates with [Beads](https://github.com/beads-ai/beads-cli) for persistent issue tracking across sessions:

```bash
# Install Beads (optional)
npm install -g beads-cli

# Initialize in your project
bd init

# Create issues
bd create "Add user authentication"

# Track progress
bd update <id> --status in_progress
bd close <id>
```

## Workflow Visualization

```
┌─────────┐
│ /status │ -> Check current stage & context
└────┬────┘
     │
┌────▼──────┐
│ /research │ -> Deep research, save to docs/research/
└────┬──────┘
     │
┌────▼────┐
│  /plan  │ -> Create plan, branch, tracking
└────┬────┘
     │
┌────▼───┐
│  /dev  │ -> TDD implementation (RED-GREEN-REFACTOR)
└────┬───┘
     │
┌────▼────┐
│ /check  │ -> Validation (type/lint/tests/security)
└────┬────┘
     │
┌────▼────┐
│  /ship  │ -> Create PR with full documentation
└────┬────┘
     │
┌────▼─────┐
│ /review  │ -> Address ALL PR issues
└────┬─────┘
     │
┌────▼─────┐
│  /merge  │ -> Update docs, merge PR, cleanup
└────┬─────┘
     │
┌────▼──────┐
│  /verify  │ -> Final documentation check
└───────────┘
     │
     v Complete
```

## License

MIT

## Contributing

Contributions welcome! Please read the workflow guide at `docs/WORKFLOW.md` before submitting PRs.
