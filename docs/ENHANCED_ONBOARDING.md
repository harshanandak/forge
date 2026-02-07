# Enhanced Onboarding Guide

Version 1.6.0 introduces intelligent onboarding that adapts to your project and preserves existing content.

---

## What's New in v1.6.0

### 🎯 Key Features

1. **Intelligent File Merging** - Preserves your existing AGENTS.md content
2. **Auto-Detection** - Automatically detects framework, language, and project stage
3. **Workflow Profiles** - Adapts workflow based on work type
4. **Context Storage** - Saves project context to `.forge/context.json`

---

## Intelligent File Merging

When you run setup and already have an AGENTS.md file, Forge now offers three options:

### Option 1: Intelligent Merge (Recommended)

Preserves your content while adding Forge workflow:

```bash
bunx forge setup --merge=smart
```

**What gets preserved:**
- Project descriptions
- Domain knowledge
- Custom coding standards
- Architecture notes
- Tech stack details

**What gets updated:**
- Workflow instructions (9-stage TDD process)
- TDD principles
- Git conventions

**Example:**

Before (your existing AGENTS.md):
```markdown
# My Project

## Project Description
E-commerce platform for selling widgets.

## Coding Standards
- TypeScript strict mode
- 80% test coverage
```

After intelligent merge:
```markdown
# My Project

## Project Description
E-commerce platform for selling widgets.

## Coding Standards
- TypeScript strict mode
- 80% test coverage

## Workflow Configuration
Use the 9-stage TDD workflow:
1. /status - Check current context
2. /research - Research with web search
...
```

### Option 2: Keep Existing

Skip Forge installation for AGENTS.md:

```bash
# Select "Keep existing" when prompted
# Or use:
bunx forge setup --merge=preserve
```

### Option 3: Replace

Overwrite with Forge standards (backup created):

```bash
# Select "Replace" when prompted
# Or use:
bunx forge setup --merge=replace
```

Your original file is backed up to `AGENTS.md.backup`

---

## Auto-Detection

Forge automatically detects your project characteristics and saves them to `.forge/context.json`.

### What Gets Detected

**Framework Detection:**
- Next.js
- React
- Vue.js
- Express

**Language Detection:**
- TypeScript (if in dependencies)
- JavaScript (default)

**Git Statistics:**
- Commit count
- Release tags

**CI/CD Detection:**
- GitHub Actions (`.github/workflows/`)
- GitLab CI (`.gitlab-ci.yml`)

**Project Stage Inference:**
- **New**: < 50 commits, no CI/CD, low coverage
- **Active**: 50-500 commits, has CI/CD, medium coverage
- **Stable**: > 500 commits, has CI/CD + releases, high coverage

### Context Storage

Detected context is saved to `.forge/context.json`:

```json
{
  "auto_detected": {
    "framework": "Next.js",
    "language": "typescript",
    "stage": "active",
    "confidence": 0.85,
    "commits": 150,
    "hasCICD": true,
    "cicdType": "GitHub Actions",
    "hasReleases": false,
    "coverage": 65
  },
  "user_provided": {
    "description": "E-commerce platform",
    "current_work": "Adding multi-tenant support"
  },
  "last_updated": "2026-02-06T..."
}
```

### Manual Override

Force context interview to customize detected values:

```bash
bunx forge setup --interview
```

---

## Workflow Profiles

Forge adapts its workflow based on the type of work you're doing.

### Four User-Facing Types

#### 1. Feature (Default)
**Use for:** New functionality, enhancements

```bash
bunx forge setup --type=feature
# Or create branch: feat/user-dashboard
```

**Workflow:**
- Full 9-stage workflow
- Auto-escalates to **Critical** if keywords detected:
  - auth, security, payment, crypto, password, token, session, migration, breaking

**Critical Workflow (9 stages):**
```
/status → /research → /plan → /dev → /check → /ship → /review → /merge → /verify
```

**Standard Workflow (6 stages):**
```
/status → /plan → /dev → /check → /ship → /merge
```

#### 2. Fix
**Use for:** Bug fixes, corrections

```bash
bunx forge setup --type=fix
# Or create branch: fix/login-validation
```

**Workflow:**
- Streamlined 5-stage workflow
- Auto-escalates to **Hotfix** if keywords detected:
  - urgent, production, emergency, hotfix, critical

**Hotfix Workflow (3 stages):**
```
/dev → /check → /ship
```

**Simple Workflow (4 stages):**
```
/dev → /check → /ship → /merge
```

#### 3. Refactor
**Use for:** Code cleanup, optimization

```bash
bunx forge setup --type=refactor
# Or create branch: refactor/extract-payment-service
```

**Workflow (5 stages):**
```
/plan → /dev → /check → /ship → /merge
```

- Strict TDD to preserve behavior
- Optional research for architectural changes

#### 4. Chore
**Use for:** Documentation, dependencies, configuration

```bash
bunx forge setup --type=chore
# Or create branch: docs/update-readme
```

**Workflow (3 stages):**
```
/verify → /ship → /merge
```

- Minimal workflow for maintenance tasks
- Auto-detects if only markdown files changed → uses Docs profile

### Workflow Mapping

| User Type | Keywords Detected | Internal Profile | Stages |
|-----------|------------------|------------------|--------|
| Feature | auth, security, payment | Critical | 9 |
| Feature | (none) | Standard | 6 |
| Fix | urgent, production | Hotfix | 3 |
| Fix | (none) | Simple | 4 |
| Refactor | (always) | Refactor | 5 |
| Chore | only .md files | Docs | 3 |

---

## CLI Flags Reference

### Setup Flags

```bash
# Merge strategy for existing files
--merge <mode>          smart, preserve, or replace

# Workflow profile type
--type <type>           critical, standard, simple, hotfix, docs, refactor

# Force context interview
--interview             Gather project information

# Examples:
bunx forge setup --merge=smart --type=critical --interview
```

### Complete Flag List

```bash
--path, -p <dir>        Target directory (default: current)
--quick, -q             Use all defaults
--skip-external         Skip external services
--agents <list>         Specify agents (--agents claude cursor)
--all                   Install for all agents
--merge <mode>          Merge strategy (v1.6.0)
--type <type>           Workflow profile (v1.6.0)
--interview             Context interview (v1.6.0)
--help, -h              Show help
```

---

## Usage Examples

### Scenario 1: Fresh Project

```bash
# New project, auto-detect everything
bunx forge setup

# What happens:
# 1. Detects Next.js + TypeScript
# 2. Saves to .forge/context.json
# 3. Creates AGENTS.md with detected info
# 4. Sets up agent-specific files
```

### Scenario 2: Existing AGENTS.md

```bash
# Project with custom AGENTS.md
bunx forge setup

# You'll be prompted:
# > Found existing AGENTS.md without Forge markers.
# >
# > How would you like to proceed?
# >   1. Intelligent merge (preserve your content + add Forge workflow)
# >   2. Keep existing (skip Forge installation for this file)
# >   3. Replace (backup created at AGENTS.md.backup)
# >
# > Your choice (1-3) [1]:

# Choose 1 for intelligent merge
```

### Scenario 3: Security Feature

```bash
# Authentication feature
git checkout -b feat/user-authentication

bunx forge setup --type=critical

# Auto-escalates to Critical profile:
# - 9-stage workflow
# - Research required
# - OWASP analysis
# - OpenSpec for strategic changes
```

### Scenario 4: Production Hotfix

```bash
# Urgent production bug
git checkout -b hotfix/payment-crash

bunx forge setup --type=hotfix

# Uses Hotfix profile:
# - 3-stage emergency workflow
# - TDD to reproduce bug
# - Skip research and planning
# - Fast path to production
```

### Scenario 5: Documentation Update

```bash
# Update README
git checkout -b docs/update-installation-guide

# Forge auto-detects chore → docs profile:
# - 3-stage minimal workflow
# - No TDD required
# - Just verify, ship, merge
```

---

## Migration Guide

### Upgrading from v1.5.0 to v1.6.0

**No breaking changes!** Enhanced onboarding is backwards compatible.

**What's new:**
1. Enhanced file merging options
2. Auto-detection and context storage
3. Workflow profiles with auto-escalation

**What stays the same:**
- Existing marker-based merge (USER:START/END) still works
- All CLI flags from v1.5.0 remain functional
- AGENTS.md format unchanged

**Recommended steps:**
```bash
# 1. Pull latest version
bun update forge-workflow

# 2. Re-run setup to enable new features
bunx forge setup

# 3. Check auto-detected context
cat .forge/context.json

# 4. Review merged AGENTS.md
cat AGENTS.md
```

---

## Troubleshooting

### Issue: Auto-detection failed

```bash
# Error: "Auto-detection skipped (error: ...)"
```

**Solution:** Auto-detection is optional. Setup continues with defaults.

To manually specify:
```bash
bunx forge setup --interview
```

### Issue: Merge didn't preserve my content

```bash
# Some content missing after merge
```

**Solution:** Check backup file:
```bash
cat AGENTS.md.backup
```

Re-run with preserve mode:
```bash
bunx forge setup --merge=preserve
```

Manually merge using semantic merge tool:
```javascript
const contextMerge = require('forge-workflow/lib/context-merge');
const merged = contextMerge.semanticMerge(existingContent, forgeContent);
```

### Issue: Wrong workflow profile detected

```bash
# Branch: feat/add-button
# Detected: standard
# Expected: simple
```

**Solution:** Override detection:
```bash
bunx forge setup --type=simple
```

Or update branch name to match convention:
```bash
git branch -m feat/simple-add-button
```

### Issue: Context not saved

```bash
# .forge/context.json not created
```

**Solution:** Check write permissions:
```bash
ls -la .forge/
```

Create manually:
```bash
mkdir -p .forge
bunx forge setup
```

---

## Advanced Usage

### Custom Context

Edit `.forge/context.json` to add custom fields:

```json
{
  "auto_detected": { ... },
  "user_provided": {
    "description": "SaaS platform for team collaboration",
    "current_work": "Adding real-time notifications",
    "tech_stack": {
      "backend": "Node.js + Express + PostgreSQL",
      "frontend": "Next.js + TailwindCSS",
      "infrastructure": "AWS ECS + RDS"
    },
    "team_conventions": {
      "branch_naming": "type/JIRA-123-description",
      "commit_format": "conventional commits",
      "review_process": "2 approvals required"
    }
  },
  "last_updated": "2026-02-06T..."
}
```

### Workflow Profile Customization

Override specific stages:

```bash
# Feature workflow but skip research
bunx forge setup --type=standard

# Then manually edit AGENTS.md to customize workflow
```

### Multiple Profiles

Different profiles for different branches:

```bash
# Main features
git checkout -b feat/dashboard
bunx forge setup --type=standard

# Security features
git checkout -b feat/auth-oauth
bunx forge setup --type=critical

# Quick fixes
git checkout -b fix/typo
bunx forge setup --type=simple
```

---

## Best Practices

### 1. Let Auto-Detection Work

Don't override unless necessary. Auto-detection is smart:
- Analyzes your actual codebase
- Considers project maturity
- Detects CI/CD and testing setup

### 2. Use Intelligent Merge

When upgrading existing projects:
- Choose "Intelligent merge" (option 1)
- Preserves your domain knowledge
- Adds Forge workflow standards

### 3. Set Workflow Type Per Branch

Different branches, different workflows:
- `feat/auth-*` → critical
- `feat/ui-*` → standard
- `fix/*` → simple
- `docs/*` → chore

### 4. Review Context Regularly

```bash
# Check what Forge knows about your project
cat .forge/context.json

# Update if project changed significantly
bunx forge setup --interview
```

### 5. Commit Context File

Add `.forge/context.json` to git:
```bash
git add .forge/context.json
git commit -m "docs: update project context"
```

Share project knowledge with team.

---

## Related Documentation

- [Main README](../README.md) - Overview and quick start
- [Workflow Guide](WORKFLOW.md) - Complete 9-stage workflow
- [Setup Guide](SETUP.md) - Agent-specific setup
- [Agent Install Prompt](AGENT_INSTALL_PROMPT.md) - AI-assisted setup

---

## Feedback

Found an issue or have a suggestion?
- [Report on GitHub](https://github.com/harshanandak/forge/issues)
- Tag with `enhancement` for feature requests
- Tag with `bug` for issues

---

**Version**: 1.6.0
**Last Updated**: 2026-02-06
**Stability**: Stable
