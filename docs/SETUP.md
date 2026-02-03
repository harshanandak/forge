# Forge Setup Guide

Complete setup instructions for all AI agents and optional toolchain.

---

## Table of Contents

- [Installation Options](#installation-options)
- [Agent-Specific Setup](#agent-specific-setup)
- [Prerequisites](#prerequisites)
- [Toolchain Setup](#toolchain-setup)
- [External Services](#external-services)
- [Troubleshooting](#troubleshooting)

---

## Installation Options

### Option 1: npm (Recommended)

```bash
# Step 1: Install the package
npm install forge-workflow

# Step 2: Interactive setup
npx forge setup
```

**Interactive prompts**:
1. Which agents do you use?
2. Install Beads? (y/n) - Git-backed issue tracking
3. Install OpenSpec? (y/n) - Spec-driven development
4. Configure external services? (optional)

**What gets created**:
- `AGENTS.md` - Universal instructions (always)
- Agent-specific files based on your selection
- `docs/` folder with workflow guides

### Option 2: Specify Agents Directly

```bash
# Install for specific agents
npx forge setup --agents claude,cursor,windsurf

# Install for all agents
npx forge setup --all
```

### Option 3: curl (One-Command Install)

```bash
curl -fsSL https://raw.githubusercontent.com/harshanandak/forge/main/install.sh | bash
```

**Interactive prompts**:
1. Which agents do you use?
2. Install Beads? (y/n)
3. Install OpenSpec? (y/n)

### Option 4: bun

```bash
bun add forge-workflow
bunx forge setup
```

---

## Agent-Specific Setup

### Claude Code

**Files created**:
- `CLAUDE.md` → Linked to `AGENTS.md`
- `.claude/commands/` → 9 slash commands
- `.claude/rules/workflow.md` → Workflow rules
- `.claude/skills/forge-workflow/` → Skill files

**Usage**:
```bash
/status
/research feature-name
/plan feature-name
/dev
# ... etc
```

**Skills available**:
- `forge-workflow` - All 9 stages
- `parallel-ai` - Web research (if API key configured)
- `sonarcloud` - Code quality (if token configured)

---

### Cursor

**Files created**:
- `.cursorrules` → Linked to `AGENTS.md`
- `.cursor/rules/forge-workflow.mdc` → MDC rules
- `.cursor/skills/forge-workflow/` → Skill files

**Usage**:
Cursor reads `.cursorrules` and follows the 9-stage workflow.

**Commands**:
Use Composer or Chat to reference stages:
```
"I'm at the /dev stage - help me write tests first"
```

---

### Windsurf

**Files created**:
- `.windsurfrules` → Linked to `AGENTS.md`
- `.windsurf/workflows/` → Workflow files
- `.windsurf/skills/forge-workflow/` → Skill files

**Usage**:
```bash
/status
/research feature-name
# ... etc
```

Windsurf has native slash command support similar to Claude Code.

---

### GitHub Copilot

**Files created**:
- `.github/copilot-instructions.md` → Linked to `AGENTS.md`
- `.github/prompts/` → Workflow prompts

**Usage**:
Copilot reads instructions from `.github/copilot-instructions.md`.

**In Copilot Chat**:
```
@workspace I'm starting a new feature, help me with the /research stage
```

---

### Google Antigravity

**Files created**:
- `GEMINI.md` → Linked to `AGENTS.md`
- `.agent/workflows/` → Workflow files
- `.agent/skills/forge-workflow/` → Skill files

**Usage**:
```bash
/status
/research feature-name
# ... etc
```

---

### Kilo Code, OpenCode, Continue, Cline, Roo Code, Aider

**Files created**:
- Agent-specific config pointing to `AGENTS.md`
- Skill files in agent's skill directory

**Usage**:
All agents read `AGENTS.md` and follow the documented workflow.

**Example (any agent)**:
```
"Let's follow the Forge workflow. I want to add a login button.
Start with the /research stage."
```

---

## Prerequisites

### Required

#### Git

```bash
# Verify installation
git --version

# If not installed:
# macOS: brew install git
# Windows: winget install Git.Git
# Linux: sudo apt install git
```

#### GitHub CLI

**Required for** `/ship`, `/review`, `/merge` commands.

```bash
# macOS
brew install gh

# Windows
winget install GitHub.cli

# Linux
sudo apt install gh

# Authenticate
gh auth login
```

**Follow prompts**:
1. Select "GitHub.com"
2. Select "HTTPS"
3. Select "Login with a web browser"
4. Copy one-time code and paste in browser

**Verify**:
```bash
gh auth status
```

---

### Recommended

#### Beads - Issue Tracking

**Recommended for**: Multi-session work, team collaboration

```bash
# Install globally
npm install -g @beads/bd

# Initialize in your project
cd your-project
bd init

# Verify
bd list
```

**What it does**:
- Git-backed issue tracking
- Survives context clearing
- Dependency tracking
- Team-shareable

[Full Beads guide in TOOLCHAIN.md](TOOLCHAIN.md#beads---issue-tracking-across-sessions)

---

### Optional

#### OpenSpec - Spec-Driven Development

**Use for**: Architecture changes, breaking changes, multi-session features

**Requirements**: Node.js 20.19+

```bash
# Check Node version
node --version

# Install globally
npm install -g @fission-ai/openspec

# Initialize in project
cd your-project
openspec init

# Verify
openspec list
```

**What it does**:
- Proposal system for architecture changes
- Generates planning docs automatically
- Task tracking with delta specs

[Full OpenSpec guide in TOOLCHAIN.md](TOOLCHAIN.md#openspec---spec-driven-development)

---

## Toolchain Setup

### Beads Configuration

After `bd init`, customize `.beads/config.yaml`:

```yaml
# .beads/config.yaml
project:
  name: "your-project"
  prefix: "PROJ"  # Issue IDs: PROJ-1, PROJ-2, etc.

priorities:
  0: "critical"
  1: "high"
  2: "medium"
  3: "low"
  4: "backlog"

statuses:
  - "open"
  - "in_progress"
  - "blocked"
  - "done"

labels:
  - "bug"
  - "feature"
  - "chore"
  - "security"
```

**Custom prefix**:
```bash
bd init --prefix MYPROJ
```

**Stealth mode** (local only, don't commit):
```bash
bd init --stealth
```

---

### OpenSpec Configuration

After `openspec init`, customize `openspec.config.json`:

```json
{
  "specsDir": "openspec/specs",
  "changesDir": "openspec/changes",
  "archiveDir": "openspec/archive",
  "templates": {
    "proposal": "default",
    "design": "default",
    "tasks": "default"
  }
}
```

---

## External Services

Forge integrates with external services for enhanced capabilities. **All are optional** - Forge works standalone.

### Code Review Tools

| Tool | Pricing | Best For | Setup Time |
|------|---------|----------|------------|
| **GitHub Code Quality** | FREE | All repos | 0 min (built-in) |
| **CodeRabbit** | FREE (OSS) | Open source | 2 min |
| **Greptile** | $99+/mo | Enterprise | 5 min |

**Recommendation**: Start with GitHub Code Quality (FREE, no setup).

#### GitHub Code Quality Setup

**Already enabled!** Zero configuration required.

GitHub provides built-in code quality features:
- Code scanning
- Dependabot alerts
- Secret scanning
- Pull request checks

#### CodeRabbit Setup (FREE for Open Source)

```bash
# 1. Visit https://coderabbit.ai
# 2. Click "Sign in with GitHub"
# 3. Install GitHub App
# 4. Select repositories

# Done! CodeRabbit reviews all PRs automatically.
```

#### Greptile Setup (Paid - Enterprise)

```bash
# 1. Get API key from https://app.greptile.com
# 2. Add to .env.local
GREPTILE_API_KEY=your-key
CODE_REVIEW_TOOL=greptile

# 3. Index repository (one-time)
curl -X POST "https://api.greptile.com/v2/repositories" \
  -H "Authorization: Bearer $GREPTILE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "remote": "github",
    "repository": "owner/repo",
    "branch": "main"
  }'
```

---

### Code Quality Tools

| Tool | Pricing | Best For | Setup Time |
|------|---------|----------|------------|
| **ESLint** | FREE | All projects | 0 min (built-in) |
| **SonarCloud** | 50k LoC FREE | Cloud hosting | 10 min |
| **SonarQube** | FREE | Self-hosted | 15 min |

**Recommendation**: Start with ESLint (FREE, already in your project).

#### ESLint Setup

**Already configured!** Just run:

```bash
npm run lint
# or
bun run lint
```

#### SonarCloud Setup

```bash
# 1. Create account at https://sonarcloud.io
# 2. Create new project, select your repo
# 3. Get token from Account → Security
# 4. Add to .env.local
SONAR_TOKEN=your-token
SONAR_ORGANIZATION=your-org
SONAR_PROJECT_KEY=your-project
CODE_QUALITY_TOOL=sonarcloud

# 5. Create sonar-project.properties
cat > sonar-project.properties << EOF
sonar.organization=$SONAR_ORGANIZATION
sonar.projectKey=$SONAR_PROJECT_KEY
sonar.sources=src
sonar.tests=tests
sonar.test.inclusions=**/*.test.js,**/*.spec.js
sonar.javascript.lcov.reportPaths=coverage/lcov.info
EOF

# 6. Run analysis locally
npx sonarqube-scanner

# 7. Add to CI (.github/workflows/quality.yml)
```

**GitHub Actions**:
```yaml
# .github/workflows/quality.yml
name: Code Quality
on: [push, pull_request]

jobs:
  sonarcloud:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
        with:
          fetch-depth: 0
      - uses: sonarsource/sonarcloud-github-action@master
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
```

#### SonarQube Setup (Self-Hosted)

```bash
# 1. Start SonarQube with Docker
docker run -d \
  --name sonarqube \
  -p 9000:9000 \
  sonarqube:community

# 2. Access at http://localhost:9000
# Default login: admin/admin
# Change password when prompted

# 3. Create project in SonarQube UI
# 4. Generate token (Administration → Security → Users)
# 5. Add to .env.local
SONARQUBE_URL=http://localhost:9000
SONARQUBE_TOKEN=your-token
CODE_QUALITY_TOOL=sonarqube

# 6. Create sonar-project.properties
cat > sonar-project.properties << EOF
sonar.host.url=http://localhost:9000
sonar.login=$SONARQUBE_TOKEN
sonar.projectKey=your-project
sonar.sources=src
sonar.tests=tests
EOF

# 7. Run analysis
npx sonarqube-scanner
```

---

### Research Tools

#### Parallel AI (Optional - Paid)

**Used in** `/research` stage for deep web research.

```bash
# 1. Get API key from https://platform.parallel.ai
# 2. Add to .env.local
PARALLEL_API_KEY=your-key

# 3. Test
API_KEY=$(grep "^PARALLEL_API_KEY=" .env.local | cut -d= -f2)
curl -s -X POST "https://api.parallel.ai/v1beta/search" \
  -H "x-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -H "parallel-beta: search-extract-2025-10-10" \
  -d '{"objective": "test query"}'
```

**Pricing**: Pay-as-you-go
**Alternative**: Manual web search (FREE)

---

## Environment Variables

### Configuration File

Create `.env.local` in your project root:

```bash
# .env.local (add to .gitignore!)

# ===== TOOL SELECTION =====
CODE_REVIEW_TOOL=github-code-quality  # or: coderabbit, greptile, none
CODE_QUALITY_TOOL=eslint              # or: sonarcloud, sonarqube, none

# ===== REQUIRED: GitHub =====
GITHUB_TOKEN=ghp_xxxxxxxxxxxx

# ===== OPTIONAL: Research =====
PARALLEL_API_KEY=your-parallel-ai-key

# ===== OPTIONAL: Code Review (Greptile) =====
GREPTILE_API_KEY=your-greptile-key

# ===== OPTIONAL: Code Quality (SonarCloud) =====
SONAR_TOKEN=your-sonarcloud-token
SONAR_ORGANIZATION=your-org
SONAR_PROJECT_KEY=your-project

# ===== OPTIONAL: Code Quality (SonarQube) =====
SONARQUBE_URL=http://localhost:9000
SONARQUBE_TOKEN=your-token
```

### Loading Variables

**Forge includes a helper**:

```bash
# Load all variables
source .claude/scripts/load-env.sh

# Or manually
export $(grep -v '^#' .env.local | xargs)
```

**In Claude Code** (automatic):
Variables are loaded when running commands.

**Security**:
```bash
# Add to .gitignore
echo ".env.local" >> .gitignore
```

---

## Directory Structure After Setup

```
your-project/
├── AGENTS.md                    # Universal (always created)
├── CLAUDE.md                    # If Claude selected
├── GEMINI.md                    # If Antigravity selected
├── .cursorrules                 # If Cursor selected
├── .windsurfrules               # If Windsurf selected
├── .clinerules                  # If Cline/Roo selected
│
├── .claude/                     # Claude Code files
│   ├── commands/                # 9 workflow commands
│   ├── rules/workflow.md
│   ├── skills/forge-workflow/
│   └── scripts/load-env.sh
│
├── .cursor/                     # Cursor files
│   ├── rules/forge-workflow.mdc
│   └── skills/forge-workflow/
│
├── .windsurf/                   # Windsurf files
│   ├── workflows/
│   └── skills/forge-workflow/
│
├── docs/
│   ├── WORKFLOW.md              # Complete guide
│   ├── TOOLCHAIN.md             # Tool reference
│   ├── SETUP.md                 # This file
│   ├── EXAMPLES.md              # Real examples
│   ├── planning/PROGRESS.md     # Progress tracking
│   └── research/TEMPLATE.md     # Research template
│
├── .beads/                      # If Beads installed
│   ├── issues.jsonl
│   ├── config.yaml
│   └── .gitignore
│
├── openspec/                    # If OpenSpec installed
│   ├── specs/
│   ├── changes/
│   └── archive/
│
└── .env.local                   # Your configuration (add to .gitignore!)
```

---

## Troubleshooting

### "Command not found: npx forge"

```bash
# Ensure forge-workflow is installed
npm list forge-workflow

# If not, install
npm install forge-workflow
```

### "Permission denied: gh"

```bash
# Authenticate GitHub CLI
gh auth login

# Or check status
gh auth status
```

### "Beads: command not found"

```bash
# Install globally
npm install -g @beads/bd

# Verify
bd --version
```

### "OpenSpec requires Node.js 20.19+"

```bash
# Check version
node --version

# Upgrade Node.js
# macOS: brew upgrade node
# Windows: Download from nodejs.org
# Linux: Use nvm
```

### "SonarQube connection refused"

```bash
# Check if SonarQube is running
docker ps | grep sonarqube

# If not, start it
docker start sonarqube

# Or run fresh
docker run -d --name sonarqube -p 9000:9000 sonarqube:community
```

### "Greptile API rate limit"

**Wait** for rate limit to reset (usually 1 minute).

**Or upgrade** to higher tier at https://greptile.com/pricing

### "Parallel AI API key invalid"

```bash
# Verify key in .env.local
grep PARALLEL_API_KEY .env.local

# Test key
curl -s -X POST "https://api.parallel.ai/v1beta/search" \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -H "parallel-beta: search-extract-2025-10-10" \
  -d '{"objective": "test"}'
```

---

## Next Steps

✅ Setup complete? Try your [first feature](../QUICKSTART.md)

📖 Learn the workflow in [WORKFLOW.md](WORKFLOW.md)

🛠️ Explore toolchain in [TOOLCHAIN.md](TOOLCHAIN.md)

🎯 See examples in [EXAMPLES.md](EXAMPLES.md)

---

**Questions?** → [GitHub Discussions](https://github.com/harshanandak/forge/discussions)
