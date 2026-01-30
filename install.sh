#!/bin/bash
# Forge v1.1.0 - Universal AI Agent Workflow Installer
# https://github.com/harshanandak/forge
#
# Supports: Claude Code, Cursor, Windsurf, Kilo Code, OpenCode,
#           Aider, Continue, GitHub Copilot, Cline, Roo Code, Google Antigravity

set -e

REPO="harshanandak/forge"
BRANCH="main"
BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"

echo ""
echo "  ___                   "
echo " |  _|___  _ _  ___  ___ "
echo " |  _| . || '_|| . || -_|"
echo " |_| |___||_|  |_  ||___|"
echo "                 |___|   "
echo ""
echo "Installing Forge v1.1.0 - Universal AI Agent Workflow"
echo "Supporting ALL major AI coding agents..."
echo ""

# ============================================
# CREATE DIRECTORIES FOR ALL AGENTS
# ============================================
echo "Creating agent directories..."

# Claude Code
mkdir -p .claude/commands .claude/rules .claude/skills/forge-workflow .claude/scripts

# Google Antigravity
mkdir -p .agent/rules .agent/workflows .agent/skills/forge-workflow

# Cursor
mkdir -p .cursor/rules .cursor/skills/forge-workflow

# Windsurf
mkdir -p .windsurf/workflows .windsurf/rules .windsurf/skills/forge-workflow

# Kilo Code
mkdir -p .kilocode/workflows .kilocode/rules .kilocode/skills/forge-workflow

# Cline
mkdir -p .cline/skills/forge-workflow

# Continue
mkdir -p .continue/prompts .continue/skills/forge-workflow

# OpenCode
mkdir -p .opencode/commands .opencode/skills/forge-workflow

# Roo Code
mkdir -p .roo/commands

# GitHub Copilot
mkdir -p .github/prompts .github/instructions

# Documentation
mkdir -p docs/planning docs/research

echo "  Created directories for 11 AI agents"

# ============================================
# DOWNLOAD CLAUDE CODE COMMANDS (MASTER FORMAT)
# ============================================
echo ""
echo "Downloading workflow commands..."
for cmd in status research plan dev check ship review merge verify; do
    curl -fsSL "$BASE_URL/.claude/commands/$cmd.md" -o ".claude/commands/$cmd.md" 2>/dev/null || true
    echo "  Downloaded: $cmd.md"
done

# Download rules
curl -fsSL "$BASE_URL/.claude/rules/workflow.md" -o ".claude/rules/workflow.md" 2>/dev/null || true
echo "  Downloaded: workflow.md (rules)"

# Download scripts
curl -fsSL "$BASE_URL/.claude/scripts/load-env.sh" -o ".claude/scripts/load-env.sh" 2>/dev/null || true
chmod +x .claude/scripts/load-env.sh 2>/dev/null || true
echo "  Downloaded: load-env.sh (script)"

# ============================================
# DOWNLOAD UNIVERSAL AGENTS.md
# ============================================
echo ""
echo "Creating universal instruction files..."
curl -fsSL "$BASE_URL/AGENTS.md" -o "AGENTS.md"
echo "  Downloaded: AGENTS.md (universal standard)"

# ============================================
# CREATE SYMLINKS (Single Source of Truth)
# ============================================
echo ""
echo "Creating instruction file links (single source of truth)..."

# Function to create symlink or copy (fallback for Windows)
create_link() {
    local source="$1"
    local target="$2"

    # Remove existing target
    rm -f "$target" 2>/dev/null || true

    # Try symlink first, fall back to copy
    if ln -s "$source" "$target" 2>/dev/null; then
        echo "  Linked: $target -> $source"
    else
        cp "$source" "$target" 2>/dev/null || true
        echo "  Copied: $target (from $source)"
    fi
}

# Root-level instruction files (all link to AGENTS.md)
create_link "AGENTS.md" "CLAUDE.md"
create_link "AGENTS.md" "GEMINI.md"
create_link "AGENTS.md" ".cursorrules"
create_link "AGENTS.md" ".windsurfrules"
create_link "AGENTS.md" ".clinerules"
create_link "AGENTS.md" ".github/copilot-instructions.md"

# ============================================
# CONVERT COMMANDS TO AGENT-SPECIFIC FORMATS
# ============================================
echo ""
echo "Converting commands for each agent..."

# Function to strip YAML frontmatter
strip_frontmatter() {
    sed '1{/^---$/!q};1,/^---$/d;1,/^---$/d' "$1"
}

# Google Antigravity: Remove YAML frontmatter (uses .agent/workflows/)
for cmd in .claude/commands/*.md; do
    [ -f "$cmd" ] || continue
    filename=$(basename "$cmd")
    strip_frontmatter "$cmd" > ".agent/workflows/$filename" 2>/dev/null || cp "$cmd" ".agent/workflows/$filename"
done
echo "  Converted: .agent/workflows/ (Google Antigravity)"

# Kilo Code: Remove YAML frontmatter
for cmd in .claude/commands/*.md; do
    [ -f "$cmd" ] || continue
    filename=$(basename "$cmd")
    strip_frontmatter "$cmd" > ".kilocode/workflows/$filename" 2>/dev/null || cp "$cmd" ".kilocode/workflows/$filename"
done
echo "  Converted: .kilocode/workflows/ (Kilo Code)"

# Windsurf: Remove YAML frontmatter
for cmd in .claude/commands/*.md; do
    [ -f "$cmd" ] || continue
    filename=$(basename "$cmd")
    strip_frontmatter "$cmd" > ".windsurf/workflows/$filename" 2>/dev/null || cp "$cmd" ".windsurf/workflows/$filename"
done
echo "  Converted: .windsurf/workflows/ (Windsurf)"

# OpenCode: Keep as-is (same YAML format)
cp .claude/commands/*.md .opencode/commands/ 2>/dev/null || true
echo "  Copied: .opencode/commands/ (OpenCode)"

# Roo Code: Remove YAML frontmatter
for cmd in .claude/commands/*.md; do
    [ -f "$cmd" ] || continue
    filename=$(basename "$cmd")
    strip_frontmatter "$cmd" > ".roo/commands/$filename" 2>/dev/null || cp "$cmd" ".roo/commands/$filename"
done
echo "  Converted: .roo/commands/ (Roo Code)"

# Continue: Convert to .prompt with invokable: true
for cmd in .claude/commands/*.md; do
    [ -f "$cmd" ] || continue
    basename_noext=$(basename "$cmd" .md)
    filename="${basename_noext}.prompt"
    {
        echo "---"
        echo "name: $basename_noext"
        echo "description: Forge workflow command - $basename_noext"
        echo "invokable: true"
        echo "---"
        echo ""
        strip_frontmatter "$cmd" 2>/dev/null || cat "$cmd"
    } > ".continue/prompts/$filename"
done
echo "  Converted: .continue/prompts/ (Continue)"

# GitHub Copilot: Convert to .prompt.md
for cmd in .claude/commands/*.md; do
    [ -f "$cmd" ] || continue
    basename_noext=$(basename "$cmd" .md)
    filename="${basename_noext}.prompt.md"
    strip_frontmatter "$cmd" > ".github/prompts/$filename" 2>/dev/null || cp "$cmd" ".github/prompts/$filename"
done
echo "  Converted: .github/prompts/ (GitHub Copilot)"

# Cursor: Create workflow.mdc rule (Cursor uses rules, not slash commands)
cat > .cursor/rules/forge-workflow.mdc << 'MDC_EOF'
---
description: Forge 9-Stage TDD Workflow
alwaysApply: true
---

# Forge Workflow Commands

Use these commands via `/command-name`:

1. `/status` - Check current context, active work, recent completions
2. `/research` - Deep research with web search, document to docs/research/
3. `/plan` - Create implementation plan, branch, tracking
4. `/dev` - TDD development (RED-GREEN-REFACTOR cycles)
5. `/check` - Validation (type/lint/security/tests)
6. `/ship` - Create PR with full documentation
7. `/review` - Address ALL PR feedback
8. `/merge` - Update docs, merge PR, cleanup
9. `/verify` - Final documentation verification

## Workflow Flow

```
/status -> /research -> /plan -> /dev -> /check -> /ship -> /review -> /merge -> /verify
```

## Core Principles

- **TDD-First**: Write tests BEFORE implementation (RED-GREEN-REFACTOR)
- **Research-First**: Understand before building, document decisions
- **Security Built-In**: OWASP Top 10 analysis for every feature
- **Documentation Progressive**: Update at each stage, verify at end

See AGENTS.md for full workflow details.
MDC_EOF
echo "  Created: .cursor/rules/forge-workflow.mdc (Cursor)"

# ============================================
# CREATE UNIVERSAL SKILL (SKILL.md)
# ============================================
echo ""
echo "Installing universal SKILL.md for all supporting agents..."

# Create the universal SKILL.md content
cat > /tmp/forge-skill.md << 'SKILL_EOF'
---
name: forge-workflow
description: 9-stage TDD-first workflow for feature development. Use when building features, fixing bugs, or shipping PRs.
category: Development Workflow
tags: [tdd, workflow, pr, git, testing]
tools: [Bash, Read, Write, Edit, Grep, Glob]
---

# Forge Workflow Skill

A TDD-first workflow for AI coding agents. Ship features with confidence.

## When to Use

Automatically invoke this skill when the user wants to:
- Build a new feature
- Fix a bug
- Create a pull request
- Run the development workflow

## 9 Stages

| Stage | Command | Description |
|-------|---------|-------------|
| 1 | `/status` | Check current context, active work, recent completions |
| 2 | `/research` | Deep research with web search, document to docs/research/ |
| 3 | `/plan` | Create implementation plan, branch, OpenSpec if strategic |
| 4 | `/dev` | TDD development (RED-GREEN-REFACTOR cycles) |
| 5 | `/check` | Validation (type/lint/security/tests) |
| 6 | `/ship` | Create PR with full documentation |
| 7 | `/review` | Address ALL PR feedback (GitHub Actions, Greptile, SonarCloud) |
| 8 | `/merge` | Update docs, merge PR, cleanup |
| 9 | `/verify` | Final documentation verification |

## Workflow Flow

```
/status -> /research -> /plan -> /dev -> /check -> /ship -> /review -> /merge -> /verify
```

## Core Principles

- **TDD-First**: Write tests BEFORE implementation (RED-GREEN-REFACTOR)
- **Research-First**: Understand before building, document decisions
- **Security Built-In**: OWASP Top 10 analysis for every feature
- **Documentation Progressive**: Update at each stage, verify at end

## Prerequisites

- Git and GitHub CLI (`gh`)
- Beads (recommended): `npm i -g beads-cli && bd init`
- OpenSpec (optional): `npm i -g openspec-cli`

## Quick Start

1. `/status` - Check where you are
2. `/research <feature-name>` - Research the feature
3. `/plan <feature-slug>` - Create formal plan
4. `/dev` - Implement with TDD
5. `/check` - Validate everything
6. `/ship` - Create PR

See docs/WORKFLOW.md for detailed workflow guide.
SKILL_EOF

# Install SKILL.md to ALL supporting agents (same format works everywhere!)
cp /tmp/forge-skill.md .claude/skills/forge-workflow/SKILL.md
cp /tmp/forge-skill.md .agent/skills/forge-workflow/SKILL.md      # Antigravity
cp /tmp/forge-skill.md .cursor/skills/forge-workflow/SKILL.md     # Cursor
cp /tmp/forge-skill.md .windsurf/skills/forge-workflow/SKILL.md   # Windsurf
cp /tmp/forge-skill.md .kilocode/skills/forge-workflow/SKILL.md   # Kilo Code
cp /tmp/forge-skill.md .cline/skills/forge-workflow/SKILL.md      # Cline
cp /tmp/forge-skill.md .continue/skills/forge-workflow/SKILL.md   # Continue
cp /tmp/forge-skill.md .opencode/skills/forge-workflow/SKILL.md   # OpenCode

rm /tmp/forge-skill.md 2>/dev/null || true

echo "  Installed SKILL.md to 8 agents (universal format)"

# ============================================
# COPY RULES TO OTHER AGENTS
# ============================================
echo ""
echo "Copying rules to supporting agents..."

# Copy workflow rules (plain markdown works everywhere)
cp .claude/rules/workflow.md .agent/rules/workflow.md 2>/dev/null || true
cp .claude/rules/workflow.md .windsurf/rules/workflow.md 2>/dev/null || true
cp .claude/rules/workflow.md .kilocode/rules/workflow.md 2>/dev/null || true

echo "  Copied rules to: .agent/, .windsurf/, .kilocode/"

# ============================================
# DOWNLOAD DOCUMENTATION
# ============================================
echo ""
echo "Downloading documentation..."
curl -fsSL "$BASE_URL/docs/WORKFLOW.md" -o "docs/WORKFLOW.md" 2>/dev/null || true
echo "  Downloaded: docs/WORKFLOW.md"

curl -fsSL "$BASE_URL/docs/research/TEMPLATE.md" -o "docs/research/TEMPLATE.md" 2>/dev/null || true
echo "  Downloaded: docs/research/TEMPLATE.md"

# Create PROGRESS.md template if it doesn't exist
if [ ! -f "docs/planning/PROGRESS.md" ]; then
cat > docs/planning/PROGRESS.md << 'PROGRESS_EOF'
# Project Progress

## Current Focus
<!-- What you're working on -->

## Completed
<!-- Completed features -->

## Upcoming
<!-- Next priorities -->
PROGRESS_EOF
echo "  Created: docs/planning/PROGRESS.md"
fi

# ============================================
# SUCCESS MESSAGE
# ============================================
echo ""
echo "=============================================="
echo "  Forge v1.1.0 installed successfully!"
echo "=============================================="
echo ""
echo "Commands installed for:"
echo "  - Claude Code         (.claude/commands/)      Full support"
echo "  - Google Antigravity  (.agent/workflows/)      Full support"
echo "  - OpenCode            (.opencode/commands/)    Full support"
echo "  - Kilo Code           (.kilocode/workflows/)   Full support"
echo "  - Windsurf            (.windsurf/workflows/)   Full support"
echo "  - Roo Code            (.roo/commands/)         Full support"
echo "  - Continue            (.continue/prompts/)     Full support"
echo "  - GitHub Copilot      (.github/prompts/)       VS Code only"
echo "  - Cursor              (.cursor/rules/)         Via rules"
echo "  - Cline               (AGENTS.md)              Via instructions"
echo "  - Aider               (AGENTS.md)              Via instructions"
echo ""
echo "Skills installed for:"
echo "  - Claude Code, Antigravity, Cursor, Windsurf, Kilo Code,"
echo "    Cline, Continue, OpenCode (same SKILL.md works everywhere!)"
echo ""
echo "Instruction files (linked to AGENTS.md):"
echo "  - CLAUDE.md           Claude Code"
echo "  - GEMINI.md           Google Antigravity"
echo "  - .cursorrules        Cursor"
echo "  - .windsurfrules      Windsurf"
echo "  - .clinerules         Cline/Roo Code"
echo "  - .github/copilot-instructions.md  GitHub Copilot"
echo ""
echo "=============================================="
echo "  GET STARTED"
echo "=============================================="
echo ""
echo "  /status    - Check current context"
echo "  /research  - Start researching a feature"
echo "  /plan      - Create implementation plan"
echo "  /dev       - Start TDD development"
echo "  /check     - Run validation"
echo "  /ship      - Create pull request"
echo "  /review    - Address PR feedback"
echo "  /merge     - Merge and cleanup"
echo "  /verify    - Final documentation check"
echo ""
echo "  Full guide: docs/WORKFLOW.md"
echo "  Research template: docs/research/TEMPLATE.md"
echo ""
echo "Optional tools:"
echo "  - Beads: npm i -g beads-cli && bd init"
echo "  - OpenSpec: npm i -g openspec-cli"
echo ""
