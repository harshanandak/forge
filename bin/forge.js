#!/usr/bin/env node

/**
 * Forge v1.1.2 - Universal AI Agent Workflow
 * https://github.com/harshanandak/forge
 *
 * Usage:
 *   npm install forge-workflow  -> Minimal install (AGENTS.md + docs)
 *   npx forge setup             -> Interactive agent configuration
 *   npx forge setup --all       -> Install for all agents
 *   npx forge setup --agents claude,cursor,windsurf
 *
 * CLI Flags:
 *   --quick, -q          Use all defaults, minimal prompts
 *   --skip-external      Skip external services configuration
 *   --agents <list>      Specify agents (--agents claude cursor OR --agents=claude,cursor)
 *   --all                Install for all available agents
 *   --help, -h           Show help message
 *
 * Examples:
 *   npx forge setup --quick                    # All defaults, no prompts
 *   npx forge setup --agents claude cursor     # Just these agents
 *   npx forge setup --skip-external            # No service prompts
 *   npx forge setup --agents claude --quick    # Quick + specific agent
 *
 * Also works with bun:
 *   bun add forge-workflow
 *   bunx forge setup --quick
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

// SECURITY: Freeze AGENTS to prevent runtime manipulation
Object.freeze(AGENTS);
Object.values(AGENTS).forEach(agent => Object.freeze(agent));

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
const resolvedProjectRoot = path.resolve(projectRoot);

function ensureDir(dir) {
  const fullPath = path.resolve(projectRoot, dir);

  // SECURITY: Prevent path traversal
  if (!fullPath.startsWith(resolvedProjectRoot)) {
    console.error(`  ✗ Security: Directory path escape blocked: ${dir}`);
    return false;
  }

  if (!fs.existsSync(fullPath)) {
    fs.mkdirSync(fullPath, { recursive: true });
  }
  return true;
}

function writeFile(filePath, content) {
  try {
    const fullPath = path.resolve(projectRoot, filePath);

    // SECURITY: Prevent path traversal
    if (!fullPath.startsWith(resolvedProjectRoot)) {
      console.error(`  ✗ Security: Write path escape blocked: ${filePath}`);
      return false;
    }

    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(fullPath, content, { mode: 0o644 });
    return true;
  } catch (err) {
    console.error(`  ✗ Failed to write ${filePath}: ${err.message}`);
    return false;
  }
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (process.env.DEBUG) {
      console.warn(`  ⚠ Could not read ${filePath}: ${err.message}`);
    }
    return null;
  }
}

function copyFile(src, dest) {
  try {
    const destPath = path.resolve(projectRoot, dest);

    // SECURITY: Prevent path traversal
    if (!destPath.startsWith(resolvedProjectRoot)) {
      console.error(`  ✗ Security: Copy destination escape blocked: ${dest}`);
      return false;
    }

    if (fs.existsSync(src)) {
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      fs.copyFileSync(src, destPath);
      return true;
    } else {
      if (process.env.DEBUG) {
        console.warn(`  ⚠ Source file not found: ${src}`);
      }
    }
  } catch (err) {
    console.error(`  ✗ Failed to copy ${src} -> ${dest}: ${err.message}`);
  }
  return false;
}

function createSymlinkOrCopy(source, target) {
  const fullSource = path.resolve(projectRoot, source);
  const fullTarget = path.resolve(projectRoot, target);
  const resolvedProjectRoot = path.resolve(projectRoot);

  // SECURITY: Prevent path traversal attacks
  if (!fullSource.startsWith(resolvedProjectRoot)) {
    console.error(`  ✗ Security: Source path escape blocked: ${source}`);
    return false;
  }
  if (!fullTarget.startsWith(resolvedProjectRoot)) {
    console.error(`  ✗ Security: Target path escape blocked: ${target}`);
    return false;
  }

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
    console.error(`  ✗ Failed to link/copy ${source} -> ${target}: ${err.message}`);
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

// Parse .env.local and return key-value pairs
function parseEnvFile() {
  const content = readEnvFile();
  const lines = content.split(/\r?\n/);
  const vars = {};
  lines.forEach(line => {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (match) {
      vars[match[1]] = match[2];
    }
  });
  return vars;
}

// Write or update .env.local - PRESERVES existing values
function writeEnvTokens(tokens, preserveExisting = true) {
  const envPath = path.join(projectRoot, '.env.local');
  let content = readEnvFile();

  // Parse existing content (handle both CRLF and LF line endings)
  const lines = content.split(/\r?\n/);
  const existingVars = {};
  const existingKeys = new Set();
  lines.forEach(line => {
    const match = line.match(/^([A-Z_]+)=/);
    if (match) {
      existingVars[match[1]] = line;
      existingKeys.add(match[1]);
    }
  });

  // Track what was added vs preserved
  let added = [];
  let preserved = [];

  // Add/update tokens - PRESERVE existing values if preserveExisting is true
  Object.entries(tokens).forEach(([key, value]) => {
    if (value && value.trim()) {
      if (preserveExisting && existingKeys.has(key)) {
        // Keep existing value, don't overwrite
        preserved.push(key);
      } else {
        // Add new token
        existingVars[key] = `${key}=${value.trim()}`;
        added.push(key);
      }
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

  return { added, preserved };
}

// Detect existing project installation status
function detectProjectStatus() {
  const status = {
    type: 'fresh', // 'fresh', 'upgrade', or 'partial'
    hasAgentsMd: fs.existsSync(path.join(projectRoot, 'AGENTS.md')),
    hasClaudeCommands: fs.existsSync(path.join(projectRoot, '.claude/commands')),
    hasEnvLocal: fs.existsSync(path.join(projectRoot, '.env.local')),
    hasDocsWorkflow: fs.existsSync(path.join(projectRoot, 'docs/WORKFLOW.md')),
    existingEnvVars: {}
  };

  // Determine installation type
  if (status.hasAgentsMd && status.hasClaudeCommands && status.hasDocsWorkflow) {
    status.type = 'upgrade'; // Full forge installation exists
  } else if (status.hasAgentsMd || status.hasClaudeCommands || status.hasEnvLocal) {
    status.type = 'partial'; // Some files exist
  }
  // else: 'fresh' - new installation

  // Parse existing env vars if .env.local exists
  if (status.hasEnvLocal) {
    status.existingEnvVars = parseEnvFile();
  }

  return status;
}

// Configure external services interactively
async function configureExternalServices(rl, question, selectedAgents = [], projectStatus = null) {
  console.log('');
  console.log('==============================================');
  console.log('  External Services Configuration');
  console.log('==============================================');
  console.log('');

  // Check if external services are already configured
  const existingEnvVars = projectStatus?.existingEnvVars || parseEnvFile();
  const hasCodeReviewTool = existingEnvVars.CODE_REVIEW_TOOL;
  const hasCodeQualityTool = existingEnvVars.CODE_QUALITY_TOOL;
  const hasExistingConfig = hasCodeReviewTool || hasCodeQualityTool;

  if (hasExistingConfig) {
    console.log('External services already configured:');
    if (hasCodeReviewTool) {
      console.log(`  - CODE_REVIEW_TOOL: ${hasCodeReviewTool}`);
    }
    if (hasCodeQualityTool) {
      console.log(`  - CODE_QUALITY_TOOL: ${hasCodeQualityTool}`);
    }
    console.log('');

    const reconfigure = await question('Reconfigure external services? (y/n) [n]: ');
    if (reconfigure.toLowerCase() !== 'y' && reconfigure.toLowerCase() !== 'yes') {
      console.log('');
      console.log('Keeping existing configuration.');
      return;
    }
    console.log('');
  }

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
  // CONTEXT7 MCP - Library Documentation
  // ============================================
  console.log('');
  console.log('Context7 MCP - Library Documentation');
  console.log('-------------------------------------');
  console.log('Provides up-to-date library docs for AI coding agents.');
  console.log('');

  // Show what was/will be auto-installed
  if (selectedAgents.includes('claude')) {
    console.log('  ✓ Auto-installed for Claude Code (.mcp.json)');
  }
  if (selectedAgents.includes('continue')) {
    console.log('  ✓ Auto-installed for Continue (.continue/config.yaml)');
  }

  // Show manual setup instructions for GUI-based agents
  const needsManualMcp = [];
  if (selectedAgents.includes('cursor')) needsManualMcp.push('Cursor: Configure via Cursor Settings > MCP');
  if (selectedAgents.includes('windsurf')) needsManualMcp.push('Windsurf: Install via Plugin Store');
  if (selectedAgents.includes('cline')) needsManualMcp.push('Cline: Install via MCP Marketplace');

  if (needsManualMcp.length > 0) {
    needsManualMcp.forEach(msg => console.log(`  ! ${msg}`));
    console.log('');
    console.log('  Package: @upstash/context7-mcp@latest');
    console.log('  Docs: https://github.com/upstash/context7-mcp');
  }

  // Save package manager preference
  tokens['PKG_MANAGER'] = PKG_MANAGER;

  // Write all tokens to .env.local (preserving existing values)
  const { added, preserved } = writeEnvTokens(tokens, true);

  console.log('');
  if (preserved.length > 0) {
    console.log('Preserved existing values:');
    preserved.forEach(key => {
      console.log(`  - ${key} already configured - keeping existing value`);
    });
    console.log('');
  }
  if (added.length > 0) {
    console.log('Added new configuration:');
    added.forEach(key => {
      console.log(`  - ${key}`);
    });
    console.log('');
  }
  console.log('Configuration saved to .env.local');
  console.log('Note: .env.local has been added to .gitignore');
}

// Display the Forge banner
function showBanner(subtitle = 'Universal AI Agent Workflow') {
  console.log('');
  console.log('  ███████╗ ██████╗ ██████╗  ██████╗ ███████╗');
  console.log('  ██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝');
  console.log('  █████╗  ██║   ██║██████╔╝██║  ███╗█████╗  ');
  console.log('  ██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝  ');
  console.log('  ██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗');
  console.log('  ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝');
  console.log('  v1.1.2');
  console.log('');
  if (subtitle) {
    console.log(`  ${subtitle}`);
  }
}

// Minimal installation (postinstall)
function minimalInstall() {
  showBanner();
  console.log('');

  // Create core directories
  ensureDir('docs/planning');
  ensureDir('docs/research');

  // Copy AGENTS.md (only if not exists - preserve user customizations in minimal install)
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    console.log('  Skipped: AGENTS.md (already exists)');
  } else {
    const agentsSrc = path.join(packageDir, 'AGENTS.md');
    if (copyFile(agentsSrc, 'AGENTS.md')) {
      console.log('  Created: AGENTS.md (universal standard)');
    }
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
function setupAgent(agentKey, claudeCommands, skipFiles = {}) {
  const agent = AGENTS[agentKey];
  if (!agent) return;

  console.log(`\nSetting up ${agent.name}...`);

  // Create directories
  agent.dirs.forEach(dir => ensureDir(dir));

  // Handle Claude Code specifically (downloads commands)
  if (agentKey === 'claude') {
    // Copy commands from package (unless skipped)
    if (skipFiles.claudeCommands) {
      console.log('  Skipped: .claude/commands/ (keeping existing)');
    } else {
      COMMANDS.forEach(cmd => {
        const src = path.join(packageDir, `.claude/commands/${cmd}.md`);
        copyFile(src, `.claude/commands/${cmd}.md`);
      });
      console.log('  Copied: 9 workflow commands');
    }

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

  let setupCompleted = false;

  // Handle Ctrl+C gracefully
  rl.on('close', () => {
    if (!setupCompleted) {
      console.log('\n\nSetup cancelled.');
      process.exit(0);
    }
  });

  // Handle input errors
  rl.on('error', (err) => {
    console.error('Input error:', err.message);
    process.exit(1);
  });

  const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

  showBanner('Agent Configuration');

  // Check prerequisites first
  checkPrerequisites();
  console.log('');

  // =============================================
  // PROJECT DETECTION
  // =============================================
  const projectStatus = detectProjectStatus();

  if (projectStatus.type !== 'fresh') {
    console.log('==============================================');
    console.log('  Existing Installation Detected');
    console.log('==============================================');
    console.log('');

    if (projectStatus.type === 'upgrade') {
      console.log('Found existing Forge installation:');
    } else {
      console.log('Found partial installation:');
    }

    if (projectStatus.hasAgentsMd) console.log('  - AGENTS.md');
    if (projectStatus.hasClaudeCommands) console.log('  - .claude/commands/');
    if (projectStatus.hasEnvLocal) console.log('  - .env.local');
    if (projectStatus.hasDocsWorkflow) console.log('  - docs/WORKFLOW.md');
    console.log('');
  }

  // Track which files to skip based on user choices
  const skipFiles = {
    agentsMd: false,
    claudeCommands: false
  };

  // Ask about overwriting AGENTS.md if it exists
  if (projectStatus.hasAgentsMd) {
    const overwriteAgents = await question('Found existing AGENTS.md. Overwrite? (y/n) [n]: ');
    if (overwriteAgents.toLowerCase() !== 'y' && overwriteAgents.toLowerCase() !== 'yes') {
      skipFiles.agentsMd = true;
      console.log('  Keeping existing AGENTS.md');
    } else {
      console.log('  Will overwrite AGENTS.md');
    }
  }

  // Ask about overwriting .claude/commands/ if it exists
  if (projectStatus.hasClaudeCommands) {
    const overwriteCommands = await question('Found existing .claude/commands/. Overwrite? (y/n) [n]: ');
    if (overwriteCommands.toLowerCase() !== 'y' && overwriteCommands.toLowerCase() !== 'yes') {
      skipFiles.claudeCommands = true;
      console.log('  Keeping existing .claude/commands/');
    } else {
      console.log('  Will overwrite .claude/commands/');
    }
  }

  if (projectStatus.type !== 'fresh') {
    console.log('');
  }

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

  let selectedAgents = [];

  // Loop until valid input is provided
  while (selectedAgents.length === 0) {
    const answer = await question('Your selection: ');

    // Handle empty input - reprompt
    if (!answer || !answer.trim()) {
      console.log('  Please enter at least one agent number or "all".');
      continue;
    }

    if (answer.toLowerCase() === 'all') {
      selectedAgents = agentKeys;
    } else {
      const nums = answer.split(/[\s,]+/).map(n => parseInt(n.trim())).filter(n => !isNaN(n));

      // Validate numbers are in range
      const validNums = nums.filter(n => n >= 1 && n <= agentKeys.length);
      const invalidNums = nums.filter(n => n < 1 || n > agentKeys.length);

      if (invalidNums.length > 0) {
        console.log(`  ⚠ Invalid numbers ignored: ${invalidNums.join(', ')} (valid: 1-${agentKeys.length})`);
      }

      // Deduplicate selected agents using Set
      selectedAgents = [...new Set(validNums.map(n => agentKeys[n - 1]))].filter(Boolean);
    }

    if (selectedAgents.length === 0) {
      console.log('  No valid agents selected. Please try again.');
    }
  }

  console.log('');
  console.log('Installing Forge workflow...');

  // Copy AGENTS.md unless skipped
  if (skipFiles.agentsMd) {
    console.log('  Skipped: AGENTS.md (keeping existing)');
  } else {
    const agentsSrc = path.join(packageDir, 'AGENTS.md');
    if (copyFile(agentsSrc, 'AGENTS.md')) {
      console.log('  Created: AGENTS.md (universal standard)');
    }
  }

  // Load Claude commands if needed
  let claudeCommands = {};
  if (selectedAgents.includes('claude') || selectedAgents.some(a => AGENTS[a].needsConversion || AGENTS[a].copyCommands)) {
    // First ensure Claude is set up
    if (selectedAgents.includes('claude')) {
      setupAgent('claude', null, skipFiles);
    }
    // Then load the commands (from existing or newly created)
    COMMANDS.forEach(cmd => {
      const cmdPath = path.join(projectRoot, `.claude/commands/${cmd}.md`);
      const content = readFile(cmdPath);
      if (content) {
        claudeCommands[`${cmd}.md`] = content;
      }
    });
  }

  // Setup each selected agent with progress indication
  const totalAgents = selectedAgents.length;
  selectedAgents.forEach((agentKey, index) => {
    const agent = AGENTS[agentKey];
    console.log(`\n[${index + 1}/${totalAgents}] Setting up ${agent.name}...`);
    if (agentKey !== 'claude') { // Claude already done above
      setupAgent(agentKey, claudeCommands, skipFiles);
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

  await configureExternalServices(rl, question, selectedAgents, projectStatus);

  setupCompleted = true;
  rl.close();

  // =============================================
  // Final Summary
  // =============================================
  console.log('');
  console.log('==============================================');
  console.log('  Forge v1.1.2 Setup Complete!');
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

// Parse CLI flags
function parseFlags() {
  const flags = {
    quick: false,
    skipExternal: false,
    agents: null,
    all: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--quick' || arg === '-q') {
      flags.quick = true;
    } else if (arg === '--skip-external' || arg === '--skip-services') {
      flags.skipExternal = true;
    } else if (arg === '--all') {
      flags.all = true;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--agents') {
      // --agents claude cursor format
      const agentList = [];
      for (let j = i + 1; j < args.length; j++) {
        if (args[j].startsWith('-')) break;
        agentList.push(args[j]);
      }
      if (agentList.length > 0) {
        flags.agents = agentList.join(',');
      }
    } else if (arg.startsWith('--agents=')) {
      // --agents=claude,cursor format
      flags.agents = arg.replace('--agents=', '');
    }
  }

  return flags;
}

// Validate agent names
function validateAgents(agentList) {
  const requested = agentList.split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
  const valid = requested.filter(a => AGENTS[a]);
  const invalid = requested.filter(a => !AGENTS[a]);

  if (invalid.length > 0) {
    console.log(`  Warning: Unknown agents ignored: ${invalid.join(', ')}`);
    console.log(`  Available agents: ${Object.keys(AGENTS).join(', ')}`);
  }

  return valid;
}

// Show help text
function showHelp() {
  showBanner();
  console.log('');
  console.log('Usage:');
  console.log('  npx forge setup [options]     Interactive agent configuration');
  console.log('  npx forge                     Minimal install (AGENTS.md + docs)');
  console.log('');
  console.log('Options:');
  console.log('  --quick, -q          Use all defaults, minimal prompts');
  console.log('                       Auto-selects: all agents, GitHub Code Quality, ESLint');
  console.log('  --skip-external      Skip external services configuration');
  console.log('  --agents <list>      Specify agents directly (skip selection prompt)');
  console.log('                       Accepts: --agents claude cursor');
  console.log('                                --agents=claude,cursor');
  console.log('  --all                Install for all available agents');
  console.log('  --help, -h           Show this help message');
  console.log('');
  console.log('Available agents:');
  Object.keys(AGENTS).forEach(key => {
    const agent = AGENTS[key];
    console.log(`  ${key.padEnd(14)} ${agent.name.padEnd(20)} ${agent.description}`);
  });
  console.log('');
  console.log('Examples:');
  console.log('  npx forge setup                          # Interactive setup');
  console.log('  npx forge setup --quick                  # All defaults, no prompts');
  console.log('  npx forge setup --agents claude cursor   # Just these agents');
  console.log('  npx forge setup --agents=claude,cursor   # Same, different syntax');
  console.log('  npx forge setup --skip-external          # No service configuration');
  console.log('  npx forge setup --agents claude --quick  # Quick + specific agent');
  console.log('  npx forge setup --all --skip-external    # All agents, no services');
  console.log('');
  console.log('Also works with bun:');
  console.log('  bunx forge setup --quick');
  console.log('');
}

// Quick setup with defaults
async function quickSetup(selectedAgents, skipExternal) {
  showBanner('Quick Setup');
  console.log('');
  console.log('Quick mode: Using defaults...');
  console.log('');

  // Check prerequisites
  checkPrerequisites();
  console.log('');

  // Copy AGENTS.md
  const agentsSrc = path.join(packageDir, 'AGENTS.md');
  if (copyFile(agentsSrc, 'AGENTS.md')) {
    console.log('  Created: AGENTS.md (universal standard)');
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

  // Setup each selected agent
  const totalAgents = selectedAgents.length;
  selectedAgents.forEach((agentKey, index) => {
    const agent = AGENTS[agentKey];
    console.log(`[${index + 1}/${totalAgents}] Setting up ${agent.name}...`);
    if (agentKey !== 'claude') {
      setupAgent(agentKey, claudeCommands);
    }
  });

  console.log('');
  console.log('Agent configuration complete!');
  console.log('');
  console.log('Installed for:');
  selectedAgents.forEach(key => {
    const agent = AGENTS[key];
    console.log(`  * ${agent.name}`);
  });

  // Configure external services with defaults (unless skipped)
  if (!skipExternal) {
    console.log('');
    console.log('Configuring default services...');
    console.log('');

    const tokens = {
      CODE_REVIEW_TOOL: 'github-code-quality',
      CODE_QUALITY_TOOL: 'eslint',
      PKG_MANAGER: PKG_MANAGER
    };

    writeEnvTokens(tokens);

    console.log('  * Code Review: GitHub Code Quality (FREE)');
    console.log('  * Code Quality: ESLint (built-in)');
    console.log('');
    console.log('Configuration saved to .env.local');
  } else {
    console.log('');
    console.log('Skipping external services configuration...');
  }

  // Final summary
  console.log('');
  console.log('==============================================');
  console.log('  Forge v1.1.2 Quick Setup Complete!');
  console.log('==============================================');
  console.log('');
  console.log('Next steps:');
  console.log('  1. Start with: /status');
  console.log('  2. Read the guide: docs/WORKFLOW.md');
  console.log('');
  console.log('Happy shipping!');
  console.log('');
}

// Interactive setup with flag support
async function interactiveSetupWithFlags(flags) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let setupCompleted = false;

  // Handle Ctrl+C gracefully
  rl.on('close', () => {
    if (!setupCompleted) {
      console.log('\n\nSetup cancelled.');
      process.exit(0);
    }
  });

  // Handle input errors
  rl.on('error', (err) => {
    console.error('Input error:', err.message);
    process.exit(1);
  });

  const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

  showBanner('Agent Configuration');

  // Check prerequisites first
  checkPrerequisites();
  console.log('');

  // =============================================
  // PROJECT DETECTION
  // =============================================
  const projectStatus = detectProjectStatus();

  if (projectStatus.type !== 'fresh') {
    console.log('==============================================');
    console.log('  Existing Installation Detected');
    console.log('==============================================');
    console.log('');

    if (projectStatus.type === 'upgrade') {
      console.log('Found existing Forge installation:');
    } else {
      console.log('Found partial installation:');
    }

    if (projectStatus.hasAgentsMd) console.log('  - AGENTS.md');
    if (projectStatus.hasClaudeCommands) console.log('  - .claude/commands/');
    if (projectStatus.hasEnvLocal) console.log('  - .env.local');
    if (projectStatus.hasDocsWorkflow) console.log('  - docs/WORKFLOW.md');
    console.log('');
  }

  // Track which files to skip based on user choices
  const skipFiles = {
    agentsMd: false,
    claudeCommands: false
  };

  // Ask about overwriting AGENTS.md if it exists
  if (projectStatus.hasAgentsMd) {
    const overwriteAgents = await question('Found existing AGENTS.md. Overwrite? (y/n) [n]: ');
    if (overwriteAgents.toLowerCase() !== 'y' && overwriteAgents.toLowerCase() !== 'yes') {
      skipFiles.agentsMd = true;
      console.log('  Keeping existing AGENTS.md');
    } else {
      console.log('  Will overwrite AGENTS.md');
    }
  }

  // Ask about overwriting .claude/commands/ if it exists
  if (projectStatus.hasClaudeCommands) {
    const overwriteCommands = await question('Found existing .claude/commands/. Overwrite? (y/n) [n]: ');
    if (overwriteCommands.toLowerCase() !== 'y' && overwriteCommands.toLowerCase() !== 'yes') {
      skipFiles.claudeCommands = true;
      console.log('  Keeping existing .claude/commands/');
    } else {
      console.log('  Will overwrite .claude/commands/');
    }
  }

  if (projectStatus.type !== 'fresh') {
    console.log('');
  }

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

  let selectedAgents = [];

  // Loop until valid input is provided
  while (selectedAgents.length === 0) {
    const answer = await question('Your selection: ');

    // Handle empty input - reprompt
    if (!answer || !answer.trim()) {
      console.log('  Please enter at least one agent number or "all".');
      continue;
    }

    if (answer.toLowerCase() === 'all') {
      selectedAgents = agentKeys;
    } else {
      const nums = answer.split(/[\s,]+/).map(n => parseInt(n.trim())).filter(n => !isNaN(n));

      // Validate numbers are in range
      const validNums = nums.filter(n => n >= 1 && n <= agentKeys.length);
      const invalidNums = nums.filter(n => n < 1 || n > agentKeys.length);

      if (invalidNums.length > 0) {
        console.log(`  Warning: Invalid numbers ignored: ${invalidNums.join(', ')} (valid: 1-${agentKeys.length})`);
      }

      // Deduplicate selected agents using Set
      selectedAgents = [...new Set(validNums.map(n => agentKeys[n - 1]))].filter(Boolean);
    }

    if (selectedAgents.length === 0) {
      console.log('  No valid agents selected. Please try again.');
    }
  }

  console.log('');
  console.log('Installing Forge workflow...');

  // Copy AGENTS.md unless skipped
  if (skipFiles.agentsMd) {
    console.log('  Skipped: AGENTS.md (keeping existing)');
  } else {
    const agentsSrc = path.join(packageDir, 'AGENTS.md');
    if (copyFile(agentsSrc, 'AGENTS.md')) {
      console.log('  Created: AGENTS.md (universal standard)');
    }
  }

  // Load Claude commands if needed
  let claudeCommands = {};
  if (selectedAgents.includes('claude') || selectedAgents.some(a => AGENTS[a].needsConversion || AGENTS[a].copyCommands)) {
    // First ensure Claude is set up
    if (selectedAgents.includes('claude')) {
      setupAgent('claude', null, skipFiles);
    }
    // Then load the commands (from existing or newly created)
    COMMANDS.forEach(cmd => {
      const cmdPath = path.join(projectRoot, `.claude/commands/${cmd}.md`);
      const content = readFile(cmdPath);
      if (content) {
        claudeCommands[`${cmd}.md`] = content;
      }
    });
  }

  // Setup each selected agent with progress indication
  const totalAgents = selectedAgents.length;
  selectedAgents.forEach((agentKey, index) => {
    const agent = AGENTS[agentKey];
    console.log(`\n[${index + 1}/${totalAgents}] Setting up ${agent.name}...`);
    if (agentKey !== 'claude') { // Claude already done above
      setupAgent(agentKey, claudeCommands, skipFiles);
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
  if (!flags.skipExternal) {
    console.log('');
    console.log('STEP 2: External Services (Optional)');
    console.log('=====================================');

    await configureExternalServices(rl, question, selectedAgents, projectStatus);
  } else {
    console.log('');
    console.log('Skipping external services configuration...');
  }

  setupCompleted = true;
  rl.close();

  // =============================================
  // Final Summary
  // =============================================
  console.log('');
  console.log('==============================================');
  console.log('  Forge v1.1.2 Setup Complete!');
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

// Main
async function main() {
  const command = args[0];
  const flags = parseFlags();

  // Show help
  if (flags.help) {
    showHelp();
    return;
  }

  if (command === 'setup') {
    // Determine agents to install
    let selectedAgents = [];

    if (flags.all) {
      selectedAgents = Object.keys(AGENTS);
    } else if (flags.agents) {
      selectedAgents = validateAgents(flags.agents);
      if (selectedAgents.length === 0) {
        console.log('No valid agents specified.');
        console.log('Available agents:', Object.keys(AGENTS).join(', '));
        process.exit(1);
      }
    }

    // Quick mode
    if (flags.quick) {
      // If no agents specified in quick mode, use all
      if (selectedAgents.length === 0) {
        selectedAgents = Object.keys(AGENTS);
      }
      await quickSetup(selectedAgents, flags.skipExternal);
      return;
    }

    // Agents specified via flag (non-quick mode)
    if (selectedAgents.length > 0) {
      showBanner('Installing for specified agents...');
      console.log('');

      // Check prerequisites
      checkPrerequisites();
      console.log('');

      // Copy AGENTS.md
      const agentsSrc = path.join(packageDir, 'AGENTS.md');
      if (copyFile(agentsSrc, 'AGENTS.md')) {
        console.log('  Created: AGENTS.md (universal standard)');
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

      // Setup agents
      selectedAgents.forEach(agentKey => {
        if (agentKey !== 'claude') {
          setupAgent(agentKey, claudeCommands);
        }
      });

      console.log('');
      console.log('Agent configuration complete!');

      // External services (unless skipped)
      if (!flags.skipExternal) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        let setupCompleted = false;
        rl.on('close', () => {
          if (!setupCompleted) {
            console.log('\n\nSetup cancelled.');
            process.exit(0);
          }
        });
        const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));
        await configureExternalServices(rl, question, selectedAgents);
        setupCompleted = true;
        rl.close();
      } else {
        console.log('');
        console.log('Skipping external services configuration...');
      }

      console.log('');
      console.log('Done! Get started with: /status');
      return;
    }

    // Interactive setup (skip-external still applies)
    await interactiveSetupWithFlags(flags);
  } else {
    // Default: minimal install (postinstall behavior)
    minimalInstall();
  }
}

main().catch(console.error);
