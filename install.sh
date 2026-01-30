#!/bin/bash
# Forge v1.1.0 - Universal AI Agent Workflow Installer
# https://github.com/harshanandak/forge
#
# Interactive installer - select only the agents you use
#
# Usage:
#   ./install.sh              # Interactive mode
#   ./install.sh --quick      # Auto-select all agents, use defaults
#   ./install.sh --skip-external  # Skip external services configuration

set -e

# ============================================
# PARSE CLI FLAGS
# ============================================
QUICK_MODE=false
SKIP_EXTERNAL=false
for arg in "$@"; do
    case $arg in
        --quick) QUICK_MODE=true ;;
        --skip-external) SKIP_EXTERNAL=true ;;
        --help|-h)
            echo "Forge Installer"
            echo ""
            echo "Usage: ./install.sh [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --quick          Auto-select all agents, use defaults for services"
            echo "  --skip-external  Skip external services configuration"
            echo "  --help, -h       Show this help message"
            exit 0
            ;;
    esac
done

# Cleanup on error
cleanup_on_error() {
    echo -e "\n${RED}Installation failed. Partial files may remain.${NC}"
    echo "Run 'rm -rf .claude .cursor .windsurf .kilocode .opencode .continue .github .agent .roo .env.local' to clean up."
}
trap cleanup_on_error ERR

REPO="harshanandak/forge"
BRANCH="main"
BASE_URL="https://raw.githubusercontent.com/$REPO/$BRANCH"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo -e "${CYAN}  ___                   ${NC}"
echo -e "${CYAN} |  _|___  _ _  ___  ___ ${NC}"
echo -e "${CYAN} |  _| . || '_|| . || -_|${NC}"
echo -e "${CYAN} |_| |___||_|  |_  ||___|${NC}"
echo -e "${CYAN}                 |___|   ${NC}"
echo ""
echo -e "${GREEN}Forge v1.1.0 - Universal AI Agent Workflow${NC}"
echo ""

# ============================================
# PREREQUISITE VALIDATION
# ============================================
echo -e "${YELLOW}Checking prerequisites...${NC}"

PREREQ_WARNINGS=()
PREREQ_ERRORS=()
PKG_MANAGER="npm"

# Required: Git
if ! command -v git &> /dev/null; then
    PREREQ_ERRORS+=("git - Install from https://git-scm.com")
else
    echo -e "  ${GREEN}✓${NC} git $(git --version | cut -d' ' -f3)"
fi

# Required: GitHub CLI
if ! command -v gh &> /dev/null; then
    PREREQ_ERRORS+=("gh (GitHub CLI) - Install from https://cli.github.com")
else
    echo -e "  ${GREEN}✓${NC} gh $(gh --version | head -1 | cut -d' ' -f3)"
    # Check if authenticated
    if ! gh auth status &> /dev/null 2>&1; then
        PREREQ_WARNINGS+=("GitHub CLI not authenticated. Run: gh auth login")
    fi
fi

# Required: Node.js 20+
if command -v node &> /dev/null; then
    node_version=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$node_version" -lt 20 ]; then
        PREREQ_ERRORS+=("Node.js 20+ required (current: $(node -v))")
    else
        echo -e "  ${GREEN}✓${NC} node $(node -v)"
    fi
else
    PREREQ_ERRORS+=("Node.js 20+ - Install from https://nodejs.org")
fi

# Required: curl (for downloading files)
if ! command -v curl &> /dev/null; then
    PREREQ_ERRORS+=("curl - Install from your package manager (apt install curl, brew install curl)")
else
    echo -e "  ${GREEN}✓${NC} curl $(curl --version | head -1 | cut -d' ' -f2)"
fi

# Detect package manager
if command -v bun &> /dev/null; then
    PKG_MANAGER="bun"
    echo -e "  ${GREEN}✓${NC} bun $(bun --version) (detected as package manager)"
elif command -v pnpm &> /dev/null; then
    PKG_MANAGER="pnpm"
    echo -e "  ${GREEN}✓${NC} pnpm $(pnpm --version) (detected as package manager)"
elif command -v yarn &> /dev/null; then
    PKG_MANAGER="yarn"
    echo -e "  ${GREEN}✓${NC} yarn $(yarn --version) (detected as package manager)"
elif command -v npm &> /dev/null; then
    PKG_MANAGER="npm"
    echo -e "  ${GREEN}✓${NC} npm $(npm --version) (detected as package manager)"
else
    PREREQ_ERRORS+=("npm, yarn, pnpm, or bun - Install a package manager")
fi

# Also detect from lock files if present
if [ -f "bun.lockb" ] || [ -f "bun.lock" ]; then
    PKG_MANAGER="bun"
elif [ -f "pnpm-lock.yaml" ]; then
    PKG_MANAGER="pnpm"
elif [ -f "yarn.lock" ]; then
    PKG_MANAGER="yarn"
fi

# Show errors
if [ ${#PREREQ_ERRORS[@]} -gt 0 ]; then
    echo ""
    echo -e "${RED}❌ Missing required tools:${NC}"
    for err in "${PREREQ_ERRORS[@]}"; do
        echo -e "   ${RED}-${NC} $err"
    done
    echo ""
    echo "Please install missing tools and try again."
    exit 1
fi

# Show warnings
if [ ${#PREREQ_WARNINGS[@]} -gt 0 ]; then
    echo ""
    echo -e "${YELLOW}⚠️  Warnings:${NC}"
    for warn in "${PREREQ_WARNINGS[@]}"; do
        echo -e "   ${YELLOW}-${NC} $warn"
    done
fi

echo ""
echo -e "  ${GREEN}Package manager: $PKG_MANAGER${NC}"
echo ""

# ============================================
# DETECT EXISTING INSTALLATION
# ============================================
EXISTING_INSTALL=false
AGENTS_BACKUP_CREATED=false
if [ -f "AGENTS.md" ] && [ -d ".claude/commands" ]; then
    EXISTING_INSTALL=true
    echo -e "${YELLOW}Found existing Forge installation.${NC}"
    echo ""
fi

# ============================================
# AGENT SELECTION
# ============================================

# Parse selection
INSTALL_CLAUDE=false
INSTALL_CURSOR=false
INSTALL_WINDSURF=false
INSTALL_KILOCODE=false
INSTALL_ANTIGRAVITY=false
INSTALL_COPILOT=false
INSTALL_CONTINUE=false
INSTALL_OPENCODE=false
INSTALL_CLINE=false
INSTALL_ROO=false
INSTALL_AIDER=false

# Track Context7 MCP auto-installation
CONTEXT7_INSTALLED_CLAUDE=false
CONTEXT7_INSTALLED_CONTINUE=false

if [ "$QUICK_MODE" = true ]; then
    # Quick mode: auto-select all agents
    echo -e "${YELLOW}Quick mode: Installing for all agents...${NC}"
    INSTALL_CLAUDE=true
    INSTALL_CURSOR=true
    INSTALL_WINDSURF=true
    INSTALL_KILOCODE=true
    INSTALL_ANTIGRAVITY=true
    INSTALL_COPILOT=true
    INSTALL_CONTINUE=true
    INSTALL_OPENCODE=true
    INSTALL_CLINE=true
    INSTALL_ROO=true
    INSTALL_AIDER=true
else
    # Interactive mode: prompt user for selection
    echo -e "${YELLOW}Which AI coding agents do you use?${NC}"
    echo -e "${BLUE}(Enter numbers separated by spaces, or 'all' for everything)${NC}"
    echo ""
    echo "  1) Claude Code          - Anthropic's CLI agent"
    echo "  2) Cursor               - AI-first code editor"
    echo "  3) Windsurf             - Codeium's agentic IDE"
    echo "  4) Kilo Code            - VS Code extension"
    echo "  5) Google Antigravity   - Google's agent IDE"
    echo "  6) GitHub Copilot       - GitHub's AI assistant"
    echo "  7) Continue             - Open-source AI assistant"
    echo "  8) OpenCode             - Open-source agent"
    echo "  9) Cline                - VS Code agent extension"
    echo " 10) Roo Code             - Cline fork with modes"
    echo " 11) Aider                - Terminal-based agent"
    echo ""
    echo -e "  ${GREEN}all) Install for all agents${NC}"
    echo ""

    read -p "Your selection (e.g., '1 2 3' or 'all'): " selection

    if [[ "$selection" == "all" ]]; then
        INSTALL_CLAUDE=true
        INSTALL_CURSOR=true
        INSTALL_WINDSURF=true
        INSTALL_KILOCODE=true
        INSTALL_ANTIGRAVITY=true
        INSTALL_COPILOT=true
        INSTALL_CONTINUE=true
        INSTALL_OPENCODE=true
        INSTALL_CLINE=true
        INSTALL_ROO=true
        INSTALL_AIDER=true
    else
        for num in $selection; do
            case $num in
                1) INSTALL_CLAUDE=true ;;
                2) INSTALL_CURSOR=true ;;
                3) INSTALL_WINDSURF=true ;;
                4) INSTALL_KILOCODE=true ;;
                5) INSTALL_ANTIGRAVITY=true ;;
                6) INSTALL_COPILOT=true ;;
                7) INSTALL_CONTINUE=true ;;
                8) INSTALL_OPENCODE=true ;;
                9) INSTALL_CLINE=true ;;
                10) INSTALL_ROO=true ;;
                11) INSTALL_AIDER=true ;;
            esac
        done
    fi
fi

echo ""
echo -e "${BLUE}Installing Forge workflow...${NC}"
echo ""

# ============================================
# ALWAYS CREATE: Core directories and AGENTS.md
# ============================================
echo "Creating core directories..."
mkdir -p docs/planning docs/research

# Backup existing AGENTS.md before overwriting
if [ -f "AGENTS.md" ]; then
    cp AGENTS.md AGENTS.md.backup
    AGENTS_BACKUP_CREATED=true
    echo -e "  ${YELLOW}Backed up: AGENTS.md -> AGENTS.md.backup${NC}"
fi

# Download universal AGENTS.md
echo "Downloading AGENTS.md (universal standard)..."
curl -fsSL "$BASE_URL/AGENTS.md" -o "AGENTS.md"
echo -e "  ${GREEN}Created: AGENTS.md${NC}"

# Download documentation
echo "Downloading documentation..."
curl -fsSL "$BASE_URL/docs/WORKFLOW.md" -o "docs/WORKFLOW.md" 2>/dev/null || true
curl -fsSL "$BASE_URL/docs/research/TEMPLATE.md" -o "docs/research/TEMPLATE.md" 2>/dev/null || true

# Create PROGRESS.md if not exists
if [ ! -f "docs/planning/PROGRESS.md" ]; then
    cat > docs/planning/PROGRESS.md << 'EOF'
# Project Progress

## Current Focus
<!-- What you're working on -->

## Completed
<!-- Completed features -->

## Upcoming
<!-- Next priorities -->
EOF
    echo -e "  ${GREEN}Created: docs/planning/PROGRESS.md${NC}"
fi

# ============================================
# HELPER FUNCTIONS
# ============================================

# Function to strip YAML frontmatter
strip_frontmatter() {
    sed '1{/^---$/!q};1,/^---$/d;1,/^---$/d' "$1"
}

# Function to create symlink or copy (with proper error handling)
create_link() {
    local source="$1"
    local target="$2"
    local target_dir
    target_dir=$(dirname "$target")

    # Create target directory if needed
    if [ ! -d "$target_dir" ]; then
        mkdir -p "$target_dir" 2>/dev/null || true
    fi

    # Remove existing file/link
    rm -f "$target" 2>/dev/null || true

    # Try symlink first, fallback to copy
    if ln -s "$source" "$target" 2>/dev/null; then
        echo -e "  ${GREEN}Linked: $target -> $source${NC}"
    elif cp "$source" "$target" 2>/dev/null; then
        echo -e "  ${YELLOW}⚠ Copied (symlinks not supported): $target${NC}"
    else
        echo -e "  ${RED}Failed: Could not link or copy $target${NC}"
    fi
}

# Universal SKILL.md content
SKILL_CONTENT='---
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
| 7 | `/review` | Address ALL PR feedback |
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
'

# ============================================
# CLAUDE CODE
# ============================================
if [ "$INSTALL_CLAUDE" = true ]; then
    echo ""
    echo -e "${CYAN}Setting up Claude Code...${NC}"

    mkdir -p .claude/commands .claude/rules .claude/skills/forge-workflow .claude/scripts

    # Download commands
    for cmd in status research plan dev check ship review merge verify; do
        curl -fsSL "$BASE_URL/.claude/commands/$cmd.md" -o ".claude/commands/$cmd.md" 2>/dev/null || true
    done
    echo -e "  ${GREEN}Downloaded: 9 workflow commands${NC}"

    # Download rules
    curl -fsSL "$BASE_URL/.claude/rules/workflow.md" -o ".claude/rules/workflow.md" 2>/dev/null || true
    echo -e "  ${GREEN}Downloaded: workflow rules${NC}"

    # Download scripts
    curl -fsSL "$BASE_URL/.claude/scripts/load-env.sh" -o ".claude/scripts/load-env.sh" 2>/dev/null || true
    chmod +x .claude/scripts/load-env.sh 2>/dev/null || true

    # Create SKILL.md
    echo "$SKILL_CONTENT" > .claude/skills/forge-workflow/SKILL.md
    echo -e "  ${GREEN}Created: forge-workflow skill${NC}"

    # Create .mcp.json with Context7 MCP (auto-install for Claude Code)
    if [ ! -f ".mcp.json" ]; then
        cat > .mcp.json << 'MCP_EOF'
{
  "mcpServers": {
    "context7": {
      "command": "npx",
      "args": ["-y", "@upstash/context7-mcp@latest"]
    }
  }
}
MCP_EOF
        echo -e "  ${GREEN}Created: .mcp.json with Context7 MCP${NC}"
        CONTEXT7_INSTALLED_CLAUDE=true
    else
        echo -e "  ${YELLOW}Skipped: .mcp.json already exists${NC}"
    fi

    # Link CLAUDE.md -> AGENTS.md
    create_link "AGENTS.md" "CLAUDE.md"
fi

# ============================================
# CURSOR
# ============================================
if [ "$INSTALL_CURSOR" = true ]; then
    echo ""
    echo -e "${CYAN}Setting up Cursor...${NC}"

    mkdir -p .cursor/rules .cursor/skills/forge-workflow

    # Create workflow.mdc rule
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

See AGENTS.md for full workflow details.
MDC_EOF
    echo -e "  ${GREEN}Created: .cursor/rules/forge-workflow.mdc${NC}"

    # Create SKILL.md
    echo "$SKILL_CONTENT" > .cursor/skills/forge-workflow/SKILL.md
    echo -e "  ${GREEN}Created: forge-workflow skill${NC}"

    # Link .cursorrules -> AGENTS.md
    create_link "AGENTS.md" ".cursorrules"
fi

# ============================================
# WINDSURF
# ============================================
if [ "$INSTALL_WINDSURF" = true ]; then
    echo ""
    echo -e "${CYAN}Setting up Windsurf...${NC}"

    mkdir -p .windsurf/workflows .windsurf/rules .windsurf/skills/forge-workflow

    # Convert commands (strip YAML frontmatter)
    if [ "$INSTALL_CLAUDE" = true ]; then
        for cmd in .claude/commands/*.md; do
            [ -f "$cmd" ] || continue
            filename=$(basename "$cmd")
            strip_frontmatter "$cmd" > ".windsurf/workflows/$filename" 2>/dev/null || cp "$cmd" ".windsurf/workflows/$filename"
        done
        echo -e "  ${GREEN}Converted: 9 workflow commands${NC}"

        # Copy rules
        cp .claude/rules/workflow.md .windsurf/rules/workflow.md 2>/dev/null || true
    fi

    # Create SKILL.md
    echo "$SKILL_CONTENT" > .windsurf/skills/forge-workflow/SKILL.md
    echo -e "  ${GREEN}Created: forge-workflow skill${NC}"

    # Link .windsurfrules -> AGENTS.md
    create_link "AGENTS.md" ".windsurfrules"
fi

# ============================================
# KILO CODE
# ============================================
if [ "$INSTALL_KILOCODE" = true ]; then
    echo ""
    echo -e "${CYAN}Setting up Kilo Code...${NC}"

    mkdir -p .kilocode/workflows .kilocode/rules .kilocode/skills/forge-workflow

    # Convert commands (strip YAML frontmatter)
    if [ "$INSTALL_CLAUDE" = true ]; then
        for cmd in .claude/commands/*.md; do
            [ -f "$cmd" ] || continue
            filename=$(basename "$cmd")
            strip_frontmatter "$cmd" > ".kilocode/workflows/$filename" 2>/dev/null || cp "$cmd" ".kilocode/workflows/$filename"
        done
        echo -e "  ${GREEN}Converted: 9 workflow commands${NC}"

        # Copy rules
        cp .claude/rules/workflow.md .kilocode/rules/workflow.md 2>/dev/null || true
    fi

    # Create SKILL.md
    echo "$SKILL_CONTENT" > .kilocode/skills/forge-workflow/SKILL.md
    echo -e "  ${GREEN}Created: forge-workflow skill${NC}"
fi

# ============================================
# GOOGLE ANTIGRAVITY
# ============================================
if [ "$INSTALL_ANTIGRAVITY" = true ]; then
    echo ""
    echo -e "${CYAN}Setting up Google Antigravity...${NC}"

    mkdir -p .agent/workflows .agent/rules .agent/skills/forge-workflow

    # Convert commands (strip YAML frontmatter)
    if [ "$INSTALL_CLAUDE" = true ]; then
        for cmd in .claude/commands/*.md; do
            [ -f "$cmd" ] || continue
            filename=$(basename "$cmd")
            strip_frontmatter "$cmd" > ".agent/workflows/$filename" 2>/dev/null || cp "$cmd" ".agent/workflows/$filename"
        done
        echo -e "  ${GREEN}Converted: 9 workflow commands${NC}"

        # Copy rules
        cp .claude/rules/workflow.md .agent/rules/workflow.md 2>/dev/null || true
    fi

    # Create SKILL.md
    echo "$SKILL_CONTENT" > .agent/skills/forge-workflow/SKILL.md
    echo -e "  ${GREEN}Created: forge-workflow skill${NC}"

    # Link GEMINI.md -> AGENTS.md
    create_link "AGENTS.md" "GEMINI.md"
fi

# ============================================
# GITHUB COPILOT
# ============================================
if [ "$INSTALL_COPILOT" = true ]; then
    echo ""
    echo -e "${CYAN}Setting up GitHub Copilot...${NC}"

    mkdir -p .github/prompts .github/instructions

    # Convert commands to .prompt.md
    if [ "$INSTALL_CLAUDE" = true ]; then
        for cmd in .claude/commands/*.md; do
            [ -f "$cmd" ] || continue
            basename_noext=$(basename "$cmd" .md)
            filename="${basename_noext}.prompt.md"
            strip_frontmatter "$cmd" > ".github/prompts/$filename" 2>/dev/null || cp "$cmd" ".github/prompts/$filename"
        done
        echo -e "  ${GREEN}Converted: 9 workflow prompts${NC}"
    fi

    # Link copilot-instructions.md -> AGENTS.md
    create_link "AGENTS.md" ".github/copilot-instructions.md"
fi

# ============================================
# CONTINUE
# ============================================
if [ "$INSTALL_CONTINUE" = true ]; then
    echo ""
    echo -e "${CYAN}Setting up Continue...${NC}"

    mkdir -p .continue/prompts .continue/skills/forge-workflow

    # Convert commands to .prompt with invokable: true
    if [ "$INSTALL_CLAUDE" = true ]; then
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
        echo -e "  ${GREEN}Converted: 9 workflow prompts${NC}"
    fi

    # Create SKILL.md
    echo "$SKILL_CONTENT" > .continue/skills/forge-workflow/SKILL.md
    echo -e "  ${GREEN}Created: forge-workflow skill${NC}"

    # Create config.yaml with Context7 MCP (auto-install for Continue)
    if [ ! -f ".continue/config.yaml" ]; then
        cat > .continue/config.yaml << 'CONTINUE_EOF'
# Continue Configuration
# https://docs.continue.dev/customize/deep-dives/configuration

name: Forge Workflow
version: "1.0"

# MCP Servers for enhanced capabilities
mcpServers:
  - name: context7
    command: npx
    args:
      - "-y"
      - "@upstash/context7-mcp@latest"

# Rules loaded from .continuerules
CONTINUE_EOF
        echo -e "  ${GREEN}Created: config.yaml with Context7 MCP${NC}"
        CONTEXT7_INSTALLED_CONTINUE=true
    else
        echo -e "  ${YELLOW}Skipped: config.yaml already exists${NC}"
    fi
fi

# ============================================
# OPENCODE
# ============================================
if [ "$INSTALL_OPENCODE" = true ]; then
    echo ""
    echo -e "${CYAN}Setting up OpenCode...${NC}"

    mkdir -p .opencode/commands .opencode/skills/forge-workflow

    # Copy commands as-is (same YAML format)
    if [ "$INSTALL_CLAUDE" = true ]; then
        cp .claude/commands/*.md .opencode/commands/ 2>/dev/null || true
        echo -e "  ${GREEN}Copied: 9 workflow commands${NC}"
    fi

    # Create SKILL.md
    echo "$SKILL_CONTENT" > .opencode/skills/forge-workflow/SKILL.md
    echo -e "  ${GREEN}Created: forge-workflow skill${NC}"
fi

# ============================================
# CLINE
# ============================================
if [ "$INSTALL_CLINE" = true ]; then
    echo ""
    echo -e "${CYAN}Setting up Cline...${NC}"

    mkdir -p .cline/skills/forge-workflow

    # Create SKILL.md
    echo "$SKILL_CONTENT" > .cline/skills/forge-workflow/SKILL.md
    echo -e "  ${GREEN}Created: forge-workflow skill${NC}"

    # Link .clinerules -> AGENTS.md
    create_link "AGENTS.md" ".clinerules"
fi

# ============================================
# ROO CODE
# ============================================
if [ "$INSTALL_ROO" = true ]; then
    echo ""
    echo -e "${CYAN}Setting up Roo Code...${NC}"

    mkdir -p .roo/commands

    # Convert commands (strip YAML frontmatter)
    if [ "$INSTALL_CLAUDE" = true ]; then
        for cmd in .claude/commands/*.md; do
            [ -f "$cmd" ] || continue
            filename=$(basename "$cmd")
            strip_frontmatter "$cmd" > ".roo/commands/$filename" 2>/dev/null || cp "$cmd" ".roo/commands/$filename"
        done
        echo -e "  ${GREEN}Converted: 9 workflow commands${NC}"
    fi

    # Link .clinerules -> AGENTS.md (Roo uses same as Cline)
    if [ ! -f ".clinerules" ]; then
        create_link "AGENTS.md" ".clinerules"
    fi
fi

# ============================================
# AIDER
# ============================================
if [ "$INSTALL_AIDER" = true ]; then
    echo ""
    echo -e "${CYAN}Setting up Aider...${NC}"

    # Aider uses AGENTS.md via config
    # Create .aider.conf.yml if not exists
    if [ ! -f ".aider.conf.yml" ]; then
        cat > .aider.conf.yml << 'EOF'
# Aider configuration
# Read AGENTS.md for workflow instructions
read:
  - AGENTS.md
  - docs/WORKFLOW.md
EOF
        echo -e "  ${GREEN}Created: .aider.conf.yml${NC}"
    else
        echo -e "  ${YELLOW}Skipped: .aider.conf.yml already exists${NC}"
        echo -e "  ${YELLOW}Add 'read: [AGENTS.md]' to your config manually${NC}"
    fi
fi

# ============================================
# EXTERNAL SERVICES CONFIGURATION
# ============================================

# Skip external services if flag is set
if [ "$SKIP_EXTERNAL" = true ]; then
    echo ""
    echo -e "${YELLOW}Skipping external services configuration (--skip-external)${NC}"
    echo "You can configure them later by editing .env.local"
    configure_services="n"
elif [ "$QUICK_MODE" = true ]; then
    # Quick mode: use defaults without prompting
    echo ""
    echo -e "${YELLOW}Quick mode: Using default service configuration...${NC}"
    configure_services="y"
else
    echo ""
    echo -e "${YELLOW}=============================================="
    echo -e "  EXTERNAL SERVICES (Optional)"
    echo -e "==============================================${NC}"
    echo ""
    echo "Would you like to configure external services?"
    echo "(You can also add them later to .env.local)"
    echo ""
    read -p "Configure external services? (y/n): " configure_services
fi

if [[ "$configure_services" == "y" || "$configure_services" == "Y" || "$configure_services" == "yes" ]]; then

    # Initialize .env.local with header if new
    if [ ! -f ".env.local" ]; then
        cat > .env.local << 'ENV_HEADER'
# Forge Workflow Configuration
# Generated by install.sh

ENV_HEADER
    fi

    # ============================================
    # CODE REVIEW TOOL SELECTION
    # ============================================
    if [ "$QUICK_MODE" = true ]; then
        # Quick mode: use default (option 1)
        code_review_choice=1
    else
        echo ""
        echo -e "${CYAN}Code Review Tool${NC}"
        echo "Select your code review integration:"
        echo ""
        echo -e "  ${GREEN}1)${NC} GitHub Code Quality (FREE, built-in) ${GREEN}[RECOMMENDED]${NC}"
        echo "     Zero setup - uses GitHub's built-in code quality features"
        echo ""
        echo -e "  ${GREEN}2)${NC} CodeRabbit (FREE for open source)"
        echo "     AI-powered reviews - install GitHub App at https://coderabbit.ai"
        echo ""
        echo "  3) Greptile (Paid - \$99+/mo)"
        echo "     Enterprise code review - https://greptile.com"
        echo ""
        echo "  4) Skip code review integration"
        echo ""
        read -p "Select [1]: " code_review_choice
        code_review_choice=${code_review_choice:-1}
    fi

    case $code_review_choice in
        1)
            echo "CODE_REVIEW_TOOL=github-code-quality" >> .env.local
            echo -e "  ${GREEN}✓${NC} Using GitHub Code Quality (FREE)"
            ;;
        2)
            echo "CODE_REVIEW_TOOL=coderabbit" >> .env.local
            echo "# CodeRabbit: Install GitHub App at https://coderabbit.ai" >> .env.local
            echo -e "  ${GREEN}✓${NC} Using CodeRabbit - Install the GitHub App to activate"
            echo -e "     ${BLUE}https://coderabbit.ai${NC}"
            ;;
        3)
            echo ""
            read -s -p "  Enter Greptile API key: " greptile_key
            echo ""
            if [ -n "$greptile_key" ]; then
                echo "CODE_REVIEW_TOOL=greptile" >> .env.local
                echo "GREPTILE_API_KEY=$greptile_key" >> .env.local
                echo -e "  ${GREEN}✓${NC} Greptile configured"
            else
                echo "CODE_REVIEW_TOOL=none" >> .env.local
                echo -e "  ${YELLOW}Skipped${NC} - No API key provided"
            fi
            ;;
        4|*)
            echo "CODE_REVIEW_TOOL=none" >> .env.local
            echo -e "  ${YELLOW}Skipped${NC} code review integration"
            ;;
    esac

    # ============================================
    # CODE QUALITY TOOL SELECTION
    # ============================================
    if [ "$QUICK_MODE" = true ]; then
        # Quick mode: use default (option 1)
        code_quality_choice=1
    else
        echo ""
        echo -e "${CYAN}Code Quality Tool${NC}"
        echo "Select your code quality/security scanner:"
        echo ""
        echo -e "  ${GREEN}1)${NC} ESLint only (FREE, built-in) ${GREEN}[RECOMMENDED]${NC}"
        echo "     No external server required - uses project's linting"
        echo ""
        echo "  2) SonarCloud (50k LoC free, cloud-hosted)"
        echo "     Get token: https://sonarcloud.io/account/security"
        echo ""
        echo "  3) SonarQube Community (FREE, self-hosted, unlimited LoC)"
        echo "     Run: docker run -d --name sonarqube -p 9000:9000 sonarqube:community"
        echo ""
        echo "  4) Skip code quality integration"
        echo ""
        read -p "Select [1]: " code_quality_choice
        code_quality_choice=${code_quality_choice:-1}
    fi

    case $code_quality_choice in
        1)
            echo "CODE_QUALITY_TOOL=eslint" >> .env.local
            echo -e "  ${GREEN}✓${NC} Using ESLint (built-in)"
            ;;
        2)
            echo ""
            read -s -p "  Enter SonarCloud token: " sonar_token
            echo ""
            read -p "  Enter SonarCloud organization: " sonar_org
            read -p "  Enter SonarCloud project key: " sonar_project
            if [ -n "$sonar_token" ]; then
                echo "CODE_QUALITY_TOOL=sonarcloud" >> .env.local
                echo "SONAR_TOKEN=$sonar_token" >> .env.local
                [ -n "$sonar_org" ] && echo "SONAR_ORGANIZATION=$sonar_org" >> .env.local
                [ -n "$sonar_project" ] && echo "SONAR_PROJECT_KEY=$sonar_project" >> .env.local
                echo -e "  ${GREEN}✓${NC} SonarCloud configured"
            else
                echo "CODE_QUALITY_TOOL=eslint" >> .env.local
                echo -e "  ${YELLOW}Falling back to ESLint${NC}"
            fi
            ;;
        3)
            echo ""
            echo -e "  ${BLUE}SonarQube Self-Hosted Setup:${NC}"
            echo "  docker run -d --name sonarqube -p 9000:9000 sonarqube:community"
            echo "  Access: http://localhost:9000 (admin/admin)"
            echo ""
            read -p "  Enter SonarQube URL [http://localhost:9000]: " sonarqube_url
            sonarqube_url=${sonarqube_url:-http://localhost:9000}
            read -s -p "  Enter SonarQube token (optional): " sonarqube_token
            echo ""

            echo "CODE_QUALITY_TOOL=sonarqube" >> .env.local
            echo "SONARQUBE_URL=$sonarqube_url" >> .env.local
            [ -n "$sonarqube_token" ] && echo "SONARQUBE_TOKEN=$sonarqube_token" >> .env.local
            echo "# SonarQube: docker run -d --name sonarqube -p 9000:9000 sonarqube:community" >> .env.local
            echo -e "  ${GREEN}✓${NC} SonarQube self-hosted configured"
            ;;
        4|*)
            echo "CODE_QUALITY_TOOL=none" >> .env.local
            echo -e "  ${YELLOW}Skipped${NC} code quality integration"
            ;;
    esac

    # ============================================
    # RESEARCH TOOL SELECTION
    # ============================================
    if [ "$QUICK_MODE" = true ]; then
        # Quick mode: use default (option 1)
        research_choice=1
    else
        echo ""
        echo -e "${CYAN}Research Tool${NC}"
        echo "Select your research tool for /research stage:"
        echo ""
        echo -e "  ${GREEN}1)${NC} Manual research only ${GREEN}[DEFAULT]${NC}"
        echo "     Use web browser and codebase exploration"
        echo ""
        echo "  2) Parallel AI (comprehensive web research)"
        echo "     Get key: https://platform.parallel.ai"
        echo ""
        read -p "Select [1]: " research_choice
        research_choice=${research_choice:-1}
    fi

    case $research_choice in
        2)
            echo ""
            read -s -p "  Enter Parallel AI API key: " parallel_key
            echo ""
            if [ -n "$parallel_key" ]; then
                echo "PARALLEL_API_KEY=$parallel_key" >> .env.local
                echo -e "  ${GREEN}✓${NC} Parallel AI configured"
            else
                echo -e "  ${YELLOW}Skipped${NC} - No API key provided"
            fi
            ;;
        1|*)
            echo -e "  ${GREEN}✓${NC} Using manual research"
            ;;
    esac

    # ============================================
    # CONTEXT7 MCP - Library Documentation
    # ============================================
    echo ""
    echo -e "${CYAN}Context7 MCP - Library Documentation${NC}"
    echo "Provides up-to-date library docs for AI coding agents."
    echo ""

    # Show what was auto-installed
    if [ "$CONTEXT7_INSTALLED_CLAUDE" = true ]; then
        echo -e "  ${GREEN}✓${NC} Auto-installed for Claude Code (.mcp.json)"
    fi
    if [ "$CONTEXT7_INSTALLED_CONTINUE" = true ]; then
        echo -e "  ${GREEN}✓${NC} Auto-installed for Continue (.continue/config.yaml)"
    fi

    # Check for agents that need manual setup
    NEEDS_MANUAL_MCP=false
    if [ "$INSTALL_CURSOR" = true ]; then
        echo -e "  ${YELLOW}!${NC} Cursor: Configure via Cursor Settings > MCP"
        NEEDS_MANUAL_MCP=true
    fi
    if [ "$INSTALL_WINDSURF" = true ]; then
        echo -e "  ${YELLOW}!${NC} Windsurf: Install via Plugin Store"
        NEEDS_MANUAL_MCP=true
    fi
    if [ "$INSTALL_CLINE" = true ]; then
        echo -e "  ${YELLOW}!${NC} Cline: Install via MCP Marketplace"
        NEEDS_MANUAL_MCP=true
    fi

    if [ "$NEEDS_MANUAL_MCP" = true ]; then
        echo ""
        echo "  Package: @upstash/context7-mcp@latest"
        echo "  Docs: https://github.com/upstash/context7-mcp"
    fi

    # ============================================
    # Save package manager preference
    # ============================================
    echo "" >> .env.local
    echo "# Package Manager (auto-detected)" >> .env.local
    echo "PKG_MANAGER=$PKG_MANAGER" >> .env.local

    # Add .env.local to .gitignore if not present
    if [ -f ".gitignore" ]; then
        if ! grep -q "\.env\.local" .gitignore; then
            echo "" >> .gitignore
            echo "# Local environment variables" >> .gitignore
            echo ".env.local" >> .gitignore
        fi
    else
        echo "# Local environment variables" > .gitignore
        echo ".env.local" >> .gitignore
    fi

    echo ""
    echo -e "  ${GREEN}Configuration saved to .env.local${NC}"
    echo -e "  ${GREEN}Added .env.local to .gitignore${NC}"

else
    echo ""
    echo "Skipping external services. You can configure them later by editing .env.local"
fi

# ============================================
# SUCCESS MESSAGE
# ============================================
echo ""
echo -e "${GREEN}=============================================="
echo -e "  Forge v1.1.0 Setup Complete!"
echo -e "==============================================${NC}"
echo ""

# Show backup notification if created
if [ "$AGENTS_BACKUP_CREATED" = true ]; then
    echo -e "${YELLOW}Note: Previous AGENTS.md backed up to AGENTS.md.backup${NC}"
    echo ""
fi

# Show existing installation upgrade notice
if [ "$EXISTING_INSTALL" = true ]; then
    echo -e "${GREEN}Existing installation upgraded successfully.${NC}"
    echo ""
fi

# Show what was installed
echo "Installed for:"
[ "$INSTALL_CLAUDE" = true ] && echo -e "  ${GREEN}*${NC} Claude Code         (.claude/commands/)"
[ "$INSTALL_CURSOR" = true ] && echo -e "  ${GREEN}*${NC} Cursor              (.cursor/rules/)"
[ "$INSTALL_WINDSURF" = true ] && echo -e "  ${GREEN}*${NC} Windsurf            (.windsurf/workflows/)"
[ "$INSTALL_KILOCODE" = true ] && echo -e "  ${GREEN}*${NC} Kilo Code           (.kilocode/workflows/)"
[ "$INSTALL_ANTIGRAVITY" = true ] && echo -e "  ${GREEN}*${NC} Google Antigravity  (.agent/workflows/)"
[ "$INSTALL_COPILOT" = true ] && echo -e "  ${GREEN}*${NC} GitHub Copilot      (.github/prompts/)"
[ "$INSTALL_CONTINUE" = true ] && echo -e "  ${GREEN}*${NC} Continue            (.continue/prompts/)"
[ "$INSTALL_OPENCODE" = true ] && echo -e "  ${GREEN}*${NC} OpenCode            (.opencode/commands/)"
[ "$INSTALL_CLINE" = true ] && echo -e "  ${GREEN}*${NC} Cline               (.clinerules)"
[ "$INSTALL_ROO" = true ] && echo -e "  ${GREEN}*${NC} Roo Code            (.roo/commands/)"
[ "$INSTALL_AIDER" = true ] && echo -e "  ${GREEN}*${NC} Aider               (.aider.conf.yml)"

echo ""
echo -e "${CYAN}=============================================="
echo -e "  GET STARTED"
echo -e "==============================================${NC}"
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
echo ""
echo "Optional tools:"
echo "  - Beads: $PKG_MANAGER install -g @beads/bd && bd init"
echo "  - OpenSpec: $PKG_MANAGER install -g @fission-ai/openspec"
echo ""
echo -e "${CYAN}Package manager detected: $PKG_MANAGER${NC}"
echo ""
