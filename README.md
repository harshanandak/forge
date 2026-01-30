# Forge

A 9-stage TDD-first workflow for **ALL AI coding agents**. Ship features with confidence using test-driven development, research-first planning, and comprehensive documentation.

```
/status -> /research -> /plan -> /dev -> /check -> /ship -> /review -> /merge -> /verify
```

## Why Forge?

- **TDD-First**: Write tests before code (RED-GREEN-REFACTOR)
- **Research-First**: Understand before building, document decisions
- **Security Built-In**: OWASP Top 10 analysis for every feature
- **Multi-Session**: Track work across sessions with Beads
- **Strategic Planning**: Use OpenSpec for architecture changes
- **Universal**: Works with 11+ AI coding agents

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

### Option 2: curl (Interactive)

```bash
curl -fsSL https://raw.githubusercontent.com/harshanandak/forge/main/install.sh | bash
```

### Option 3: bun

```bash
bun add forge-workflow
bunx forge setup
```

## The Toolchain

Forge integrates with three powerful tools for complete workflow management:

```
┌─────────────────────────────────────────────────────────────────┐
│                        FORGE TOOLCHAIN                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────────────┐   │
│  │   BEADS     │   │  OPENSPEC   │   │    CLAUDE TASKS     │   │
│  │             │   │             │   │                     │   │
│  │ Issue       │   │ Proposal    │   │ Save/Resume         │   │
│  │ Tracking    │   │ System      │   │ Task State          │   │
│  │             │   │             │   │                     │   │
│  │ bd create   │   │ openspec    │   │ /tasks save         │   │
│  │ bd ready    │   │ proposal    │   │ /tasks resume       │   │
│  │ bd close    │   │ create      │   │ /tasks list         │   │
│  └─────────────┘   └─────────────┘   └─────────────────────┘   │
│        │                 │                     │                │
│        └─────────────────┴─────────────────────┘                │
│                          │                                      │
│                    ┌─────▼─────┐                                │
│                    │   FORGE   │                                │
│                    │  9-Stage  │                                │
│                    │  Workflow │                                │
│                    └───────────┘                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Beads - Issue Tracking Across Sessions

[Beads](https://github.com/steveyegge/beads) provides git-backed, distributed issue tracking designed for AI coding agents.

```bash
# Install
npm install -g @beads/bd

# Initialize in your project
bd init

# Find work ready to start (no blockers!)
bd ready

# Create an issue
bd create "Add user authentication" --type feature --priority 2

# View issue details
bd show <id>

# Update status
bd update <id> --status in_progress

# Add dependencies (child depends on parent)
bd dep add <child> <parent>

# Add comments during work
bd comments <id> "Progress: login working, starting signup"

# Complete work
bd close <id> --reason "Implemented with JWT"

# Sync with git (ALWAYS at session end!)
bd sync
```

**Why Beads?**
- **Persists across sessions** - Issues survive context clearing, compaction, new chats
- **Git-backed** - Version controlled like code, mergeable, team-shareable
- **Dependency tracking** - Know what blocks what with `bd blocked`
- **Ready detection** - `bd ready` finds unblocked work automatically
- **AI-optimized** - JSON output, semantic compaction, audit trails

See [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md) for complete Beads command reference.

### OpenSpec - Spec-Driven Development

[OpenSpec](https://github.com/Fission-AI/OpenSpec) provides spec-driven development for AI-assisted workflows.

```bash
# Install (requires Node.js 20.19+)
npm install -g @fission-ai/openspec

# Initialize
openspec init

# In AI assistant (Claude Code, Cursor, Windsurf):
/opsx:new          # Start a new change
/opsx:ff           # Fast-forward: generate all planning docs
/opsx:apply        # Implement tasks
/opsx:verify       # Validate implementation
/opsx:archive      # Complete and archive

# Creates:
# openspec/changes/[name]/
#   ├── proposal.md      # Intent, scope, rationale
#   ├── design.md        # Technical approach
#   ├── tasks.md         # Implementation checklist
#   └── specs/           # Delta specifications (ADDED/MODIFIED/REMOVED)
```

**When to use OpenSpec:**

| Scope | Use OpenSpec? | Example |
|-------|---------------|---------|
| **Tactical** (< 1 day) | No | Bug fix, small feature |
| **Strategic** (architecture) | Yes | New service, major refactor |
| **Breaking changes** | Yes | API changes, schema migrations |
| **Multi-session work** | Yes | Large features |

**Workflow:**
```bash
# 1. Start change (in AI assistant)
/opsx:new
# Describe: "Add payment processing with Stripe"

# 2. Generate all planning docs
/opsx:ff
# Creates proposal.md, design.md, tasks.md, specs/

# 3. Implement
/opsx:apply
# AI writes code following tasks.md

# 4. Validate and finalize
/opsx:verify          # Confirm implementation matches specs
openspec sync         # Merge deltas into main specs
openspec archive name # Move to archive
```

See [docs/TOOLCHAIN.md](docs/TOOLCHAIN.md) for complete OpenSpec reference.

### Claude Tasks - Save and Resume Work

Claude Code's built-in task system lets you save work state and resume later.

```bash
# Save current task state
/tasks save "implementing auth flow"

# List saved tasks
/tasks list

# Resume a saved task
/tasks resume <task-id>

# Delete a task
/tasks delete <task-id>
```

**When to use Claude Tasks:**
- Taking a break mid-implementation
- Switching between features
- Preserving context before `/clear`
- Handoff to another session

## The 9 Stages

| Stage | Command | What It Does | Tools Used |
|-------|---------|--------------|------------|
| 1 | `/status` | Check current context | Beads, Git |
| 2 | `/research` | Deep research, document findings | Web search, Codebase |
| 3 | `/plan` | Create plan, branch, tracking | Beads, OpenSpec |
| 4 | `/dev` | TDD development (RED-GREEN-REFACTOR) | Tests, Code |
| 5 | `/check` | Validation (type/lint/security/tests) | CI tools |
| 6 | `/ship` | Create PR with documentation | GitHub CLI |
| 7 | `/review` | Address ALL PR feedback | GitHub, Greptile |
| 8 | `/merge` | Update docs, merge, cleanup | Git |
| 9 | `/verify` | Final documentation check | Docs |

## Complete Workflow Example

```bash
# ═══════════════════════════════════════════════════════════
# STAGE 1: STATUS - Where are we?
# ═══════════════════════════════════════════════════════════
/status

# Checks:
# - bd ready (Beads issues ready to work)
# - bd list --status in_progress (active work)
# - git status (branch state)
# - openspec list --active (pending proposals)

# ═══════════════════════════════════════════════════════════
# STAGE 2: RESEARCH - Understand before building
# ═══════════════════════════════════════════════════════════
/research user-authentication

# Creates: docs/research/user-authentication.md
# Contains:
# - Codebase analysis (existing patterns)
# - Web research (best practices, security)
# - OWASP Top 10 analysis
# - Key decisions with reasoning
# - TDD test scenarios (identified UPFRONT)

# ═══════════════════════════════════════════════════════════
# STAGE 3: PLAN - Create formal plan
# ═══════════════════════════════════════════════════════════
/plan user-authentication

# If TACTICAL (< 1 day):
bd create "Add user authentication"
git checkout -b feat/user-authentication

# If STRATEGIC (architecture change):
openspec proposal create user-authentication
# Write proposal.md, tasks.md, design.md
openspec validate user-authentication --strict
bd create "User auth (see openspec/changes/user-authentication)"
git checkout -b feat/user-authentication
# Create PR for proposal approval first!

# ═══════════════════════════════════════════════════════════
# STAGE 4: DEV - TDD Implementation
# ═══════════════════════════════════════════════════════════
/dev

# TDD Cycle (repeat for each feature):
# RED:    Write failing test
# GREEN:  Make it pass (minimal code)
# REFACTOR: Clean up
# COMMIT: git commit after each GREEN

bd update <id> --status in_progress

# If taking a break:
/tasks save "auth flow - completed login, starting signup"

# ═══════════════════════════════════════════════════════════
# STAGE 5: CHECK - Validate everything
# ═══════════════════════════════════════════════════════════
/check

# Runs:
# - Type checking (tsc/typecheck)
# - Linting (eslint)
# - Unit tests
# - Integration tests
# - E2E tests
# - Security scan

# If fails:
bd update <id> --status blocked --comment "Type errors in auth.ts"

# ═══════════════════════════════════════════════════════════
# STAGE 6: SHIP - Create PR
# ═══════════════════════════════════════════════════════════
/ship

bd update <id> --status done
git push -u origin feat/user-authentication

gh pr create --title "feat: user authentication" --body "
## Summary
- JWT-based auth with refresh tokens
- Login/signup/logout flows
- Password reset via email

## Research
See: docs/research/user-authentication.md

## Beads Issue
Closes: beads-abc123

## Test Coverage
- 45 unit tests
- 12 integration tests
- 8 E2E tests
"

# ═══════════════════════════════════════════════════════════
# STAGE 7: REVIEW - Address ALL feedback
# ═══════════════════════════════════════════════════════════
/review 123

# Address:
# - GitHub Actions failures
# - Greptile comments
# - SonarCloud issues
# - Human reviewer comments

# Fix, commit, push
git commit -m "fix: address PR review feedback"
git push

# ═══════════════════════════════════════════════════════════
# STAGE 8: MERGE - Complete the work
# ═══════════════════════════════════════════════════════════
/merge 123

# Update docs BEFORE merge:
# - docs/planning/PROGRESS.md
# - API documentation
# - README if user-facing

gh pr merge 123 --squash --delete-branch

# If OpenSpec was used:
openspec archive user-authentication

bd sync
git checkout main && git pull

# ═══════════════════════════════════════════════════════════
# STAGE 9: VERIFY - Final documentation check
# ═══════════════════════════════════════════════════════════
/verify

# Verify:
# - PROGRESS.md updated
# - API docs current
# - README examples work
# - Cross-references valid

# Done! Back to /status for next task
```

## Directory Structure

After running `npx forge setup`, only selected agents are configured:

```
your-project/
├── AGENTS.md                    # Universal standard (always created)
├── CLAUDE.md                    # -> linked to AGENTS.md (if Claude selected)
├── GEMINI.md                    # -> linked (if Antigravity selected)
├── .cursorrules                 # -> linked (if Cursor selected)
├── .windsurfrules               # -> linked (if Windsurf selected)
├── .clinerules                  # -> linked (if Cline/Roo selected)
│
├── .beads/                      # Beads issue tracking (if bd init)
│   └── issues/
│
├── openspec/                    # OpenSpec proposals (if openspec init)
│   ├── specs/
│   └── changes/
│
├── .claude/                     # Claude Code (if selected)
│   ├── commands/                # 9 workflow commands
│   ├── rules/
│   └── skills/forge-workflow/
│
├── .cursor/                     # Cursor (if selected)
│   ├── rules/forge-workflow.mdc
│   └── skills/forge-workflow/
│
├── .windsurf/                   # Windsurf (if selected)
│   ├── workflows/
│   └── skills/forge-workflow/
│
└── docs/
    ├── planning/PROGRESS.md     # Project progress
    ├── research/                # Research documents
    │   └── TEMPLATE.md
    └── WORKFLOW.md              # Complete guide
```

## External Services & API Tokens

Forge integrates with external services for enhanced capabilities. **Most tools have FREE alternatives!**

### Code Review Options (Choose One)

| Tool | Pricing | Best For | Setup |
|------|---------|----------|-------|
| **GitHub Code Quality** | FREE | All GitHub repos | Built-in, zero setup ✓ |
| **CodeRabbit** | FREE (OSS) | Open source | GitHub App |
| **Greptile** | $99+/mo | Enterprise | API key |

**Recommended**: Start with GitHub Code Quality (free, already enabled).

### Code Quality Options (Choose One)

| Tool | Pricing | Best For | Setup |
|------|---------|----------|-------|
| **ESLint** | FREE | All projects | Built-in ✓ |
| **SonarCloud** | 50k LoC free | Cloud-first | API key |
| **SonarQube Community** | FREE | Self-hosted | Docker |

**Recommended**: Start with ESLint (free, already in your project).

Store API tokens in `.env.local`:

```bash
# .env.local (add to .gitignore!)

# Code Review Tool Selection
CODE_REVIEW_TOOL=github-code-quality  # or: coderabbit, greptile, none

# Code Quality Tool Selection
CODE_QUALITY_TOOL=eslint  # or: sonarcloud, sonarqube, none

# Required for PR workflow
GITHUB_TOKEN=ghp_xxxxxxxxxxxx

# Parallel AI - Deep web research (/research stage, optional)
PARALLEL_API_KEY=your-parallel-ai-key

# Greptile - AI code review (only if CODE_REVIEW_TOOL=greptile)
GREPTILE_API_KEY=your-greptile-key

# SonarCloud (only if CODE_QUALITY_TOOL=sonarcloud)
SONAR_TOKEN=your-sonarcloud-token
SONAR_ORGANIZATION=your-org
SONAR_PROJECT_KEY=your-project-key

# SonarQube Self-Hosted (only if CODE_QUALITY_TOOL=sonarqube)
SONARQUBE_URL=http://localhost:9000
SONARQUBE_TOKEN=your-token

# OpenRouter - Multi-model AI (optional)
OPENROUTER_API_KEY=your-openrouter-key
```

### Service Setup

| Service | Pricing | Purpose | Get Token | Used In |
|---------|---------|---------|-----------|---------|
| **GitHub CLI** | FREE | PR workflow | `gh auth login` | `/ship`, `/review`, `/merge` |
| **GitHub Code Quality** | FREE | Code review | Built-in | `/review` |
| **CodeRabbit** | FREE (OSS) | AI code review | [coderabbit.ai](https://coderabbit.ai) | `/review` |
| **Greptile** | $99+/mo | Enterprise review | [greptile.com](https://greptile.com) | `/review` |
| **ESLint** | FREE | Linting | Built-in | `/check` |
| **SonarCloud** | 50k LoC free | Cloud quality | [sonarcloud.io](https://sonarcloud.io) | `/check` |
| **SonarQube** | FREE | Self-hosted quality | Docker | `/check` |
| **Parallel AI** | Paid | Web research | [platform.parallel.ai](https://platform.parallel.ai) | `/research` |
| **OpenRouter** | Paid | Multi-model AI | [openrouter.ai](https://openrouter.ai) | AI features |

### Code Review Setup

**Option 1: GitHub Code Quality (FREE, Recommended)**

Zero setup required - GitHub's built-in code quality features are already enabled.

**Option 2: CodeRabbit (FREE for Open Source)**

```bash
# 1. Go to https://coderabbit.ai
# 2. Install the GitHub App
# 3. Enable for your repositories
# That's it! CodeRabbit will review PRs automatically.
```

**Option 3: Greptile (Paid - Enterprise)**

```bash
# 1. Get API key from https://app.greptile.com
# 2. Add to .env.local
GREPTILE_API_KEY=your-key

# 3. Index your repository (one-time)
curl -X POST "https://api.greptile.com/v2/repositories" \
  -H "Authorization: Bearer $GREPTILE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"remote": "github", "repository": "owner/repo"}'
```

### Code Quality Setup

**Option 1: ESLint Only (FREE, Recommended)**

Already configured in your project - no additional setup needed.

```bash
npm run lint  # or bun run lint
```

**Option 2: SonarCloud (Cloud-Hosted)**

```bash
# 1. Create project at https://sonarcloud.io
# 2. Get token from Security settings
# 3. Add to .env.local
SONAR_TOKEN=your-token
SONAR_ORGANIZATION=your-org
SONAR_PROJECT_KEY=your-project

# 4. Add sonar-project.properties
echo "sonar.organization=$SONAR_ORGANIZATION
sonar.projectKey=$SONAR_PROJECT_KEY
sonar.sources=src" > sonar-project.properties

# 5. Run analysis (in CI or locally)
npx sonarqube-scanner
```

**Option 3: SonarQube Community (FREE, Self-Hosted)**

```bash
# 1. Start SonarQube with Docker
docker run -d --name sonarqube -p 9000:9000 sonarqube:community

# 2. Access at http://localhost:9000 (admin/admin)
# 3. Generate token in SonarQube UI
# 4. Add to .env.local
SONARQUBE_URL=http://localhost:9000
SONARQUBE_TOKEN=your-token

# 5. Add sonar-project.properties
echo "sonar.host.url=http://localhost:9000
sonar.login=your-token
sonar.projectKey=your-project
sonar.sources=src" > sonar-project.properties

# 6. Run analysis
npx sonarqube-scanner
```

### Research Tool Setup

**Parallel AI (Optional - Paid)**

```bash
# 1. Get API key from https://platform.parallel.ai
# 2. Add to .env.local
PARALLEL_API_KEY=your-key

# 3. Test with curl
API_KEY=$(grep "^PARALLEL_API_KEY=" .env.local | cut -d= -f2)
curl -s -X POST "https://api.parallel.ai/v1beta/search" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -H "parallel-beta: search-extract-2025-10-10" \
  -d '{"objective": "test query"}'
```

### Loading Tokens

Forge includes a helper script:

```bash
# .claude/scripts/load-env.sh
source .claude/scripts/load-env.sh

# Or manually
export $(grep -v '^#' .env.local | xargs)
```

### Security Notes

- **NEVER commit `.env.local`** - add to `.gitignore`
- Use GitHub Secrets for CI/CD
- Rotate tokens periodically
- Use least-privilege tokens where possible

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
  npm install -g @beads/bd
  bd init
  ```

### Optional

- **OpenSpec** - Spec-driven development (requires Node.js 20.19+)
  ```bash
  npm install -g @fission-ai/openspec
  openspec init
  ```

## Quick Reference

### Beads Commands

```bash
bd init                          # Initialize in project
bd ready                         # Show work with no blockers (start here!)
bd create "title" -p 2           # Create issue with priority
bd show <id>                     # View issue details + audit trail
bd list --status open            # List open issues
bd update <id> --status X        # Update status
bd dep add <child> <parent>      # child depends on parent
bd comments <id> "note"          # Add comment
bd close <id>                    # Complete issue
bd blocked                       # Show blocked issues
bd sync                          # Sync with git (always at session end!)
```

### OpenSpec Commands (AI Slash Commands)

```bash
/opsx:new                        # Start new change
/opsx:ff                         # Fast-forward: generate all docs
/opsx:apply                      # Implement tasks
/opsx:verify                     # Validate implementation
/opsx:sync                       # Merge delta specs
/opsx:archive                    # Complete and archive
```

### OpenSpec Commands (CLI)

```bash
openspec init                    # Initialize
openspec list                    # List changes/specs
openspec validate <name>         # Validate change
openspec status                  # Show progress
openspec archive <name>          # Archive completed
```

### Claude Tasks Commands

```bash
/tasks save "description"        # Save current state
/tasks list                      # List saved tasks
/tasks resume <id>               # Resume a task
/tasks delete <id>               # Delete a task
```

### Forge Commands

```bash
/status                          # Check current state
/research <feature>              # Research a feature
/plan <feature>                  # Create implementation plan
/dev                             # TDD development
/check                           # Run all validations
/ship                            # Create PR
/review <pr>                     # Address PR feedback
/merge <pr>                      # Merge PR
/verify                          # Final doc check
```

## Core Principles

### TDD-First

Every feature starts with tests:

```
RED    -> Write a failing test
GREEN  -> Write minimal code to pass
REFACTOR -> Clean up, commit
REPEAT -> Next test case
```

### Research-First

Before building, understand:

1. **Codebase** - Existing patterns, affected modules
2. **Best practices** - Web research, official docs
3. **Security** - OWASP Top 10 analysis
4. **Decisions** - Document WHY, not just WHAT

### Security Built-In

Every feature includes:

- OWASP Top 10 analysis in research
- Security test scenarios in TDD
- Automated scans in `/check`
- Security review in PR

### Documentation Progressive

Update docs at each stage:

- `/research` -> Research document
- `/plan` -> Beads issue, OpenSpec (if strategic)
- `/ship` -> PR description
- `/merge` -> PROGRESS.md, API docs
- `/verify` -> Cross-check everything

## Agent Compatibility

Forge is designed for Claude Code's extensive features but adapts to all agents:

### Feature Availability by Agent

| Feature | Claude Code | Cursor | Windsurf | Kilo | Others |
|---------|-------------|--------|----------|------|--------|
| **Slash Commands** | `/status` etc. | Via rules | `/status` etc. | `/status.md` | AGENTS.md |
| **Skills (SKILL.md)** | Full | Full | Full | Full | Partial |
| **Rules** | `.claude/rules/` | `.mdc` | `.windsurf/rules/` | `.kilocode/rules/` | AGENTS.md |
| **Tasks Save/Resume** | `/tasks` | Memory | Memories | Memory Bank | Manual |
| **Issue Tracking** | Beads | Beads | Beads | Memory Bank | Beads |
| **Proposals** | OpenSpec | OpenSpec | OpenSpec | OpenSpec | OpenSpec |

### How Forge Adapts

**Claude Code** (Full Support):
```bash
/status           # Native slash command
/tasks save       # Built-in task persistence
bd ready          # Beads integration
```

**Cursor/Windsurf** (Near-Full Support):
```bash
# Read AGENTS.md instructions
# Use Memories/Memory for persistence
# Same Beads/OpenSpec workflow
```

**Other Agents** (AGENTS.md Fallback):
```
The agent reads AGENTS.md and follows the 9-stage workflow.
Users describe what stage they're at: "I'm at the /dev stage"
Agent follows the documented process.
```

### The Universal Principle

Even without slash commands, the **workflow principles** work everywhere:

1. **Check status before starting** - Review active work, git state
2. **Research before building** - Document decisions
3. **Plan formally** - Create tracking issue, branch
4. **TDD development** - RED-GREEN-REFACTOR
5. **Validate thoroughly** - Type/lint/test/security
6. **Document in PR** - Link research, list tests
7. **Address ALL feedback** - CI failures, reviews
8. **Update docs before merge** - PROGRESS.md, API docs
9. **Verify completeness** - Cross-check everything

### Persistence Across Agents

| Agent | How to Persist Context |
|-------|------------------------|
| **Claude Code** | `/tasks save`, Beads issues |
| **Cursor** | Composer memory, Beads |
| **Windsurf** | Cascade Memories, Beads |
| **Kilo Code** | Memory Bank, Beads |
| **Cline** | Memory Bank, Beads |
| **Others** | Beads (git-backed, universal) |

**Beads is the universal solution** - it works with ANY agent because it's git-backed.

### Why This Architecture?

```
┌─────────────────────────────────────────────────────────────┐
│                    FORGE ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│   AGENTS.md (Universal)                                      │
│   ├── Works with EVERY agent                                 │
│   ├── Plain markdown, no special features needed             │
│   └── Contains full workflow documentation                   │
│                                                              │
│   Agent-Specific Enhancements (Optional)                     │
│   ├── .claude/commands/  -> Native slash commands            │
│   ├── .cursor/rules/     -> Cursor MDC rules                 │
│   ├── .windsurf/workflows/ -> Windsurf workflows             │
│   └── etc.                                                   │
│                                                              │
│   External Tools (Universal)                                 │
│   ├── Beads   -> Issue tracking (git-backed)                 │
│   ├── OpenSpec -> Architectural proposals                    │
│   └── GitHub CLI -> PR workflow                              │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

The workflow **degrades gracefully**:
- Full features in Claude Code
- Most features in Cursor/Windsurf/Kilo
- Core workflow in ANY agent via AGENTS.md

## License

MIT

## Contributing

Contributions welcome! Please read `docs/WORKFLOW.md` before submitting PRs.

---

**Start with:** `npm install forge-workflow && npx forge setup`

**Then:** `/status` to see where to begin!
