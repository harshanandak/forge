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
const { execSync } = require('child_process');

// Get the project root and package directory
const projectRoot = process.env.INIT_CWD || process.cwd();
const packageDir = path.dirname(__dirname);
const args = process.argv.slice(2);

// Detected package manager
let PKG_MANAGER = 'npm';

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

// Code review tool options
const CODE_REVIEW_TOOLS = {
  'github-code-quality': {
    name: 'GitHub Code Quality',
    description: 'FREE, built-in - Zero setup required',
    recommended: true
  },
  'coderabbit': {
    name: 'CodeRabbit',
    description: 'FREE for open source - Install GitHub App at https://coderabbit.ai'
  },
  'greptile': {
    name: 'Greptile',
    description: 'Paid ($99+/mo) - Enterprise code review',
    requiresApiKey: true,
    envVar: 'GREPTILE_API_KEY',
    getKeyUrl: 'https://greptile.com'
  }
};

// Code quality tool options
const CODE_QUALITY_TOOLS = {
  'eslint': {
    name: 'ESLint only',
    description: 'FREE, built-in - No external server required',
    recommended: true
  },
  'sonarcloud': {
    name: 'SonarCloud',
    description: '50k LoC free, cloud-hosted',
    requiresApiKey: true,
    envVars: ['SONAR_TOKEN', 'SONAR_ORGANIZATION', 'SONAR_PROJECT_KEY'],
    getKeyUrl: 'https://sonarcloud.io/account/security'
  },
  'sonarqube': {
    name: 'SonarQube Community',
    description: 'FREE, self-hosted, unlimited LoC',
    envVars: ['SONARQUBE_URL', 'SONARQUBE_TOKEN'],
    dockerCommand: 'docker run -d --name sonarqube -p 9000:9000 sonarqube:community'
  }
};

// Helper function to safely execute commands (no user input)
function safeExec(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    return null;
  }
}

// Prerequisite check function
function checkPrerequisites() {
  const errors = [];
  const warnings = [];

  console.log('');
  console.log('Checking prerequisites...');
  console.log('');

  // Check git
  const gitVersion = safeExec('git --version');
  if (gitVersion) {
    console.log(`  ✓ ${gitVersion}`);
  } else {
    errors.push('git - Install from https://git-scm.com');
  }

  // Check GitHub CLI
  const ghVersion = safeExec('gh --version');
  if (ghVersion) {
    console.log(`  ✓ ${ghVersion.split('\\n')[0]}`);
    // Check if authenticated
    const authStatus = safeExec('gh auth status');
    if (!authStatus) {
      warnings.push('GitHub CLI not authenticated. Run: gh auth login');
    }
  } else {
    errors.push('gh (GitHub CLI) - Install from https://cli.github.com');
  }

  // Check Node.js version
  const nodeVersion = parseInt(process.version.slice(1).split('.')[0]);
  if (nodeVersion >= 20) {
    console.log(`  ✓ node ${process.version}`);
  } else {
    errors.push(`Node.js 20+ required (current: ${process.version})`);
  }

  // Detect package manager
  const bunVersion = safeExec('bun --version');
  if (bunVersion) {
    PKG_MANAGER = 'bun';
    console.log(`  ✓ bun v${bunVersion} (detected as package manager)`);
  } else {
    const pnpmVersion = safeExec('pnpm --version');
    if (pnpmVersion) {
      PKG_MANAGER = 'pnpm';
      console.log(`  ✓ pnpm ${pnpmVersion} (detected as package manager)`);
    } else {
      const yarnVersion = safeExec('yarn --version');
      if (yarnVersion) {
        PKG_MANAGER = 'yarn';
        console.log(`  ✓ yarn ${yarnVersion} (detected as package manager)`);
      } else {
        const npmVersion = safeExec('npm --version');
        if (npmVersion) {
          PKG_MANAGER = 'npm';
          console.log(`  ✓ npm ${npmVersion} (detected as package manager)`);
        } else {
          errors.push('npm, yarn, pnpm, or bun - Install a package manager');
        }
      }
    }
  }

  // Also detect from lock files if present
  const bunLock = path.join(projectRoot, 'bun.lockb');
  const bunLock2 = path.join(projectRoot, 'bun.lock');
  const pnpmLock = path.join(projectRoot, 'pnpm-lock.yaml');
  const yarnLock = path.join(projectRoot, 'yarn.lock');

  if (fs.existsSync(bunLock) || fs.existsSync(bunLock2)) {
    PKG_MANAGER = 'bun';
  } else if (fs.existsSync(pnpmLock)) {
    PKG_MANAGER = 'pnpm';
  } else if (fs.existsSync(yarnLock)) {
    PKG_MANAGER = 'yarn';
  }

  // Show errors
  if (errors.length > 0) {
    console.log('');
    console.log('❌ Missing required tools:');
    errors.forEach(err => console.log(`   - ${err}`));
    console.log('');
    console.log('Please install missing tools and try again.');
    process.exit(1);
  }

  // Show warnings
  if (warnings.length > 0) {
    console.log('');
    console.log('⚠️  Warnings:');
    warnings.forEach(warn => console.log(`   - ${warn}`));
  }

  console.log('');
  console.log(`  Package manager: ${PKG_MANAGER}`);

  return { errors, warnings };
}

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
  console.log('Would you like to configure external services?');
  console.log('(You can also add them later to .env.local)');
  console.log('');

  const configure = await question('Configure external services? (y/n): ');

  if (configure.toLowerCase() !== 'y' && configure.toLowerCase() !== 'yes') {
    console.log('');
    console.log('Skipping external services. You can configure them later by editing .env.local');
    return;
  }

  const tokens = {};

  // ============================================
  // CODE REVIEW TOOL SELECTION
  // ============================================
  console.log('');
  console.log('Code Review Tool');
  console.log('----------------');
  console.log('Select your code review integration:');
  console.log('');
  console.log('  1) GitHub Code Quality (FREE, built-in) [RECOMMENDED]');
  console.log('     Zero setup - uses GitHub\'s built-in code quality features');
  console.log('');
  console.log('  2) CodeRabbit (FREE for open source)');
  console.log('     AI-powered reviews - install GitHub App at https://coderabbit.ai');
  console.log('');
  console.log('  3) Greptile (Paid - $99+/mo)');
  console.log('     Enterprise code review - https://greptile.com');
  console.log('');
  console.log('  4) Skip code review integration');
  console.log('');

  const codeReviewChoice = await question('Select [1]: ') || '1';

  switch (codeReviewChoice) {
    case '1':
      tokens['CODE_REVIEW_TOOL'] = 'github-code-quality';
      console.log('  ✓ Using GitHub Code Quality (FREE)');
      break;
    case '2':
      tokens['CODE_REVIEW_TOOL'] = 'coderabbit';
      console.log('  ✓ Using CodeRabbit - Install the GitHub App to activate');
      console.log('     https://coderabbit.ai');
      break;
    case '3':
      const greptileKey = await question('  Enter Greptile API key: ');
      if (greptileKey && greptileKey.trim()) {
        tokens['CODE_REVIEW_TOOL'] = 'greptile';
        tokens['GREPTILE_API_KEY'] = greptileKey.trim();
        console.log('  ✓ Greptile configured');
      } else {
        tokens['CODE_REVIEW_TOOL'] = 'none';
        console.log('  Skipped - No API key provided');
      }
      break;
    default:
      tokens['CODE_REVIEW_TOOL'] = 'none';
      console.log('  Skipped code review integration');
  }

  // ============================================
  // CODE QUALITY TOOL SELECTION
  // ============================================
  console.log('');
  console.log('Code Quality Tool');
  console.log('-----------------');
  console.log('Select your code quality/security scanner:');
  console.log('');
  console.log('  1) ESLint only (FREE, built-in) [RECOMMENDED]');
  console.log('     No external server required - uses project\'s linting');
  console.log('');
  console.log('  2) SonarCloud (50k LoC free, cloud-hosted)');
  console.log('     Get token: https://sonarcloud.io/account/security');
  console.log('');
  console.log('  3) SonarQube Community (FREE, self-hosted, unlimited LoC)');
  console.log('     Run: docker run -d --name sonarqube -p 9000:9000 sonarqube:community');
  console.log('');
  console.log('  4) Skip code quality integration');
  console.log('');

  const codeQualityChoice = await question('Select [1]: ') || '1';

  switch (codeQualityChoice) {
    case '1':
      tokens['CODE_QUALITY_TOOL'] = 'eslint';
      console.log('  ✓ Using ESLint (built-in)');
      break;
    case '2':
      const sonarToken = await question('  Enter SonarCloud token: ');
      const sonarOrg = await question('  Enter SonarCloud organization: ');
      const sonarProject = await question('  Enter SonarCloud project key: ');
      if (sonarToken && sonarToken.trim()) {
        tokens['CODE_QUALITY_TOOL'] = 'sonarcloud';
        tokens['SONAR_TOKEN'] = sonarToken.trim();
        if (sonarOrg) tokens['SONAR_ORGANIZATION'] = sonarOrg.trim();
        if (sonarProject) tokens['SONAR_PROJECT_KEY'] = sonarProject.trim();
        console.log('  ✓ SonarCloud configured');
      } else {
        tokens['CODE_QUALITY_TOOL'] = 'eslint';
        console.log('  Falling back to ESLint');
      }
      break;
    case '3':
      console.log('');
      console.log('  SonarQube Self-Hosted Setup:');
      console.log('  docker run -d --name sonarqube -p 9000:9000 sonarqube:community');
      console.log('  Access: http://localhost:9000 (admin/admin)');
      console.log('');
      const sqUrl = await question('  Enter SonarQube URL [http://localhost:9000]: ') || 'http://localhost:9000';
      const sqToken = await question('  Enter SonarQube token (optional): ');
      tokens['CODE_QUALITY_TOOL'] = 'sonarqube';
      tokens['SONARQUBE_URL'] = sqUrl;
      if (sqToken && sqToken.trim()) {
        tokens['SONARQUBE_TOKEN'] = sqToken.trim();
      }
      console.log('  ✓ SonarQube self-hosted configured');
      break;
    default:
      tokens['CODE_QUALITY_TOOL'] = 'none';
      console.log('  Skipped code quality integration');
  }

  // ============================================
  // RESEARCH TOOL SELECTION
  // ============================================
  console.log('');
  console.log('Research Tool');
  console.log('-------------');
  console.log('Select your research tool for /research stage:');
  console.log('');
  console.log('  1) Manual research only [DEFAULT]');
  console.log('     Use web browser and codebase exploration');
  console.log('');
  console.log('  2) Parallel AI (comprehensive web research)');
  console.log('     Get key: https://platform.parallel.ai');
  console.log('');

  const researchChoice = await question('Select [1]: ') || '1';

  if (researchChoice === '2') {
    const parallelKey = await question('  Enter Parallel AI API key: ');
    if (parallelKey && parallelKey.trim()) {
      tokens['PARALLEL_API_KEY'] = parallelKey.trim();
      console.log('  ✓ Parallel AI configured');
    } else {
      console.log('  Skipped - No API key provided');
    }
  } else {
    console.log('  ✓ Using manual research');
  }

  // ============================================
  // OPTIONAL: OpenRouter
  // ============================================
  console.log('');
  console.log('AI Model Access (Optional)');
  console.log('--------------------------');
  console.log('OpenRouter provides access to multiple AI models.');
  console.log('Get key: https://openrouter.ai/keys');
  console.log('');

  const openrouterKey = await question('Enter OpenRouter API key (or press Enter to skip): ');
  if (openrouterKey && openrouterKey.trim()) {
    tokens['OPENROUTER_API_KEY'] = openrouterKey.trim();
    console.log('  ✓ OpenRouter configured');
  }

  // Save package manager preference
  tokens['PKG_MANAGER'] = PKG_MANAGER;

  // Write all tokens to .env.local
  const added = writeEnvTokens(tokens);

  console.log('');
  console.log('Configuration saved to .env.local');
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

  // Create .mcp.json with Context7 MCP (Claude Code only)
  if (agentKey === 'claude') {
    const mcpPath = path.join(projectRoot, '.mcp.json');
    if (!fs.existsSync(mcpPath)) {
      const mcpConfig = {
        mcpServers: {
          context7: {
            command: 'npx',
            args: ['-y', '@upstash/context7-mcp@latest']
          }
        }
      };
      writeFile('.mcp.json', JSON.stringify(mcpConfig, null, 2));
      console.log('  Created: .mcp.json with Context7 MCP');
    } else {
      console.log('  Skipped: .mcp.json already exists');
    }
  }

  // Create config.yaml with Context7 MCP (Continue only)
  if (agentKey === 'continue') {
    const configPath = path.join(projectRoot, '.continue/config.yaml');
    if (!fs.existsSync(configPath)) {
      const continueConfig = `# Continue Configuration
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
`;
      writeFile('.continue/config.yaml', continueConfig);
      console.log('  Created: config.yaml with Context7 MCP');
    } else {
      console.log('  Skipped: config.yaml already exists');
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

  // Check prerequisites first
  checkPrerequisites();
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
  console.log(`  1. Install optional tools:`);
  console.log(`     ${PKG_MANAGER} install -g @beads/bd && bd init`);
  console.log(`     ${PKG_MANAGER} install -g @fission-ai/openspec`);
  console.log('  2. Start with: /status');
  console.log('  3. Read the guide: docs/WORKFLOW.md');
  console.log('');
  console.log(`Package manager detected: ${PKG_MANAGER}`);
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
