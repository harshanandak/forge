# Forge Toolchain Reference

Complete reference for all tools integrated with the Forge workflow.

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        FORGE TOOLCHAIN                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────────────┐   │
│  │   BEADS     │   │  OPENSPEC   │   │  EXTERNAL SERVICES  │   │
│  │   (bd)      │   │  (opsx)     │   │                     │   │
│  │             │   │             │   │  Parallel AI        │   │
│  │ Git-backed  │   │ Spec-driven │   │  Greptile           │   │
│  │ Issue       │   │ Development │   │  SonarCloud         │   │
│  │ Tracking    │   │             │   │  GitHub CLI         │   │
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

---

## Beads - Git-Backed Issue Tracking

**Package**: `@beads/bd`
**Repository**: [github.com/steveyegge/beads](https://github.com/steveyegge/beads)
**Purpose**: Distributed issue tracking designed for AI coding agents

### Why Beads?

- **Persists across sessions** - Issues survive context clearing, compaction, new chats
- **Git-backed** - Version controlled, mergeable, team-shareable
- **Dependency tracking** - Know what blocks what
- **Ready detection** - `bd ready` finds unblocked work automatically
- **AI-optimized** - JSON output, semantic compaction, audit trails

### Installation

```bash
# npm (recommended)
npm install -g @beads/bd

# Or with bunx (no global install)
bunx @beads/bd init
```

### File Structure

After `bd init`, creates `.beads/` directory:

```
.beads/
├── issues.jsonl      # Issue data (git-tracked, one JSON per line)
├── beads.db          # SQLite cache (git-ignored, fast queries)
├── metadata.json     # Database metadata
├── config.yaml       # User configuration
├── interactions.jsonl # Agent audit log
└── .gitignore        # Ignores beads.db
```

**Dual-database architecture**: JSONL for git versioning, SQLite for fast local queries. Background daemon keeps them in sync.

### Complete Command Reference

#### Initialization

```bash
bd init                    # Initialize in project
bd init --stealth          # Local-only (don't commit to repo)
bd init --contributor      # Contributor mode
bd init --prefix PROJ      # Custom issue prefix (PROJ-xxx)
```

#### Issue Management

```bash
# Create issues
bd create "Title"                           # Basic issue
bd create "Title" --type feature            # With type (feature, bug, chore, etc.)
bd create "Title" --priority 1              # With priority (0=critical, 4=backlog)
bd create "Title" -p 0 -l "urgent,backend"  # P0 with labels

# View issues
bd show <id>                   # Detailed view with audit trail
bd list                        # All issues
bd list --status open          # Filter by status
bd list --priority 1           # Filter by priority
bd list --assignee bob         # Filter by assignee
bd list --label bug            # Filter by label (AND logic)
bd list --label-any bug,urgent # Filter by label (OR logic)
bd list --type feature         # Filter by type
bd list --title-contains "auth" # Search titles
bd list --limit 10             # Limit results

# Update issues
bd update <id> --status in_progress     # Change status
bd update <id> --priority 2             # Change priority
bd update <id> --assignee bob           # Assign
bd update <id> --title "New title"      # Update title
bd update <id> --description "..."      # Update description
bd update <id> --notes "..."            # Add notes
bd update <id> --label-add urgent       # Add label

# Complete issues
bd close <id>                           # Close single issue
bd close <id1> <id2> <id3>              # Close multiple (efficient)
bd close <id> --reason "Completed auth" # Close with reason
bd delete <id>                          # Delete issue
bd delete <id> --cascade                # Delete with dependents
```

#### Workflow Commands

```bash
# Find work
bd ready                        # Issues with NO open blockers (start here!)
bd ready --priority 1           # Filter ready work by priority
bd blocked                      # Issues that ARE blocked

# Dependencies
bd dep add <child> <parent>                    # child depends on parent (blocks)
bd dep add <child> <parent> --type related     # Soft reference (no blocking)
bd dep add <child> <parent> --type parent-child # Hierarchical
bd dep remove <child> <parent>                 # Remove dependency
bd dep tree <id>                               # Visualize dependency tree
bd dep cycles                                  # Detect cycles

# Comments
bd comments <id>                # View comments
bd comments <id> "Comment text" # Add comment

# Git sync
bd sync                         # Export to JSONL, commit, push
bd sync --status                # Check sync status
bd hooks install                # Install git hooks for auto-sync

# Maintenance
bd stats                        # Project statistics
bd doctor                       # Check for issues
bd admin compact --days 90      # Compact old closed issues
```

#### Issue Statuses

- `open` - Not started
- `in_progress` - Being worked on
- `blocked` - Waiting on something
- `completed` - Done
- `on_hold` - Paused
- `cancelled` - Won't do

#### Priority Levels

| Priority | Meaning | Usage |
|----------|---------|-------|
| 0 (P0) | Critical | Drop everything, fix now |
| 1 (P1) | High | Do this sprint |
| 2 (P2) | Medium | Planned work |
| 3 (P3) | Low | Nice to have |
| 4 (P4) | Backlog | Someday/maybe |

#### Dependency Types

| Type | Blocks Ready? | Use Case |
|------|---------------|----------|
| `blocks` | YES | Hard dependency |
| `related` | NO | Soft reference |
| `parent-child` | YES | Hierarchy |
| `discovered-from` | NO | Found during work |

### Session Workflow

```bash
# Start of session
bd ready                    # What can I work on?
bd show <id>                # Review the issue
bd update <id> --status in_progress

# During work
bd comments <id> "Progress update"
bd update <id> --notes "Found edge case"

# End of session
bd close <id>               # If done, or:
bd update <id> --status blocked --comment "Needs API response"
bd sync                     # Always sync at end!
```

---

## OpenSpec - Spec-Driven Development

**Package**: `@fission-ai/openspec`
**Repository**: [github.com/Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec)
**Website**: [openspec.dev](https://openspec.dev)
**Purpose**: Structured specifications for AI-assisted development

### Why OpenSpec?

- **Specs before code** - AI reads requirements, not just vibes
- **Non-linear workflow** - Commands execute in any order
- **Git-native** - Specs versioned like code
- **Multi-agent** - Works with 21+ AI tools
- **Zero dependencies** - No API keys, no external services

### Installation

```bash
# npm (requires Node.js 20.19+)
npm install -g @fission-ai/openspec

# Or with bunx
bunx @fission-ai/openspec init
```

### File Structure

After `openspec init`:

```
openspec/
├── specs/
│   └── [domain]/
│       └── spec.md           # Source of truth for each domain
│
├── changes/
│   ├── [change-name]/
│   │   ├── proposal.md       # Intent, scope, rationale
│   │   ├── design.md         # Technical approach
│   │   ├── tasks.md          # Implementation checklist
│   │   └── specs/
│   │       └── [domain]/
│   │           └── spec.md   # Delta specifications
│   └── archive/              # Completed changes
│
├── schemas/
│   └── default.yaml          # Workflow schema
│
└── config.yaml               # Project configuration

.agent/
└── AGENTS.md                 # AI instructions
```

### CLI Commands

```bash
# Setup
openspec init [path]          # Initialize OpenSpec
openspec update               # Update after CLI upgrade

# Browse
openspec list                 # Display changes/specs
openspec view                 # Interactive terminal dashboard
openspec show [name]          # Show detailed content
openspec status               # Artifact completion progress

# Validation
openspec validate [name]      # Check structural integrity
openspec validate --strict    # Strict validation

# Lifecycle
openspec sync                 # Merge delta specs into main specs
openspec archive [name]       # Finalize completed changes

# Schema
openspec schema init          # Create new schema
openspec schema fork          # Fork existing schema
openspec schema validate      # Validate schema
openspec schemas              # List available schemas
```

### AI Slash Commands (Claude Code, Cursor, Windsurf)

```bash
/opsx:explore     # Think through ideas, investigate
/opsx:new         # Start a new change initiative
/opsx:continue    # Create next artifact (incremental)
/opsx:ff          # Fast-forward: generate all planning artifacts
/opsx:apply       # Implement tasks
/opsx:sync        # Merge delta specs into main specs
/opsx:archive     # Mark change complete
/opsx:verify      # Validate implementation matches specs
/opsx:onboard     # Interactive tutorial
```

### Spec Format

OpenSpec uses structured markdown with normative language:

```markdown
# Authentication Specification

## Purpose
Enable secure user identity verification and session management

## Requirements

### Requirement: Session Token Validation
The system SHALL validate session tokens on every request

#### Scenario: Valid Session
- **GIVEN** user has authenticated
- **WHEN** request includes valid session token
- **THEN** process the request
- **AND** update token expiration time

#### Scenario: Expired Session
- **GIVEN** user had authenticated but 24 hours have passed
- **WHEN** request includes expired session token
- **THEN** invalidate the token
- **AND** redirect to login
```

### Delta Format

Changes use ADDED/MODIFIED/REMOVED notation:

```markdown
# Delta for Authentication

## ADDED Requirements
### Requirement: Two-Factor Authentication
The system SHALL support optional 2FA

#### Scenario: 2FA Enrollment
- **GIVEN** user enables 2FA in settings
- **WHEN** they scan QR code with authenticator app
- **THEN** 2FA is activated for their account

## MODIFIED Requirements
### Requirement: Session Token Validation
[Updated content here]

## REMOVED Requirements
### Requirement: Remember Me Cookie
```

### When to Use OpenSpec

| Scope | Use OpenSpec? | Example |
|-------|---------------|---------|
| **Tactical** (< 1 day) | No | Bug fix, small feature |
| **Strategic** (architecture) | Yes | New service, API redesign |
| **Breaking changes** | Yes | Schema migrations |
| **Multi-session work** | Yes | Large features |

### Workflow Example

```bash
# 1. Start new change
/opsx:new
# Describe: "Add payment processing with Stripe"
# Select schema: default

# 2. Generate all planning docs
/opsx:ff
# Creates: proposal.md, design.md, tasks.md, specs/

# 3. Implement
/opsx:apply
# AI writes code following tasks.md

# 4. Verify
/opsx:verify
# Confirms implementation matches specs

# 5. Finalize
/opsx:sync     # Merge deltas into main specs
/opsx:archive  # Move to archive
```

---

## MCP Servers

### Context7 - Library Documentation

**Package**: `@upstash/context7-mcp@latest`
**Purpose**: Up-to-date documentation and code examples for any programming library
**Used in**: `/research` stage, any library lookup

Context7 provides current documentation that may be more recent than the AI's training data.

**Installation (Claude Code)**:

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"]
    }
  }
}
```

**Or with bunx**:
```json
{
  "mcpServers": {
    "context7": {
      "command": "bunx",
      "args": ["--bun", "@upstash/context7-mcp@latest"]
    }
  }
}
```

**Usage**:
```
# The AI will automatically use Context7 when you ask about libraries
"How do I use React Query's useMutation hook?"
"What's the latest Next.js App Router API?"
"Show me Supabase RLS policy examples"
```

**When to use Context7**:
- Before implementing a library feature
- When official docs may have changed since AI training
- To verify API signatures and patterns
- For current best practices

---

## External Services

### Parallel AI - Web Research

**Website**: [platform.parallel.ai](https://platform.parallel.ai)
**Used in**: `/research` stage

4 APIs for research:
- **Search** - Web search with AI analysis
- **Extract** - Scrape specific URLs
- **Task** - Structured data enrichment
- **Deep Research** - Multi-source analysis

```bash
# Setup
# 1. Get key from https://platform.parallel.ai
# 2. Add to .env.local
PARALLEL_API_KEY=your-key

# Test
API_KEY=$(grep "^PARALLEL_API_KEY=" .env.local | cut -d= -f2)
curl -s -X POST "https://api.parallel.ai/v1beta/search" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -H "parallel-beta: search-extract-2025-10-10" \
  -d '{"objective": "Next.js authentication best practices 2026"}'
```

---

## Code Review Tools

Choose ONE code review tool based on your needs:

| Tool | Pricing | Best For | Setup |
|------|---------|----------|-------|
| **GitHub Code Quality** | FREE | All GitHub repos | Built-in, zero setup |
| **CodeRabbit** | FREE (OSS) | Open source projects | GitHub App |
| **Greptile** | $99+/mo | Enterprise | API key |

### Option 1: GitHub Code Quality (FREE, Recommended)

**Status**: Built-in to GitHub
**Used in**: `/review` stage

Zero setup required - GitHub's code quality features are enabled by default.

Features:
- Automatic code scanning
- Dependency vulnerability alerts
- Secret scanning
- Code navigation

### Option 2: CodeRabbit (FREE for Open Source)

**Website**: [coderabbit.ai](https://coderabbit.ai)
**Used in**: `/review` stage

AI-powered code review with deep context understanding.

```bash
# Setup
# 1. Go to https://coderabbit.ai
# 2. Install the GitHub App
# 3. Enable for your repositories

# Configuration (optional)
# Create .coderabbit.yaml in repo root
```

### Option 3: Greptile (Paid - Enterprise)

**Website**: [greptile.com](https://greptile.com)
**Used in**: `/review` stage

Enterprise-grade AI code review that understands your codebase.

```bash
# Setup
# 1. Get key from https://app.greptile.com
# 2. Add to .env.local
GREPTILE_API_KEY=your-key

# 3. Index repository (one-time)
curl -X POST "https://api.greptile.com/v2/repositories" \
  -H "Authorization: Bearer $GREPTILE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"remote": "github", "repository": "owner/repo"}'
```

---

## Code Quality Tools

Choose ONE code quality scanner based on your needs:

| Tool | Pricing | Best For | Requirement |
|------|---------|----------|-------------|
| **ESLint** | FREE | All projects | Built-in |
| **SonarCloud** | 50k LoC free | Cloud-first teams | API key |
| **SonarQube Community** | FREE | Self-hosted, unlimited | Docker |

### Option 1: ESLint Only (FREE, Recommended)

**Status**: Built-in
**Used in**: `/check` stage

No external server required - uses your project's linting configuration.

```bash
# Already configured via package.json or eslint.config.js
npm run lint  # or bun run lint
```

### Option 2: SonarCloud (Cloud-Hosted)

**Website**: [sonarcloud.io](https://sonarcloud.io)
**Used in**: `/check` stage
**Free Tier**: 50,000 lines of code

Static analysis for bugs, vulnerabilities, code smells.

```bash
# Setup
# 1. Create project at https://sonarcloud.io
# 2. Get token from Security settings
# 3. Add to .env.local
SONAR_TOKEN=your-token
SONAR_ORGANIZATION=your-org
SONAR_PROJECT_KEY=your-project

# 4. Create sonar-project.properties
echo "sonar.organization=$SONAR_ORGANIZATION
sonar.projectKey=$SONAR_PROJECT_KEY
sonar.sources=src" > sonar-project.properties

# 5. Run analysis
npx sonarqube-scanner
```

### Option 3: SonarQube Community (Self-Hosted, FREE)

**Website**: [sonarqube.org](https://www.sonarsource.com/products/sonarqube/)
**Used in**: `/check` stage
**Pricing**: FREE, unlimited lines of code

Self-hosted code quality analysis - no cloud dependency.

```bash
# Setup with Docker
docker run -d --name sonarqube \
  -p 9000:9000 \
  sonarqube:community

# Access at http://localhost:9000
# Default credentials: admin/admin

# Add to .env.local
SONARQUBE_URL=http://localhost:9000
SONARQUBE_TOKEN=your-token  # Generate in SonarQube UI

# Create sonar-project.properties
echo "sonar.host.url=$SONARQUBE_URL
sonar.login=$SONARQUBE_TOKEN
sonar.projectKey=your-project
sonar.sources=src" > sonar-project.properties

# Run analysis
npx sonarqube-scanner
```

**Docker Compose (Production)**:
```yaml
# docker-compose.yml
version: '3'
services:
  sonarqube:
    image: sonarqube:community
    ports:
      - "9000:9000"
    environment:
      - SONAR_ES_BOOTSTRAP_CHECKS_DISABLE=true
    volumes:
      - sonarqube_data:/opt/sonarqube/data
      - sonarqube_logs:/opt/sonarqube/logs

volumes:
  sonarqube_data:
  sonarqube_logs:
```

---

### GitHub CLI - PR Workflow

**Installation**: [cli.github.com](https://cli.github.com)
**Used in**: `/ship`, `/review`, `/merge` stages

```bash
# Install
# macOS: brew install gh
# Windows: winget install GitHub.cli
# Linux: sudo apt install gh

# Authenticate
gh auth login

# Common commands
gh pr create --title "..." --body "..."
gh pr view <number>
gh pr checks <number>
gh pr merge <number> --squash --delete-branch
gh issue create --title "..." --body "..."
```

---

## Integration with Forge Stages

| Stage | Tools Used |
|-------|------------|
| `/status` | `bd ready`, `bd list`, `git status`, `openspec list` |
| `/research` | Parallel AI, codebase exploration |
| `/plan` | `bd create`, `openspec` (if strategic), `git checkout -b` |
| `/dev` | Tests, code, `bd update`, `/tasks save` |
| `/check` | Type check, lint, tests, SonarCloud |
| `/ship` | `bd update --status done`, `gh pr create` |
| `/review` | `gh pr view`, Greptile, SonarCloud |
| `/merge` | `gh pr merge`, `openspec archive`, `bd sync` |
| `/verify` | Documentation cross-check |

---

## Quick Reference Card

### Beads (Issue Tracking)

```bash
bd init                     # Initialize
bd ready                    # Find unblocked work
bd create "Title"           # Create issue
bd show <id>                # View details
bd update <id> --status X   # Update status
bd dep add <a> <b>          # a depends on b
bd close <id>               # Complete
bd sync                     # Git sync
```

### OpenSpec (Specifications)

```bash
openspec init               # Initialize
/opsx:new                   # Start change (AI)
/opsx:ff                    # Generate all docs (AI)
/opsx:apply                 # Implement (AI)
openspec validate <name>    # Validate
openspec archive <name>     # Complete
```

### GitHub CLI

```bash
gh auth login               # Authenticate
gh pr create                # Create PR
gh pr view <n>              # View PR
gh pr checks <n>            # Check status
gh pr merge <n> --squash    # Merge
```

---

## Troubleshooting

### Beads

**"bd: command not found"**
```bash
npm install -g @beads/bd
# Or use bunx @beads/bd <command>
```

**"database locked"**
```bash
bd sync --force
```

**Issues not showing after git pull**
```bash
bd sync  # Re-imports from JSONL
```

### OpenSpec

**"openspec: command not found"**
```bash
npm install -g @fission-ai/openspec
# Or use bunx @fission-ai/openspec <command>
```

**Validation errors**
```bash
openspec validate <name> --verbose
```

### GitHub CLI

**"gh: not authenticated"**
```bash
gh auth login
gh auth status
```

---

## Resources

- **Beads**: [github.com/steveyegge/beads](https://github.com/steveyegge/beads)
- **OpenSpec**: [openspec.dev](https://openspec.dev) | [github.com/Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec)
- **Parallel AI**: [platform.parallel.ai](https://platform.parallel.ai)
- **Greptile**: [greptile.com](https://greptile.com)
- **SonarCloud**: [sonarcloud.io](https://sonarcloud.io)
- **GitHub CLI**: [cli.github.com](https://cli.github.com)
