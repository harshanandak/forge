# Enhanced Onboarding Guide

Intelligent onboarding that adapts to your project and preserves existing content.

---

## Key Features

### Key Features

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
- Workflow instructions (7-stage TDD process)
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
Use the 7-stage TDD workflow:
1. /plan - Design intent, research, branch + worktree + task list
2. /dev - Subagent-driven TDD per task
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

### Six Change Classifications

#### 1. Critical (7 stages)
**Use for:** Security, auth, payments, breaking changes

```bash
bunx forge setup --type=critical
# Or create branch: feat/user-authentication
```

**Workflow:**
```
/plan -> /dev -> /validate -> /ship -> /review -> /premerge -> /verify
```

- Full 7-stage workflow with all gates
- OWASP analysis required
- Design docs for strategic changes

#### 2. Standard (6 stages)
**Use for:** Normal features, enhancements

```bash
bunx forge setup --type=standard
# Or create branch: feat/user-dashboard
```

**Workflow:**
```
/plan -> /dev -> /validate -> /ship -> /review -> /premerge
```

- Default for most feature work
- Auto-escalates to **Critical** if keywords detected:
  - auth, security, payment, crypto, password, token, session, migration, breaking

#### 3. Simple (3 stages)
**Use for:** Bug fixes, small changes

```bash
bunx forge setup --type=simple
# Or create branch: fix/login-validation
```

**Workflow:**
```
/dev -> /validate -> /ship
```

- Streamlined for quick fixes
- TDD to reproduce bug, then fix

#### 4. Hotfix (3 stages)
**Use for:** Production emergencies

```bash
bunx forge setup --type=hotfix
# Or create branch: hotfix/payment-crash
```

**Workflow:**
```
/dev -> /validate -> /ship
```

- Emergency fast path (immediate merge)
- Skip planning and research
- TDD to reproduce, then fix

#### 5. Docs (2 stages)
**Use for:** Documentation only

```bash
bunx forge setup --type=docs
# Or create branch: docs/update-readme
```

**Workflow:**
```
/verify -> /ship
```

- Minimal workflow for documentation changes
- No TDD required

#### 6. Refactor (5 stages)
**Use for:** Code cleanup, optimization

```bash
bunx forge setup --type=refactor
# Or create branch: refactor/extract-payment-service
```

**Workflow:**
```
/plan -> /dev -> /validate -> /ship -> /premerge
```

- Strict TDD to preserve behavior
- Planning phase for architectural changes

### Workflow Mapping

| Classification | Use Case | Stages | Workflow |
|----------------|----------|--------|---------|
| Critical | Security, auth, payments, breaking changes | 7 | plan, dev, validate, ship, review, premerge, verify |
| Standard | Normal features, enhancements | 6 | plan, dev, validate, ship, review, premerge |
| Simple | Bug fixes, small changes | 3 | dev, validate, ship |
| Hotfix | Production emergencies | 3 | dev, validate, ship (immediate merge) |
| Docs | Documentation only | 2 | verify, ship |
| Refactor | Code cleanup, optimization | 5 | plan, dev, validate, ship, premerge |

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
--merge <mode>          Merge strategy
--type <type>           Workflow profile
--interview             Context interview
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

# Uses Critical profile:
# - Full 7-stage workflow
# - OWASP analysis required
# - Design docs for strategic changes
```

### Scenario 4: Production Hotfix

```bash
# Urgent production bug
git checkout -b hotfix/payment-crash

bunx forge setup --type=hotfix

# Uses Hotfix profile:
# - 3-stage emergency workflow
# - TDD to reproduce bug
# - Skip planning and research
# - Fast path to production
```

### Scenario 5: Documentation Update

```bash
# Update README
git checkout -b docs/update-installation-guide

bunx forge setup --type=docs

# Uses Docs profile:
# - 2-stage minimal workflow
# - No TDD required
# - Just verify and ship
```

---

## Migration Guide

### Upgrading

Enhanced onboarding is backwards compatible.

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
# Standard workflow for a feature
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
- `feat/auth-*` -> critical
- `feat/ui-*` -> standard
- `fix/*` -> simple
- `docs/*` -> docs

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
- [Workflow Guide](../AGENTS.md) - Complete 7-stage workflow
- [Setup Guide](SETUP.md) - Agent-specific setup
- [Agent Install Prompt](AGENT_INSTALL_PROMPT.md) - AI-assisted setup

---

## Feedback

Found an issue or have a suggestion?
- [Report on GitHub](https://github.com/harshanandak/forge/issues)
- Tag with `enhancement` for feature requests
- Tag with `bug` for issues

---

**Last Updated**: 2026-03-24
