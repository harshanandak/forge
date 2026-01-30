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
 *
 * Also works with bun:
 *   bun add forge-workflow
 *   bunx forge setup
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

// External services that can be configured
const EXTERNAL_SERVICES = {
  parallel: {
    name: 'Parallel AI',
    description: 'Deep research & web search',
    envVar: 'PARALLEL_API_KEY',
    getKeyUrl: 'https://platform.parallel.ai',
    required: false,
    usedIn: ['/research']
  },
  greptile: {
    name: 'Greptile',
    description: 'AI code review on PRs',
    envVar: 'GREPTILE_API_KEY',
    getKeyUrl: 'https://app.greptile.com/api',
    required: false,
    usedIn: ['/review']
  },
  sonarcloud: {
    name: 'SonarCloud',
    description: 'Code quality & security',
    envVar: 'SONAR_TOKEN',
    getKeyUrl: 'https://sonarcloud.io/account/security',
    required: false,
    usedIn: ['/check', '/review']
  },
  openrouter: {
    name: 'OpenRouter',
    description: 'Multi-model AI access',
    envVar: 'OPENROUTER_API_KEY',
    getKeyUrl: 'https://openrouter.ai/keys',
    required: false,
    usedIn: ['AI features']
  }
};

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

// Read existing .env.local
function readEnvFile() {
  const envPath = path.join(projectRoot, '.env.local');
  try {
    if (fs.existsSync(envPath)) {
      return fs.readFileSync(envPath, 'utf8');
    }
  } catch (err) {}
  return '';
}

// Write or update .env.local
function writeEnvTokens(tokens) {
  const envPath = path.join(projectRoot, '.env.local');
  let content = readEnvFile();

  // Parse existing content
  const lines = content.split('\n');
  const existingVars = {};
  lines.forEach(line => {
    const match = line.match(/^([A-Z_]+)=/);
    if (match) {
      existingVars[match[1]] = line;
    }
  });

  // Add/update tokens
  let added = [];
  Object.entries(tokens).forEach(([key, value]) => {
    if (value && value.trim()) {
      existingVars[key] = `${key}=${value.trim()}`;
      added.push(key);
    }
  });

  // Rebuild file with comments
  const outputLines = [];

  // Add header if new file
  if (!content.includes('# External Service API Keys')) {
    outputLines.push('# External Service API Keys for Forge Workflow');
    outputLines.push('# Get your keys from:');
    outputLines.push('#   Parallel AI: https://platform.parallel.ai');
    outputLines.push('#   Greptile: https://app.greptile.com/api');
    outputLines.push('#   SonarCloud: https://sonarcloud.io/account/security');
    outputLines.push('#   OpenRouter: https://openrouter.ai/keys');
    outputLines.push('');
  }

  // Add existing content (preserve order and comments)
  lines.forEach(line => {
    const match = line.match(/^([A-Z_]+)=/);
    if (match && existingVars[match[1]]) {
      outputLines.push(existingVars[match[1]]);
      delete existingVars[match[1]]; // Mark as added
    } else if (line.trim()) {
      outputLines.push(line);
    }
  });

  // Add any new tokens not in original file
  Object.values(existingVars).forEach(line => {
    outputLines.push(line);
  });

  // Ensure ends with newline
  let finalContent = outputLines.join('\n').trim() + '\n';

  fs.writeFileSync(envPath, finalContent);

  // Add .env.local to .gitignore if not present
  const gitignorePath = path.join(projectRoot, '.gitignore');
  try {
    let gitignore = '';
    if (fs.existsSync(gitignorePath)) {
      gitignore = fs.readFileSync(gitignorePath, 'utf8');
    }
    if (!gitignore.includes('.env.local')) {
      fs.appendFileSync(gitignorePath, '\n# Local environment variables\n.env.local\n');
    }
  } catch (err) {}

  return added;
}

// Configure external services interactively
async function configureExternalServices(rl, question) {
  console.log('');
  console.log('==============================================');
  console.log('  External Services Configuration');
  console.log('==============================================');
  console.log('');
  console.log('Forge uses external services for enhanced features:');
  console.log('');

  const serviceKeys = Object.keys(EXTERNAL_SERVICES);
  serviceKeys.forEach((key, index) => {
    const svc = EXTERNAL_SERVICES[key];
    console.log(`  ${(index + 1).toString().padStart(2)}) ${svc.name.padEnd(15)} - ${svc.description}`);
    console.log(`      Used in: ${svc.usedIn.join(', ')}`);
    console.log(`      Get key: ${svc.getKeyUrl}`);
    console.log('');
  });

  console.log('Would you like to configure API tokens now?');
  console.log('(You can also add them later to .env.local)');
  console.log('');

  const configure = await question('Configure tokens? (y/n): ');

  if (configure.toLowerCase() !== 'y' && configure.toLowerCase() !== 'yes') {
    console.log('');
    console.log('Skipping token configuration. You can add tokens later to .env.local');
    return;
  }

  console.log('');
  console.log('Enter your API tokens (press Enter to skip any):');
  console.log('');

  const tokens = {};

  for (const [key, svc] of Object.entries(EXTERNAL_SERVICES)) {
    const token = await question(`  ${svc.name} (${svc.envVar}): `);
    if (token && token.trim()) {
      tokens[svc.envVar] = token.trim();
    }
  }

  // Check if any tokens provided
  const providedTokens = Object.keys(tokens).length;
  if (providedTokens === 0) {
    console.log('');
    console.log('No tokens provided. You can add them later to .env.local');
    return;
  }

  // Write to .env.local
  const added = writeEnvTokens(tokens);

  console.log('');
  console.log(`Saved ${added.length} token(s) to .env.local:`);
  added.forEach(key => {
    console.log(`  - ${key}`);
  });
  console.log('');
  console.log('Note: .env.local has been added to .gitignore');
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
  console.log('  npx forge setup      # Interactive setup (agents + API tokens)');
  console.log('  bunx forge setup     # Same with bun');
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

  // =============================================
  // STEP 1: Agent Selection
  // =============================================
  console.log('STEP 1: Select AI Coding Agents');
  console.log('================================');
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

  let selectedAgents = [];

  if (answer.toLowerCase() === 'all') {
    selectedAgents = agentKeys;
  } else {
    const nums = answer.split(/[\s,]+/).map(n => parseInt(n.trim())).filter(n => !isNaN(n));
    selectedAgents = nums.map(n => agentKeys[n - 1]).filter(Boolean);
  }

  if (selectedAgents.length === 0) {
    console.log('No agents selected. Run "npx forge setup" to try again.');
    rl.close();
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

  // Agent installation success
  console.log('');
  console.log('Agent configuration complete!');
  console.log('');
  console.log('Installed for:');
  selectedAgents.forEach(key => {
    const agent = AGENTS[key];
    console.log(`  * ${agent.name}`);
  });

  // =============================================
  // STEP 2: External Services Configuration
  // =============================================
  console.log('');
  console.log('STEP 2: External Services (Optional)');
  console.log('=====================================');

  await configureExternalServices(rl, question);

  rl.close();

  // =============================================
  // Final Summary
  // =============================================
  console.log('');
  console.log('==============================================');
  console.log('  Forge v1.1.0 Setup Complete!');
  console.log('==============================================');
  console.log('');
  console.log('What\'s installed:');
  console.log('  - AGENTS.md (universal instructions)');
  console.log('  - docs/WORKFLOW.md (full workflow guide)');
  console.log('  - docs/research/TEMPLATE.md (research template)');
  console.log('  - docs/planning/PROGRESS.md (progress tracking)');
  selectedAgents.forEach(key => {
    const agent = AGENTS[key];
    if (agent.linkFile) {
      console.log(`  - ${agent.linkFile} (${agent.name})`);
    }
    if (agent.hasCommands) {
      console.log(`  - .claude/commands/ (9 workflow commands)`);
    }
    if (agent.hasSkill) {
      const skillDir = agent.dirs.find(d => d.includes('/skills/'));
      if (skillDir) {
        console.log(`  - ${skillDir}/SKILL.md`);
      }
    }
  });
  console.log('');
  console.log('Next steps:');
  console.log('  1. Install optional tools: beads-cli, openspec-cli');
  console.log('  2. Start with: /status');
  console.log('  3. Read the guide: docs/WORKFLOW.md');
  console.log('');
  console.log('Happy shipping!');
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
