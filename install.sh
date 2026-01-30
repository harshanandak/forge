#!/bin/bash
# Forge - 9-Stage TDD-First Workflow Installer
# https://github.com/harshanandak/forge

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
echo "Installing Forge - 9-Stage TDD-First Workflow..."
echo ""

# Create directories
echo "Creating directories..."
mkdir -p .claude/commands
mkdir -p .claude/rules
mkdir -p .claude/skills/parallel-ai
mkdir -p .claude/skills/sonarcloud
mkdir -p .claude/scripts
mkdir -p docs/research

# Download commands
echo "Downloading workflow commands..."
for cmd in status research plan dev check ship review merge verify; do
    curl -fsSL "$BASE_URL/.claude/commands/$cmd.md" -o ".claude/commands/$cmd.md"
    echo "  ✓ $cmd.md"
done

# Download rules
echo "Downloading workflow rules..."
curl -fsSL "$BASE_URL/.claude/rules/workflow.md" -o ".claude/rules/workflow.md"
echo "  ✓ workflow.md"

# Download skills
echo "Downloading skills..."
for file in SKILL.md README.md api-reference.md quick-reference.md research-workflows.md; do
    curl -fsSL "$BASE_URL/.claude/skills/parallel-ai/$file" -o ".claude/skills/parallel-ai/$file" 2>/dev/null || true
done
echo "  ✓ parallel-ai"

curl -fsSL "$BASE_URL/.claude/skills/sonarcloud/SKILL.md" -o ".claude/skills/sonarcloud/SKILL.md" 2>/dev/null || true
echo "  ✓ sonarcloud"

# Download scripts
echo "Downloading scripts..."
curl -fsSL "$BASE_URL/.claude/scripts/load-env.sh" -o ".claude/scripts/load-env.sh"
chmod +x .claude/scripts/load-env.sh
echo "  ✓ load-env.sh"

# Download documentation
echo "Downloading documentation..."
curl -fsSL "$BASE_URL/docs/WORKFLOW.md" -o "docs/WORKFLOW.md"
echo "  ✓ WORKFLOW.md"

curl -fsSL "$BASE_URL/docs/research/TEMPLATE.md" -o "docs/research/TEMPLATE.md"
echo "  ✓ research/TEMPLATE.md"

echo ""
echo "✅ Forge installed successfully!"
echo ""
echo "┌─────────────────────────────────────────────────────────┐"
echo "│                    GET STARTED                          │"
echo "├─────────────────────────────────────────────────────────┤"
echo "│  /status    - Check current context                     │"
echo "│  /research  - Start researching a feature               │"
echo "│  /plan      - Create implementation plan                │"
echo "│  /dev       - Start TDD development                     │"
echo "│  /check     - Run validation                            │"
echo "│  /ship      - Create pull request                       │"
echo "│  /review    - Address PR feedback                       │"
echo "│  /merge     - Merge and cleanup                         │"
echo "│  /verify    - Final documentation check                 │"
echo "├─────────────────────────────────────────────────────────┤"
echo "│  Full guide: docs/WORKFLOW.md                           │"
echo "│  Research template: docs/research/TEMPLATE.md           │"
echo "└─────────────────────────────────────────────────────────┘"
echo ""
echo "Optional: Install Beads for issue tracking"
echo "  See: https://github.com/beads-ai/beads-cli"
echo ""
