#!/usr/bin/env node

/**
 * Forge v1.1.0 - Universal AI Agent Workflow Installer
 * https://github.com/harshanandak/forge
 *
 * Supports: Claude Code, Cursor, Windsurf, Kilo Code, OpenCode,
 *           Aider, Continue, GitHub Copilot, Cline, Roo Code, Google Antigravity
 */

const fs = require('fs');
const path = require('path');

const COMMANDS = [
  'status.md', 'research.md', 'plan.md', 'dev.md', 'check.md',
  'ship.md', 'review.md', 'merge.md', 'verify.md'
];

const SKILLS_PARALLEL_AI = [
  'SKILL.md', 'README.md', 'api-reference.md', 'quick-reference.md', 'research-workflows.md'
];

const SKILLS_SONARCLOUD = ['SKILL.md', 'reference.md'];

// All agent directories to create
const AGENT_DIRS = [
  // Claude Code
  '.claude/commands',
  '.claude/rules',
  '.claude/skills/parallel-ai',
  '.claude/skills/sonarcloud',
  '.claude/skills/forge-workflow',
  '.claude/scripts',
  // Google Antigravity
  '.agent/rules',
  '.agent/workflows',
  '.agent/skills/forge-workflow',
  // Cursor
  '.cursor/rules',
  '.cursor/skills/forge-workflow',
  // Windsurf
  '.windsurf/workflows',
  '.windsurf/rules',
  '.windsurf/skills/forge-workflow',
  // Kilo Code
  '.kilocode/workflows',
  '.kilocode/rules',
  '.kilocode/skills/forge-workflow',
  // Cline
  '.cline/skills/forge-workflow',
  // Continue
  '.continue/prompts',
  '.continue/skills/forge-workflow',
  // OpenCode
  '.opencode/commands',
  '.opencode/skills/forge-workflow',
  // Roo Code
  '.roo/commands',
  // GitHub Copilot
  '.github/prompts',
  '.github/instructions',
  // Documentation
  'docs/planning',
  'docs/research'
];

console.log('');
console.log('  ___                   ');
console.log(' |  _|___  _ _  ___  ___ ');
console.log(' |  _| . || \'_|| . || -_|');
console.log(' |_| |___||_|  |_  ||___|');
console.log('                 |___|   ');
console.log('');
console.log('Installing Forge v1.1.0 - Universal AI Agent Workflow');
console.log('Supporting ALL major AI coding agents...');
console.log('');

// Get the project root (where npm install was run)
const projectRoot = process.env.INIT_CWD || process.cwd();

// Get the package directory (where forge is installed)
const packageDir = path.dirname(__dirname);

// Helper functions
function ensureDir(dir) {
  const fullPath = path.join(projectRoot, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
}

function copyFile(src, dest) {
  try {
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      return true;
    }
  } catch (err) {
    // Silently continue if file doesn't exist
  }
  return false;
}

function createSymlinkOrCopy(source, target) {
  const fullSource = path.join(projectRoot, source);
  const fullTarget = path.join(projectRoot, target);

  try {
    // Remove existing target
    if (fs.existsSync(fullTarget)) {
      fs.unlinkSync(fullTarget);
    }

    // Ensure target directory exists
    const targetDir = path.dirname(fullTarget);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Try symlink first (relative path for portability)
    try {
      const relPath = path.relative(targetDir, fullSource);
      fs.symlinkSync(relPath, fullTarget);
      console.log(`  Linked: ${target} -> ${source}`);
      return true;
    } catch (symlinkErr) {
      // Fall back to copy (Windows without admin)
      fs.copyFileSync(fullSource, fullTarget);
      console.log(`  Copied: ${target} (from ${source})`);
      return true;
    }
  } catch (err) {
    console.log(`  Warning: Could not create ${target}`);
    return false;
  }
}

function stripFrontmatter(content) {
  // Remove YAML frontmatter (---...---)
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1] : content;
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return null;
  }
}

function writeFile(filePath, content) {
  try {
    fs.writeFileSync(filePath, content);
    return true;
  } catch (err) {
    return false;
  }
}

// ============================================
// CREATE DIRECTORIES FOR ALL AGENTS
// ============================================
console.log('Creating agent directories...');
AGENT_DIRS.forEach(dir => ensureDir(dir));
console.log('  Created directories for 11 AI agents');

// ============================================
// COPY CLAUDE CODE COMMANDS (MASTER FORMAT)
// ============================================
console.log('');
console.log('Copying workflow commands...');
COMMANDS.forEach(cmd => {
  const src = path.join(packageDir, '.claude/commands', cmd);
  const dest = path.join(projectRoot, '.claude/commands', cmd);
  if (copyFile(src, dest)) {
    console.log(`  Copied: ${cmd}`);
  }
});

// Copy rules
console.log('Copying workflow rules...');
const rulesSrc = path.join(packageDir, '.claude/rules/workflow.md');
const rulesDest = path.join(projectRoot, '.claude/rules/workflow.md');
if (copyFile(rulesSrc, rulesDest)) {
  console.log('  Copied: workflow.md');
}

// Copy scripts
console.log('Copying scripts...');
const scriptSrc = path.join(packageDir, '.claude/scripts/load-env.sh');
const scriptDest = path.join(projectRoot, '.claude/scripts/load-env.sh');
if (copyFile(scriptSrc, scriptDest)) {
  console.log('  Copied: load-env.sh');
}

// ============================================
// COPY AGENTS.MD
// ============================================
console.log('');
console.log('Creating universal instruction files...');
const agentsSrc = path.join(packageDir, 'AGENTS.md');
const agentsDest = path.join(projectRoot, 'AGENTS.md');
if (copyFile(agentsSrc, agentsDest)) {
  console.log('  Copied: AGENTS.md (universal standard)');
}

// ============================================
// CREATE SYMLINKS (Single Source of Truth)
// ============================================
console.log('');
console.log('Creating instruction file links (single source of truth)...');

createSymlinkOrCopy('AGENTS.md', 'CLAUDE.md');
createSymlinkOrCopy('AGENTS.md', 'GEMINI.md');
createSymlinkOrCopy('AGENTS.md', '.cursorrules');
createSymlinkOrCopy('AGENTS.md', '.windsurfrules');
createSymlinkOrCopy('AGENTS.md', '.clinerules');
createSymlinkOrCopy('AGENTS.md', '.github/copilot-instructions.md');

// ============================================
// CONVERT COMMANDS TO AGENT-SPECIFIC FORMATS
// ============================================
console.log('');
console.log('Converting commands for each agent...');

// Read all Claude commands
const commandContents = {};
COMMANDS.forEach(cmd => {
  const src = path.join(projectRoot, '.claude/commands', cmd);
  const content = readFile(src);
  if (content) {
    commandContents[cmd] = content;
  }
});

// Google Antigravity: Remove YAML frontmatter
Object.entries(commandContents).forEach(([cmd, content]) => {
  const dest = path.join(projectRoot, '.agent/workflows', cmd);
  writeFile(dest, stripFrontmatter(content));
});
console.log('  Converted: .agent/workflows/ (Google Antigravity)');

// Kilo Code: Remove YAML frontmatter
Object.entries(commandContents).forEach(([cmd, content]) => {
  const dest = path.join(projectRoot, '.kilocode/workflows', cmd);
  writeFile(dest, stripFrontmatter(content));
});
console.log('  Converted: .kilocode/workflows/ (Kilo Code)');

// Windsurf: Remove YAML frontmatter
Object.entries(commandContents).forEach(([cmd, content]) => {
  const dest = path.join(projectRoot, '.windsurf/workflows', cmd);
  writeFile(dest, stripFrontmatter(content));
});
console.log('  Converted: .windsurf/workflows/ (Windsurf)');

// OpenCode: Keep as-is (same YAML format)
Object.entries(commandContents).forEach(([cmd, content]) => {
  const dest = path.join(projectRoot, '.opencode/commands', cmd);
  writeFile(dest, content);
});
console.log('  Copied: .opencode/commands/ (OpenCode)');

// Roo Code: Remove YAML frontmatter
Object.entries(commandContents).forEach(([cmd, content]) => {
  const dest = path.join(projectRoot, '.roo/commands', cmd);
  writeFile(dest, stripFrontmatter(content));
});
console.log('  Converted: .roo/commands/ (Roo Code)');

// Continue: Convert to .prompt with invokable: true
Object.entries(commandContents).forEach(([cmd, content]) => {
  const baseName = cmd.replace('.md', '');
  const dest = path.join(projectRoot, '.continue/prompts', `${baseName}.prompt`);
  const promptContent = `---
name: ${baseName}
description: Forge workflow command - ${baseName}
invokable: true
---

${stripFrontmatter(content)}`;
  writeFile(dest, promptContent);
});
console.log('  Converted: .continue/prompts/ (Continue)');

// GitHub Copilot: Convert to .prompt.md
Object.entries(commandContents).forEach(([cmd, content]) => {
  const baseName = cmd.replace('.md', '');
  const dest = path.join(projectRoot, '.github/prompts', `${baseName}.prompt.md`);
  writeFile(dest, stripFrontmatter(content));
});
console.log('  Converted: .github/prompts/ (GitHub Copilot)');

// Cursor: Create workflow.mdc rule
const cursorRule = `---
description: Forge 9-Stage TDD Workflow
alwaysApply: true
---

# Forge Workflow Commands

Use these commands via \`/command-name\`:

1. \`/status\` - Check current context, active work, recent completions
2. \`/research\` - Deep research with web search, document to docs/research/
3. \`/plan\` - Create implementation plan, branch, tracking
4. \`/dev\` - TDD development (RED-GREEN-REFACTOR cycles)
5. \`/check\` - Validation (type/lint/security/tests)
6. \`/ship\` - Create PR with full documentation
7. \`/review\` - Address ALL PR feedback
8. \`/merge\` - Update docs, merge PR, cleanup
9. \`/verify\` - Final documentation verification

## Workflow Flow

\`\`\`
/status -> /research -> /plan -> /dev -> /check -> /ship -> /review -> /merge -> /verify
\`\`\`

## Core Principles

- **TDD-First**: Write tests BEFORE implementation (RED-GREEN-REFACTOR)
- **Research-First**: Understand before building, document decisions
- **Security Built-In**: OWASP Top 10 analysis for every feature
- **Documentation Progressive**: Update at each stage, verify at end

See AGENTS.md for full workflow details.
`;
writeFile(path.join(projectRoot, '.cursor/rules/forge-workflow.mdc'), cursorRule);
console.log('  Created: .cursor/rules/forge-workflow.mdc (Cursor)');

// ============================================
// CREATE UNIVERSAL SKILL (SKILL.md)
// ============================================
console.log('');
console.log('Installing universal SKILL.md for all supporting agents...');

const forgeSkill = `---
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
| 1 | \`/status\` | Check current context, active work, recent completions |
| 2 | \`/research\` | Deep research with web search, document to docs/research/ |
| 3 | \`/plan\` | Create implementation plan, branch, OpenSpec if strategic |
| 4 | \`/dev\` | TDD development (RED-GREEN-REFACTOR cycles) |
| 5 | \`/check\` | Validation (type/lint/security/tests) |
| 6 | \`/ship\` | Create PR with full documentation |
| 7 | \`/review\` | Address ALL PR feedback (GitHub Actions, Greptile, SonarCloud) |
| 8 | \`/merge\` | Update docs, merge PR, cleanup |
| 9 | \`/verify\` | Final documentation verification |

## Workflow Flow

\`\`\`
/status -> /research -> /plan -> /dev -> /check -> /ship -> /review -> /merge -> /verify
\`\`\`

## Core Principles

- **TDD-First**: Write tests BEFORE implementation (RED-GREEN-REFACTOR)
- **Research-First**: Understand before building, document decisions
- **Security Built-In**: OWASP Top 10 analysis for every feature
- **Documentation Progressive**: Update at each stage, verify at end

## Prerequisites

- Git and GitHub CLI (\`gh\`)
- Beads (recommended): \`npm i -g beads-cli && bd init\`
- OpenSpec (optional): \`npm i -g openspec-cli\`

## Quick Start

1. \`/status\` - Check where you are
2. \`/research <feature-name>\` - Research the feature
3. \`/plan <feature-slug>\` - Create formal plan
4. \`/dev\` - Implement with TDD
5. \`/check\` - Validate everything
6. \`/ship\` - Create PR

See docs/WORKFLOW.md for detailed workflow guide.
`;

// Install SKILL.md to all supporting agents
const skillDirs = [
  '.claude/skills/forge-workflow',
  '.agent/skills/forge-workflow',
  '.cursor/skills/forge-workflow',
  '.windsurf/skills/forge-workflow',
  '.kilocode/skills/forge-workflow',
  '.cline/skills/forge-workflow',
  '.continue/skills/forge-workflow',
  '.opencode/skills/forge-workflow'
];

skillDirs.forEach(dir => {
  writeFile(path.join(projectRoot, dir, 'SKILL.md'), forgeSkill);
});
console.log('  Installed SKILL.md to 8 agents (universal format)');

// ============================================
// COPY RULES TO OTHER AGENTS
// ============================================
console.log('');
console.log('Copying rules to supporting agents...');

const workflowRule = readFile(path.join(projectRoot, '.claude/rules/workflow.md'));
if (workflowRule) {
  writeFile(path.join(projectRoot, '.agent/rules/workflow.md'), workflowRule);
  writeFile(path.join(projectRoot, '.windsurf/rules/workflow.md'), workflowRule);
  writeFile(path.join(projectRoot, '.kilocode/rules/workflow.md'), workflowRule);
  console.log('  Copied rules to: .agent/, .windsurf/, .kilocode/');
}

// ============================================
// COPY SKILLS (parallel-ai, sonarcloud)
// ============================================
console.log('');
console.log('Copying skills...');
SKILLS_PARALLEL_AI.forEach(file => {
  const src = path.join(packageDir, '.claude/skills/parallel-ai', file);
  const dest = path.join(projectRoot, '.claude/skills/parallel-ai', file);
  copyFile(src, dest);
});
console.log('  Copied: parallel-ai');

SKILLS_SONARCLOUD.forEach(file => {
  const src = path.join(packageDir, '.claude/skills/sonarcloud', file);
  const dest = path.join(projectRoot, '.claude/skills/sonarcloud', file);
  copyFile(src, dest);
});
console.log('  Copied: sonarcloud');

// ============================================
// COPY DOCUMENTATION
// ============================================
console.log('');
console.log('Copying documentation...');
const workflowSrc = path.join(packageDir, 'docs/WORKFLOW.md');
const workflowDest = path.join(projectRoot, 'docs/WORKFLOW.md');
if (copyFile(workflowSrc, workflowDest)) {
  console.log('  Copied: WORKFLOW.md');
}

const templateSrc = path.join(packageDir, 'docs/research/TEMPLATE.md');
const templateDest = path.join(projectRoot, 'docs/research/TEMPLATE.md');
if (copyFile(templateSrc, templateDest)) {
  console.log('  Copied: research/TEMPLATE.md');
}

// Create PROGRESS.md if it doesn't exist
const progressPath = path.join(projectRoot, 'docs/planning/PROGRESS.md');
if (!fs.existsSync(progressPath)) {
  const progressContent = `# Project Progress

## Current Focus
<!-- What you're working on -->

## Completed
<!-- Completed features -->

## Upcoming
<!-- Next priorities -->
`;
  writeFile(progressPath, progressContent);
  console.log('  Created: docs/planning/PROGRESS.md');
}

// ============================================
// SUCCESS MESSAGE
// ============================================
console.log('');
console.log('==============================================');
console.log('  Forge v1.1.0 installed successfully!');
console.log('==============================================');
console.log('');
console.log('Commands installed for:');
console.log('  - Claude Code         (.claude/commands/)      Full support');
console.log('  - Google Antigravity  (.agent/workflows/)      Full support');
console.log('  - OpenCode            (.opencode/commands/)    Full support');
console.log('  - Kilo Code           (.kilocode/workflows/)   Full support');
console.log('  - Windsurf            (.windsurf/workflows/)   Full support');
console.log('  - Roo Code            (.roo/commands/)         Full support');
console.log('  - Continue            (.continue/prompts/)     Full support');
console.log('  - GitHub Copilot      (.github/prompts/)       VS Code only');
console.log('  - Cursor              (.cursor/rules/)         Via rules');
console.log('  - Cline               (AGENTS.md)              Via instructions');
console.log('  - Aider               (AGENTS.md)              Via instructions');
console.log('');
console.log('Skills installed for:');
console.log('  - Claude Code, Antigravity, Cursor, Windsurf, Kilo Code,');
console.log('    Cline, Continue, OpenCode (same SKILL.md works everywhere!)');
console.log('');
console.log('Instruction files (linked to AGENTS.md):');
console.log('  - CLAUDE.md           Claude Code');
console.log('  - GEMINI.md           Google Antigravity');
console.log('  - .cursorrules        Cursor');
console.log('  - .windsurfrules      Windsurf');
console.log('  - .clinerules         Cline/Roo Code');
console.log('  - .github/copilot-instructions.md  GitHub Copilot');
console.log('');
console.log('==============================================');
console.log('  GET STARTED');
console.log('==============================================');
console.log('');
console.log('  /status    - Check current context');
console.log('  /research  - Start researching a feature');
console.log('  /plan      - Create implementation plan');
console.log('  /dev       - Start TDD development');
console.log('  /check     - Run validation');
console.log('  /ship      - Create pull request');
console.log('  /review    - Address PR feedback');
console.log('  /merge     - Merge and cleanup');
console.log('  /verify    - Final documentation check');
console.log('');
console.log('  Full guide: docs/WORKFLOW.md');
console.log('  Research template: docs/research/TEMPLATE.md');
console.log('');
console.log('Optional tools:');
console.log('  - Beads: npm i -g beads-cli && bd init');
console.log('  - OpenSpec: npm i -g openspec-cli');
console.log('');
