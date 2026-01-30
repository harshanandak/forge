#!/bin/bash
# Forge v1.1.0 - Universal AI Agent Workflow Installer
# https://github.com/harshanandak/forge
#
# Interactive installer - select only the agents you use

set -e

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
# AGENT SELECTION
# ============================================
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

echo ""
echo -e "${BLUE}Installing Forge workflow...${NC}"
echo ""

# ============================================
# ALWAYS CREATE: Core directories and AGENTS.md
# ============================================
echo "Creating core directories..."
mkdir -p docs/planning docs/research

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

# Function to create symlink or copy
create_link() {
    local source="$1"
    local target="$2"
    rm -f "$target" 2>/dev/null || true
    if ln -s "$source" "$target" 2>/dev/null; then
        echo -e "  ${GREEN}Linked: $target -> $source${NC}"
    else
        cp "$source" "$target" 2>/dev/null || true
        echo -e "  ${GREEN}Copied: $target${NC}"
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
echo ""
echo -e "${YELLOW}=============================================="
echo -e "  EXTERNAL SERVICES (Optional)"
echo -e "==============================================${NC}"
echo ""
echo "Forge uses external services for enhanced features:"
echo ""
echo "  1) Parallel AI     - Deep research & web search"
echo "     Get key: https://platform.parallel.ai"
echo "     Used in: /research"
echo ""
echo "  2) Greptile        - AI code review on PRs"
echo "     Get key: https://app.greptile.com/api"
echo "     Used in: /review"
echo ""
echo "  3) SonarCloud      - Code quality & security"
echo "     Get key: https://sonarcloud.io/account/security"
echo "     Used in: /check, /review"
echo ""
echo "  4) OpenRouter      - Multi-model AI access"
echo "     Get key: https://openrouter.ai/keys"
echo "     Used in: AI features"
echo ""
echo "Would you like to configure API tokens now?"
echo "(You can also add them later to .env.local)"
echo ""

read -p "Configure tokens? (y/n): " configure_tokens

if [[ "$configure_tokens" == "y" || "$configure_tokens" == "Y" || "$configure_tokens" == "yes" ]]; then
    echo ""
    echo "Enter your API tokens (press Enter to skip any):"
    echo ""

    TOKENS_ADDED=false

    read -p "  Parallel AI (PARALLEL_API_KEY): " PARALLEL_KEY
    read -p "  Greptile (GREPTILE_API_KEY): " GREPTILE_KEY
    read -p "  SonarCloud (SONAR_TOKEN): " SONAR_KEY
    read -p "  OpenRouter (OPENROUTER_API_KEY): " OPENROUTER_KEY

    # Create or update .env.local
    if [[ -n "$PARALLEL_KEY" || -n "$GREPTILE_KEY" || -n "$SONAR_KEY" || -n "$OPENROUTER_KEY" ]]; then
        # Add header if new file
        if [ ! -f ".env.local" ]; then
            cat > .env.local << 'ENV_HEADER'
# External Service API Keys for Forge Workflow
# Get your keys from:
#   Parallel AI: https://platform.parallel.ai
#   Greptile: https://app.greptile.com/api
#   SonarCloud: https://sonarcloud.io/account/security
#   OpenRouter: https://openrouter.ai/keys

ENV_HEADER
        fi

        # Add tokens
        [ -n "$PARALLEL_KEY" ] && echo "PARALLEL_API_KEY=$PARALLEL_KEY" >> .env.local && TOKENS_ADDED=true
        [ -n "$GREPTILE_KEY" ] && echo "GREPTILE_API_KEY=$GREPTILE_KEY" >> .env.local && TOKENS_ADDED=true
        [ -n "$SONAR_KEY" ] && echo "SONAR_TOKEN=$SONAR_KEY" >> .env.local && TOKENS_ADDED=true
        [ -n "$OPENROUTER_KEY" ] && echo "OPENROUTER_API_KEY=$OPENROUTER_KEY" >> .env.local && TOKENS_ADDED=true

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
        if [ "$TOKENS_ADDED" = true ]; then
            echo -e "  ${GREEN}Saved tokens to .env.local${NC}"
            echo -e "  ${GREEN}Added .env.local to .gitignore${NC}"
        fi
    else
        echo ""
        echo "No tokens provided. You can add them later to .env.local"
    fi
else
    echo ""
    echo "Skipping token configuration. You can add tokens later to .env.local"
fi

# ============================================
# SUCCESS MESSAGE
# ============================================
echo ""
echo -e "${GREEN}=============================================="
echo -e "  Forge v1.1.0 Setup Complete!"
echo -e "==============================================${NC}"
echo ""

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
echo "  - Beads: npm i -g beads-cli && bd init"
echo "  - OpenSpec: npm i -g openspec-cli"
echo ""
