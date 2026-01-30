#!/usr/bin/env node

/**
 * Forge v1.1.0 - Universal AI Agent Workflow
 * https://github.com/harshanandak/forge
 *
 * Usage:
 *   npm install forge-workflow  -> Minimal install (AGENTS.md + docs)
 *   npx forge setup             -> Interactive agent configuration
 *   npx forge setup --all       -> Install for all agents
 *   npx forge setup --agents claude,cursor,windsurf
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Get the project root and package directory
const projectRoot = process.env.INIT_CWD || process.cwd();
const packageDir = path.dirname(__dirname);
const args = process.argv.slice(2);

// Agent definitions
const AGENTS = {
  claude: {
    name: 'Claude Code',
    description: "Anthropic's CLI agent",
    dirs: ['.claude/commands', '.claude/rules', '.claude/skills/forge-workflow', '.claude/scripts'],
    hasCommands: true,
    hasSkill: true,
    linkFile: 'CLAUDE.md'
  },
  cursor: {
    name: 'Cursor',
    description: 'AI-first code editor',
    dirs: ['.cursor/rules', '.cursor/skills/forge-workflow'],
    hasSkill: true,
    linkFile: '.cursorrules',
    customSetup: 'cursor'
  },
  windsurf: {
    name: 'Windsurf',
    description: "Codeium's agentic IDE",
    dirs: ['.windsurf/workflows', '.windsurf/rules', '.windsurf/skills/forge-workflow'],
    hasSkill: true,
    linkFile: '.windsurfrules',
    needsConversion: true
  },
  kilocode: {
    name: 'Kilo Code',
    description: 'VS Code extension',
    dirs: ['.kilocode/workflows', '.kilocode/rules', '.kilocode/skills/forge-workflow'],
    hasSkill: true,
    needsConversion: true
  },
  antigravity: {
    name: 'Google Antigravity',
    description: "Google's agent IDE",
    dirs: ['.agent/workflows', '.agent/rules', '.agent/skills/forge-workflow'],
    hasSkill: true,
    linkFile: 'GEMINI.md',
    needsConversion: true
  },
  copilot: {
    name: 'GitHub Copilot',
    description: "GitHub's AI assistant",
    dirs: ['.github/prompts', '.github/instructions'],
    linkFile: '.github/copilot-instructions.md',
    needsConversion: true,
    promptFormat: true
  },
  continue: {
    name: 'Continue',
    description: 'Open-source AI assistant',
    dirs: ['.continue/prompts', '.continue/skills/forge-workflow'],
    hasSkill: true,
    needsConversion: true,
    continueFormat: true
  },
  opencode: {
    name: 'OpenCode',
    description: 'Open-source agent',
    dirs: ['.opencode/commands', '.opencode/skills/forge-workflow'],
    hasSkill: true,
    copyCommands: true
  },
  cline: {
    name: 'Cline',
    description: 'VS Code agent extension',
    dirs: ['.cline/skills/forge-workflow'],
    hasSkill: true,
    linkFile: '.clinerules'
  },
  roo: {
    name: 'Roo Code',
    description: 'Cline fork with modes',
    dirs: ['.roo/commands'],
    linkFile: '.clinerules',
    needsConversion: true
  },
  aider: {
    name: 'Aider',
    description: 'Terminal-based agent',
    dirs: [],
    customSetup: 'aider'
  }
};

const COMMANDS = ['status', 'research', 'plan', 'dev', 'check', 'ship', 'review', 'merge', 'verify'];

// Universal SKILL.md content
const SKILL_CONTENT = `---
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
| 7 | \`/review\` | Address ALL PR feedback |
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
`;

// Cursor MDC rule content
const CURSOR_RULE = `---
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

See AGENTS.md for full workflow details.
`;

// Helper functions
function ensureDir(dir) {
  const fullPath = path.join(projectRoot, dir);
  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
}

function writeFile(filePath, content) {
  try {
    const fullPath = path.join(projectRoot, filePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content);
    return true;
  } catch (err) {
    return false;
  }
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return null;
  }
}

function copyFile(src, dest) {
  try {
    if (fs.existsSync(src)) {
      const destPath = path.join(projectRoot, dest);
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.copyFileSync(src, destPath);
      return true;
    }
  } catch (err) {}
  return false;
}

function createSymlinkOrCopy(source, target) {
  const fullSource = path.join(projectRoot, source);
  const fullTarget = path.join(projectRoot, target);

  try {
    if (fs.existsSync(fullTarget)) {
      fs.unlinkSync(fullTarget);
    }
    const targetDir = path.dirname(fullTarget);
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    try {
      const relPath = path.relative(targetDir, fullSource);
      fs.symlinkSync(relPath, fullTarget);
      return 'linked';
    } catch (symlinkErr) {
      fs.copyFileSync(fullSource, fullTarget);
      return 'copied';
    }
  } catch (err) {
    return false;
  }
}

function stripFrontmatter(content) {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/);
  return match ? match[1] : content;
}

// Minimal installation (postinstall)
function minimalInstall() {
  console.log('');
  console.log('  ___                   ');
  console.log(' |  _|___  _ _  ___  ___ ');
  console.log(' |  _| . || \'_|| . || -_|');
  console.log(' |_| |___||_|  |_  ||___|');
  console.log('                 |___|   ');
  console.log('');
  console.log('Forge v1.1.0 - Universal AI Agent Workflow');
  console.log('');

  // Create core directories
  ensureDir('docs/planning');
  ensureDir('docs/research');

  // Copy AGENTS.md
  const agentsSrc = path.join(packageDir, 'AGENTS.md');
  if (copyFile(agentsSrc, 'AGENTS.md')) {
    console.log('  Created: AGENTS.md (universal standard)');
  }

  // Copy documentation
  const workflowSrc = path.join(packageDir, 'docs/WORKFLOW.md');
  if (copyFile(workflowSrc, 'docs/WORKFLOW.md')) {
    console.log('  Created: docs/WORKFLOW.md');
  }

  const templateSrc = path.join(packageDir, 'docs/research/TEMPLATE.md');
  if (copyFile(templateSrc, 'docs/research/TEMPLATE.md')) {
    console.log('  Created: docs/research/TEMPLATE.md');
  }

  // Create PROGRESS.md if not exists
  const progressPath = path.join(projectRoot, 'docs/planning/PROGRESS.md');
  if (!fs.existsSync(progressPath)) {
    writeFile('docs/planning/PROGRESS.md', `# Project Progress

## Current Focus
<!-- What you're working on -->

## Completed
<!-- Completed features -->

## Upcoming
<!-- Next priorities -->
`);
    console.log('  Created: docs/planning/PROGRESS.md');
  }

  console.log('');
  console.log('Minimal installation complete!');
  console.log('');
  console.log('To configure for your AI coding agents, run:');
  console.log('');
  console.log('  npx forge setup');
  console.log('');
  console.log('Or specify agents directly:');
  console.log('  npx forge setup --agents claude,cursor,windsurf');
  console.log('  npx forge setup --all');
  console.log('');
}

// Setup specific agent
function setupAgent(agentKey, claudeCommands) {
  const agent = AGENTS[agentKey];
  if (!agent) return;

  console.log(`\nSetting up ${agent.name}...`);

  // Create directories
  agent.dirs.forEach(dir => ensureDir(dir));

  // Handle Claude Code specifically (downloads commands)
  if (agentKey === 'claude') {
    // Copy commands from package
    COMMANDS.forEach(cmd => {
      const src = path.join(packageDir, `.claude/commands/${cmd}.md`);
      copyFile(src, `.claude/commands/${cmd}.md`);
    });
    console.log('  Copied: 9 workflow commands');

    // Copy rules
    const rulesSrc = path.join(packageDir, '.claude/rules/workflow.md');
    copyFile(rulesSrc, '.claude/rules/workflow.md');

    // Copy scripts
    const scriptSrc = path.join(packageDir, '.claude/scripts/load-env.sh');
    copyFile(scriptSrc, '.claude/scripts/load-env.sh');
  }

  // Custom setups
  if (agent.customSetup === 'cursor') {
    writeFile('.cursor/rules/forge-workflow.mdc', CURSOR_RULE);
    console.log('  Created: .cursor/rules/forge-workflow.mdc');
  }

  if (agent.customSetup === 'aider') {
    const aiderPath = path.join(projectRoot, '.aider.conf.yml');
    if (!fs.existsSync(aiderPath)) {
      writeFile('.aider.conf.yml', `# Aider configuration
# Read AGENTS.md for workflow instructions
read:
  - AGENTS.md
  - docs/WORKFLOW.md
`);
      console.log('  Created: .aider.conf.yml');
    } else {
      console.log('  Skipped: .aider.conf.yml already exists');
    }
    return;
  }

  // Convert/copy commands
  if (claudeCommands && (agent.needsConversion || agent.copyCommands || agent.promptFormat || agent.continueFormat)) {
    Object.entries(claudeCommands).forEach(([cmd, content]) => {
      let targetContent = content;
      let targetFile = cmd;

      if (agent.needsConversion) {
        targetContent = stripFrontmatter(content);
      }

      if (agent.promptFormat) {
        targetFile = cmd.replace('.md', '.prompt.md');
        targetContent = stripFrontmatter(content);
      }

      if (agent.continueFormat) {
        const baseName = cmd.replace('.md', '');
        targetFile = `${baseName}.prompt`;
        targetContent = `---
name: ${baseName}
description: Forge workflow command - ${baseName}
invokable: true
---

${stripFrontmatter(content)}`;
      }

      const targetDir = agent.dirs[0]; // First dir is commands/workflows
      writeFile(`${targetDir}/${targetFile}`, targetContent);
    });
    console.log('  Converted: 9 workflow commands');
  }

  // Copy rules if needed
  if (agent.needsConversion && fs.existsSync(path.join(projectRoot, '.claude/rules/workflow.md'))) {
    const rulesDir = agent.dirs.find(d => d.includes('/rules'));
    if (rulesDir) {
      const ruleContent = readFile(path.join(projectRoot, '.claude/rules/workflow.md'));
      if (ruleContent) {
        writeFile(`${rulesDir}/workflow.md`, ruleContent);
      }
    }
  }

  // Create SKILL.md
  if (agent.hasSkill) {
    const skillDir = agent.dirs.find(d => d.includes('/skills/'));
    if (skillDir) {
      writeFile(`${skillDir}/SKILL.md`, SKILL_CONTENT);
      console.log('  Created: forge-workflow skill');
    }
  }

  // Create link file
  if (agent.linkFile) {
    const result = createSymlinkOrCopy('AGENTS.md', agent.linkFile);
    if (result) {
      console.log(`  ${result === 'linked' ? 'Linked' : 'Copied'}: ${agent.linkFile}`);
    }
  }
}

// Interactive setup
async function interactiveSetup() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

  console.log('');
  console.log('  ___                   ');
  console.log(' |  _|___  _ _  ___  ___ ');
  console.log(' |  _| . || \'_|| . || -_|');
  console.log(' |_| |___||_|  |_  ||___|');
  console.log('                 |___|   ');
  console.log('');
  console.log('Forge v1.1.0 - Agent Configuration');
  console.log('');
  console.log('Which AI coding agents do you use?');
  console.log('(Enter numbers separated by spaces, or "all")');
  console.log('');

  const agentKeys = Object.keys(AGENTS);
  agentKeys.forEach((key, index) => {
    const agent = AGENTS[key];
    console.log(`  ${(index + 1).toString().padStart(2)}) ${agent.name.padEnd(20)} - ${agent.description}`);
  });
  console.log('');
  console.log('  all) Install for all agents');
  console.log('');

  const answer = await question('Your selection: ');
  rl.close();

  let selectedAgents = [];

  if (answer.toLowerCase() === 'all') {
    selectedAgents = agentKeys;
  } else {
    const nums = answer.split(/[\s,]+/).map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    selectedAgents = nums.map(n => agentKeys[n - 1]).filter(Boolean);
  }

  if (selectedAgents.length === 0) {
    console.log('No agents selected. Run "npx forge setup" to try again.');
    return;
  }

  console.log('');
  console.log('Installing Forge workflow...');

  // Load Claude commands if needed
  let claudeCommands = {};
  if (selectedAgents.includes('claude') || selectedAgents.some(a => AGENTS[a].needsConversion || AGENTS[a].copyCommands)) {
    // First ensure Claude is set up
    if (selectedAgents.includes('claude')) {
      setupAgent('claude', null);
    }
    // Then load the commands
    COMMANDS.forEach(cmd => {
      const cmdPath = path.join(projectRoot, `.claude/commands/${cmd}.md`);
      const content = readFile(cmdPath);
      if (content) {
        claudeCommands[`${cmd}.md`] = content;
      }
    });
  }

  // Setup each selected agent
  selectedAgents.forEach(agentKey => {
    if (agentKey !== 'claude') { // Claude already done above
      setupAgent(agentKey, claudeCommands);
    }
  });

  // Success message
  console.log('');
  console.log('==============================================');
  console.log('  Forge v1.1.0 installed successfully!');
  console.log('==============================================');
  console.log('');
  console.log('Installed for:');
  selectedAgents.forEach(key => {
    const agent = AGENTS[key];
    console.log(`  * ${agent.name}`);
  });
  console.log('');
  console.log('Get started with: /status');
  console.log('Full guide: docs/WORKFLOW.md');
  console.log('');
}

// CLI setup with args
function setupWithArgs(agentList) {
  console.log('');
  console.log('Forge v1.1.0 - Installing for specified agents...');
  console.log('');

  const selectedAgents = agentList.split(',').map(a => a.trim().toLowerCase()).filter(a => AGENTS[a]);

  if (selectedAgents.length === 0) {
    console.log('No valid agents specified.');
    console.log('Available agents:', Object.keys(AGENTS).join(', '));
    return;
  }

  // Load Claude commands if needed
  let claudeCommands = {};
  if (selectedAgents.includes('claude')) {
    setupAgent('claude', null);
  }

  if (selectedAgents.some(a => AGENTS[a].needsConversion || AGENTS[a].copyCommands)) {
    COMMANDS.forEach(cmd => {
      const cmdPath = path.join(projectRoot, `.claude/commands/${cmd}.md`);
      const content = readFile(cmdPath);
      if (content) {
        claudeCommands[`${cmd}.md`] = content;
      }
    });
  }

  selectedAgents.forEach(agentKey => {
    if (agentKey !== 'claude') {
      setupAgent(agentKey, claudeCommands);
    }
  });

  console.log('');
  console.log('Done! Get started with: /status');
}

// Main
async function main() {
  const command = args[0];

  if (command === 'setup') {
    // Check for --all flag
    if (args.includes('--all')) {
      setupWithArgs(Object.keys(AGENTS).join(','));
      return;
    }

    // Check for --agents flag
    const agentsIndex = args.indexOf('--agents');
    if (agentsIndex !== -1 && args[agentsIndex + 1]) {
      setupWithArgs(args[agentsIndex + 1]);
      return;
    }

    // Interactive setup
    await interactiveSetup();
  } else {
    // Default: minimal install (postinstall behavior)
    minimalInstall();
  }
}

main().catch(console.error);
