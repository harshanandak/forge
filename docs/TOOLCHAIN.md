# Forge Toolchain Reference

Complete reference for all tools integrated with the Forge workflow.

## Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        FORGE TOOLCHAIN                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐   ┌─────────────────────┐                     │
│  │   BEADS     │   │  EXTERNAL SERVICES  │                     │
│  │   (bd)      │   │                     │                     │
│  │             │   │  Parallel AI        │                     │
│  │ Git-backed  │   │  Greptile           │                     │
│  │ Issue       │   │  SonarCloud         │                     │
│  │ Tracking    │   │  GitHub CLI         │                     │
│  └─────────────┘   └─────────────────────┘                     │
│        │                     │                                 │
│        └─────────────────────┘                                 │
│                          │                                      │
│                    ┌─────▼─────┐                                │
│                    │   FORGE   │                                │
│                    │  7-Stage  │                                │
│                    │  Workflow │                                │
│                    └───────────┘                                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Shell Model

Forge commands and repo scripts run under the shell shown below:

| Platform | Shell used by Forge commands and scripts |
| --- | --- |
| Windows | WSL is the supported/recommended environment for Forge commands and repo scripts |
| macOS/Linux | Default login shell |

Windows gotchas (supported workflow):

- Paths crossing between Windows tools and WSL scripts may need translation with `wslpath`.
- Git Bash/native PowerShell may work for some commands, but are not supported troubleshooting targets for Forge script execution.
- Some bootstrap paths still invoke native Windows tools such as `powershell.exe`; this does not change the supported shell model for repo scripts.

---

## Beads - Dolt-Backed Issue Tracking

**Package**: `@beads/bd`  
**Repository**: [github.com/steveyegge/beads](https://github.com/steveyegge/beads)  
**Purpose**: Distributed issue tracking designed for AI coding agents

### Current Forge Target

- Forge now targets the stable Beads `v1.0.0` release for repo setup and CI.
- Routine team sync still goes through `forge sync`.
- Use `bd` directly for Beads features Forge does not wrap yet, such as `bd init`, `bd comments`, `bd dep`, `bd blocked`, `bd backup`, and `bd dolt *`.

### Install or Update Beads

**Recommended**:
```bash
bunx forge setup
bd --version
```

**Manual install**:
```bash
# Windows
irm https://raw.githubusercontent.com/steveyegge/beads/main/install.ps1 | iex
bd --version

# CI / pinned Linux install
BD_VERSION="1.0.0"
BD_URL="https://github.com/steveyegge/beads/releases/download/v${BD_VERSION}/beads_${BD_VERSION}_linux_amd64.tar.gz"
mkdir -p "$HOME/.local/bin"
curl -fsSL "$BD_URL" | tar -xz -C "$HOME/.local/bin" bd
chmod +x "$HOME/.local/bin/bd"
```

Verify the installed CLI before using it:

```bash
bd --version
bd doctor
```

### Supported Repo Layout

Forge treats `.beads/` as the repo-local Beads home directory. The layout in this repository currently includes:

```text
.beads/
├── config.yaml
├── issues.jsonl
├── metadata.json
├── team-map.jsonl
├── hooks/
└── .gitignore
```

Legacy local database cache files are no longer part of the supported Forge setup instructions. When you need JSONL snapshots for migration verification or CI diffing, generate them explicitly with `bd backup --force`.

### Migrate Legacy SQLite Data

Use the repo wrapper instead of hand-editing `.beads/`:

```bash
bash scripts/beads-migrate-to-dolt.sh
```

Default paths used by the wrapper:

- `--project-root`: current working directory
- `--legacy-backup-dir`: `.beads/backup`
- `--snapshot-root`: `.beads-migration-snapshots`
- `--migrated-dir`: `.beads-migrated`
- `--export-dir`: `.beads-migrated-export`

What the wrapper does:

1. Snapshots the current `.beads/` directory into `.beads-migration-snapshots/<timestamp>/current-beads`.
2. Restores the legacy JSONL backup into a fresh migrated workspace.
3. Exports a fresh backup snapshot for parity verification.
4. Verifies issue IDs, dependency edges, comment IDs, config keys, and record counts.
5. Writes `.beads-migrated/migration-manifest.json` on success.

rollback behavior:

- The wrapper automatically restores the pre-migration `.beads/` snapshot if parity verification fails.
- If you need to inspect or restore manually, use the timestamped snapshot under `.beads-migration-snapshots/`.

See the script help for explicit path overrides:

```bash
bash scripts/beads-migrate-to-dolt.sh --help
```

### Post-Upgrade Smoke Verification

Run the repo smoke harness after upgrading:

```bash
bash scripts/beads-upgrade-smoke.sh
```

The harness records a machine-readable summary at `.artifacts/beads-upgrade-smoke/summary.json` by default and exercises this sequence:

1. `bd create` primary smoke issue
2. `bd create` dependent smoke issue
3. `bd list --json --limit=0`
4. `bd show <id> --json`
5. `bd dep add <child> <parent>`
6. `bd close <id>` cleanup for both smoke issues
7. `bd sync` compatibility check

If any command fails, the summary captures `failedStep`, command output, and cleanup state. This is intentional: the harness does not silently substitute a different command for `bd sync`.

### Day-to-Day Commands

```bash
# Find work
forge ready
forge show <id>
forge claim <id>

# Issue operations
forge create "Title"
forge list
forge update <id> --priority 2
forge close <id>

# Direct beads operations
bd comments add <id> "Progress update"
bd dep add <child> <parent>
bd dep cycles
bd backup --force
bd dolt status

# Routine repo sync
forge sync
```

### Session Workflow

```bash
# Start of session
forge ready
forge show <id>
forge claim <id>

# During work
bd comments add <id> "Progress update"
forge update <id> --notes "Found edge case"

# End of session
forge close <id>
forge sync
```

---

## MCP Servers

### Context7 - Library Documentation

**Package**: `@upstash/context7-mcp@2` (pin to major version, not `@latest`)
**Purpose**: Up-to-date documentation and code examples for any programming library
**Used in**: `/plan` stage (Phase 2 research); any library lookup

Context7 provides current documentation that may be more recent than the AI's training data.

**Installation**:

**Claude Code**: Add to `.mcp.json` in your project root:


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

**Cline (VSCode)**:
1. Open VSCode Settings
2. Search for "Cline MCP"
3. Add Context7 server configuration

**Cursor**: Check Cursor Settings → MCP Servers for configuration options

**Other agents**: If your agent supports MCP, configure using the JSON format above

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

### grep.app - Code Search

**Package**: `@ai-tools-all/grep_app_mcp` (recommended) or `@galprz/grep-mcp`
**Website**: [grep.app](https://grep.app)
**Purpose**: Search across 1M+ public GitHub repositories for real-world code examples
**Used in**: `/plan` stage (Phase 2 research); finding implementation patterns

grep.app provides code search across public GitHub repositories to find real-world examples and patterns.

**Installation (Claude Code)**:

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "context7": {
      "command": "bunx",
      "args": ["--bun", "@upstash/context7-mcp@latest"]
    },
    "grep-app": {
      "command": "bunx",
      "args": ["--bun", "@ai-tools-all/grep_app_mcp"]
    }
  }
}
```

**Usage**:
```
# The AI will use grep.app when you need real-world examples
"Find examples of React useEffect cleanup patterns"
"Show me how others implement JWT authentication in Express"
"Search for rate limiting implementations in Node.js"
```

**When to use grep.app**:

- Finding real-world implementation examples
- Discovering coding patterns in production code
- Validating implementation approaches
- Learning from open source projects

**Context7 vs grep.app**:

| Tool           | Purpose                        | Use When                                  |
|----------------|--------------------------------|-------------------------------------------|
| **Context7**   | Official library documentation | You need API reference, official patterns |
| **grep.app**   | Real code in the wild          | You want to see how others solve problems |

---

## External Services

### Parallel AI - Web Research

**Website**: [platform.parallel.ai](https://platform.parallel.ai)
**Used in**: `/plan` stage (Phase 2 research)

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
**Used in**: `/validate` stage

No external server required - uses your project's linting configuration.

```bash
# Already configured via package.json or eslint.config.js
bun run lint
```

### Option 2: SonarCloud (Cloud-Hosted)

**Website**: [sonarcloud.io](https://sonarcloud.io)
**Used in**: `/validate` stage
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
bunx sonarqube-scanner
```

### Option 3: SonarQube Community (Self-Hosted, FREE)

**Website**: [sonarqube.org](https://www.sonarsource.com/products/sonarqube/)
**Used in**: `/validate` stage
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
bunx sonarqube-scanner
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
**Used in**: `/ship`, `/review`, `/premerge` stages

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

## Global CLI Tools

### Beads (`bd`) — Minimum Version

**Recommended stable version**: `v1.0.0`
**Check installed version**:
```bash
bd --version
```

**Install / Update**:
```bash
# Recommended
bunx forge setup

# Windows — use PowerShell installer (npm has EPERM bug)
irm https://raw.githubusercontent.com/steveyegge/beads/main/install.ps1 | iex
```

> **Why Forge + Beads?** Forge wraps the supported day-to-day issue workflow
> (`forge ready`, `forge create`, `forge close`, `forge sync`) while Beads
> remains the underlying store for initialization, dependencies, comments, and
> Dolt-backed sync internals.

---

## Integration with Forge Stages

| Stage | Tools Used |
|-------|------------|
| `/status` | `forge ready`, `forge list`, `git status` |
| `/plan` (Phase 2) | Parallel AI, Context7, grep.app, codebase exploration |
| `/plan` | `forge create`, `git checkout -b` |
| `/dev` | Tests, code, `forge update`, `/tasks save` |
| `/validate` | Type check, lint, tests, SonarCloud |
| `/ship` | `forge close`, `gh pr create` |
| `/review` | `gh pr view`, Greptile, SonarCloud |
| `/premerge` | `forge sync`, doc updates, hand off PR |
| `/verify` | Documentation cross-check |

---

## Quick Reference Card

### Beads (Issue Tracking)

```bash
bd init                     # Initialize
forge ready                 # Find unblocked work
forge create "Title"        # Create issue
forge show <id>             # View details
forge update <id> --status X   # Update status
bd dep add <a> <b>          # a depends on b
forge close <id>            # Complete
forge sync                  # Routine repo sync
bash scripts/beads-migrate-to-dolt.sh
bash scripts/beads-upgrade-smoke.sh
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
# macOS / Linux
bun add -g @beads/bd
# Or use bunx @beads/bd <command>

# Windows — use PowerShell installer
irm https://raw.githubusercontent.com/steveyegge/beads/main/install.ps1 | iex
```

**Windows EPERM error during `npm install -g @beads/bd`**
```bash
# npm @beads/bd has a known EPERM bug on Windows (Issue #1031)
# Use the PowerShell installer instead:
irm https://raw.githubusercontent.com/steveyegge/beads/main/install.ps1 | iex
```

**"database locked"**
```bash
forge sync
```

**Issues not showing after git pull**
```bash
forge sync  # Re-syncs Beads state through the Forge wrapper
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
- **Parallel AI**: [platform.parallel.ai](https://platform.parallel.ai)
- **Greptile**: [greptile.com](https://greptile.com)
- **SonarCloud**: [sonarcloud.io](https://sonarcloud.io)
- **GitHub CLI**: [cli.github.com](https://cli.github.com)
