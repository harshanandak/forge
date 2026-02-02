#!/usr/bin/env node

/**
 * Forge - Universal AI Agent Workflow
 * https://github.com/harshanandak/forge
 *
 * Version is automatically read from package.json
 *
 * Usage:
 *   npm install forge-workflow  -> Minimal install (AGENTS.md + docs)
 *   npx forge setup             -> Interactive agent configuration
 *   npx forge setup --all       -> Install for all agents
 *   npx forge setup --agents claude,cursor,windsurf
 *
 * CLI Flags:
 *   --path, -p <dir>     Target project directory (creates if needed)
 *   --quick, -q          Use all defaults, minimal prompts
 *   --skip-external      Skip external services configuration
 *   --agents <list>      Specify agents (--agents claude cursor OR --agents=claude,cursor)
 *   --all                Install for all available agents
 *   --help, -h           Show help message
 *
 * Examples:
 *   npx forge setup --quick                    # All defaults, no prompts
 *   npx forge setup -p ./my-project            # Setup in specific directory
 *   npx forge setup --agents claude cursor     # Just these agents
 *   npx forge setup --skip-external            # No service prompts
 *   npx forge setup --agents claude --quick    # Quick + specific agent
 *
 * Also works with bun:
 *   bun add forge-workflow
 *   bunx forge setup --quick
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execSync } = require('node:child_process');

// Get version from package.json (single source of truth)
const packageDir = path.dirname(__dirname);
const packageJson = require(path.join(packageDir, 'package.json'));
const VERSION = packageJson.version;

// Get the project root
const projectRoot = process.env.INIT_CWD || process.cwd();
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

const COMMANDS = ['status', 'research', 'plan', 'dev', 'check', 'ship', 'review', 'merge', 'verify', 'rollback'];

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
    // Command execution failure is expected when tool is not installed or fails
    // Returning null allows caller to handle missing tools gracefully
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
    console.log(`  ✓ ${ghVersion.split(String.raw`\n`)[0]}`);
    // Check if authenticated
    const authStatus = safeExec('gh auth status');
    if (!authStatus) {
      warnings.push('GitHub CLI not authenticated. Run: gh auth login');
    }
  } else {
    errors.push('gh (GitHub CLI) - Install from https://cli.github.com');
  }

  // Check Node.js version
  const nodeVersion = Number.parseInt(process.version.slice(1).split('.')[0]);
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
    } else if (process.env.DEBUG) {
      console.warn(`  ⚠ Source file not found: ${src}`);
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
    } catch (error_) {
      // Symlink creation may fail due to permissions or OS limitations (e.g., Windows without admin)
      // Fall back to copying the file instead to ensure operation succeeds
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
  } catch (err) {
    // File read failure is acceptable - file may not exist or have permission issues
    // Return empty string to allow caller to proceed with defaults
  }
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
    if (value?.trim()) {
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
    outputLines.push(
      '# External Service API Keys for Forge Workflow',
      '# Get your keys from:',
      '#   Parallel AI: https://platform.parallel.ai',
      '#   Greptile: https://app.greptile.com/api',
      '#   SonarCloud: https://sonarcloud.io/account/security',
      ''
    );
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
  } catch (err) {
    // Gitignore update is optional - failure doesn't prevent .env.local creation
    // User can manually add .env.local to .gitignore if needed
  }

  return { added, preserved };
}

// Detect existing project installation status
// Smart merge for AGENTS.md - preserves USER sections, updates FORGE sections
function smartMergeAgentsMd(existingContent, newContent) {
  // Check if existing content has markers
  const hasUserMarkers = existingContent.includes('<!-- USER:START') && existingContent.includes('<!-- USER:END');
  const hasForgeMarkers = existingContent.includes('<!-- FORGE:START') && existingContent.includes('<!-- FORGE:END');

  if (!hasUserMarkers || !hasForgeMarkers) {
    // Old format without markers - return new content (let user decide via overwrite prompt)
    return null;
  }

  // Extract USER section from existing content
  const userStartMatch = existingContent.match(/<!-- USER:START.*?-->([\s\S]*?)<!-- USER:END -->/);
  const userSection = userStartMatch ? userStartMatch[0] : '';

  // Extract FORGE section from new content
  const forgeStartMatch = newContent.match(/(<!-- FORGE:START.*?-->[\s\S]*?<!-- FORGE:END -->)/);
  const forgeSection = forgeStartMatch ? forgeStartMatch[0] : '';

  // Build merged content
  const setupInstructions = newContent.includes('<!-- FORGE:SETUP-INSTRUCTIONS')
    ? newContent.match(/(<!-- FORGE:SETUP-INSTRUCTIONS[\s\S]*?-->)/)?.[0] || ''
    : '';

  let merged = '# AGENTS.md\n\n';

  // Add setup instructions if this is first-time setup
  if (setupInstructions && !existingContent.includes('FORGE:SETUP-INSTRUCTIONS')) {
    merged += setupInstructions + '\n\n';
  }

  // Add preserved USER section
  merged += userSection + '\n\n';

  // Add updated FORGE section
  merged += forgeSection + '\n\n';

  // Add footer
  merged += `---\n\n## 💡 Improving This Workflow\n\nEvery time you give the same instruction twice, add it to this file:\n1. User-specific rules → Add to USER:START section above\n2. Forge workflow improvements → Suggest to forge maintainers\n\n**Keep this file updated as you learn about the project.**\n\n---\n\nSee \`docs/WORKFLOW.md\` for complete workflow guide.\nSee \`docs/TOOLCHAIN.md\` for comprehensive tool reference.\n`;

  return merged;
}

// Helper function for yes/no prompts with validation
async function askYesNo(question, prompt, defaultNo = true) {
  const defaultText = defaultNo ? '[n]' : '[y]';
  while (true) {
    const answer = await question(`${prompt} (y/n) ${defaultText}: `);
    const normalized = answer.trim().toLowerCase();

    // Handle empty input (use default)
    if (normalized === '') return !defaultNo;

    // Accept yes variations
    if (normalized === 'y' || normalized === 'yes') return true;

    // Accept no variations
    if (normalized === 'n' || normalized === 'no') return false;

    // Invalid input - re-prompt
    console.log('  Please enter y or n');
  }
}

function detectProjectStatus() {
  const status = {
    type: 'fresh', // 'fresh', 'upgrade', or 'partial'
    hasAgentsMd: fs.existsSync(path.join(projectRoot, 'AGENTS.md')),
    hasClaudeMd: fs.existsSync(path.join(projectRoot, 'CLAUDE.md')),
    hasClaudeCommands: fs.existsSync(path.join(projectRoot, '.claude/commands')),
    hasEnvLocal: fs.existsSync(path.join(projectRoot, '.env.local')),
    hasDocsWorkflow: fs.existsSync(path.join(projectRoot, 'docs/WORKFLOW.md')),
    existingEnvVars: {},
    agentsMdSize: 0,
    claudeMdSize: 0,
    agentsMdLines: 0,
    claudeMdLines: 0
  };

  // Get file sizes and line counts for context warnings
  if (status.hasAgentsMd) {
    const agentsPath = path.join(projectRoot, 'AGENTS.md');
    const stats = fs.statSync(agentsPath);
    const content = fs.readFileSync(agentsPath, 'utf8');
    status.agentsMdSize = stats.size;
    status.agentsMdLines = content.split('\n').length;
  }

  if (status.hasClaudeMd) {
    const claudePath = path.join(projectRoot, 'CLAUDE.md');
    const stats = fs.statSync(claudePath);
    const content = fs.readFileSync(claudePath, 'utf8');
    status.claudeMdSize = stats.size;
    status.claudeMdLines = content.split('\n').length;
  }

  // Determine installation type
  if (status.hasAgentsMd && status.hasClaudeCommands && status.hasDocsWorkflow) {
    status.type = 'upgrade'; // Full forge installation exists
  } else if (status.hasClaudeCommands || status.hasEnvLocal) {
    status.type = 'partial'; // Agent-specific files exist (not just base files from postinstall)
  }
  // else: 'fresh' - new installation (or just postinstall baseline with AGENTS.md)

  // Parse existing env vars if .env.local exists
  if (status.hasEnvLocal) {
    status.existingEnvVars = parseEnvFile();
  }

  return status;
}

// Detect project type from package.json
function detectProjectType() {
  const detection = {
    hasPackageJson: false,
    framework: null,
    frameworkConfidence: 0,
    language: 'javascript',
    languageConfidence: 100,
    projectType: null,
    buildTool: null,
    testFramework: null,
    features: {
      typescript: false,
      monorepo: false,
      docker: false,
      cicd: false
    }
  };

  const pkg = readPackageJson();
  if (!pkg) return detection;

  detection.hasPackageJson = true;

  // Detect TypeScript
  if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
    detection.features.typescript = true;
    detection.language = 'typescript';
  }

  // Detect monorepo
  if (pkg.workspaces || fs.existsSync(path.join(projectRoot, 'pnpm-workspace.yaml')) || fs.existsSync(path.join(projectRoot, 'lerna.json'))) {
    detection.features.monorepo = true;
  }

  // Detect Docker
  if (fs.existsSync(path.join(projectRoot, 'Dockerfile')) || fs.existsSync(path.join(projectRoot, 'docker-compose.yml'))) {
    detection.features.docker = true;
  }

  // Detect CI/CD
  if (fs.existsSync(path.join(projectRoot, '.github/workflows')) ||
      fs.existsSync(path.join(projectRoot, '.gitlab-ci.yml')) ||
      fs.existsSync(path.join(projectRoot, 'azure-pipelines.yml')) ||
      fs.existsSync(path.join(projectRoot, '.circleci/config.yml'))) {
    detection.features.cicd = true;
  }

  // Framework detection with confidence scoring
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  // Helper function for test framework detection
  const detectTestFramework = (deps) => {
    if (deps.jest) return 'jest';
    if (deps.vitest) return 'vitest';
    if (deps.mocha) return 'mocha';
    if (deps['@playwright/test']) return 'playwright';
    if (deps.cypress) return 'cypress';
    if (deps.karma) return 'karma';
    return null;
  };

  // Next.js (highest priority for React projects)
  if (deps.next) {
    detection.framework = 'Next.js';
    detection.frameworkConfidence = 100;
    detection.projectType = 'fullstack';
    detection.buildTool = 'next';
    detection.testFramework = detectTestFramework(deps);
    return detection;
  }

  // NestJS (backend framework)
  if (deps['@nestjs/core'] || deps['@nestjs/common']) {
    detection.framework = 'NestJS';
    detection.frameworkConfidence = 100;
    detection.projectType = 'backend';
    detection.buildTool = 'nest';
    detection.testFramework = 'jest';
    return detection;
  }

  // Angular
  if (deps['@angular/core'] || deps['@angular/cli']) {
    detection.framework = 'Angular';
    detection.frameworkConfidence = 100;
    detection.projectType = 'frontend';
    detection.buildTool = 'ng';
    detection.testFramework = 'karma';
    return detection;
  }

  // Vue.js
  if (deps.vue) {
    if (deps.nuxt) {
      detection.framework = 'Nuxt';
      detection.frameworkConfidence = 100;
      detection.projectType = 'fullstack';
      detection.buildTool = 'nuxt';
    } else {
      detection.framework = 'Vue.js';
      detection.frameworkConfidence = deps['@vue/cli'] ? 100 : 90;
      detection.projectType = 'frontend';
      // Extract nested ternary to intermediate variable
      const hasVite = deps.vite;
      const hasWebpack = deps.webpack;
      detection.buildTool = hasVite ? 'vite' : (hasWebpack ? 'webpack' : 'vue-cli');
    }
    detection.testFramework = detectTestFramework(deps);
    return detection;
  }

  // React (without Next.js)
  if (deps.react) {
    detection.framework = 'React';
    detection.frameworkConfidence = 95;
    detection.projectType = 'frontend';
    // Extract nested ternary to intermediate variable
    const hasVite = deps.vite;
    const hasReactScripts = deps['react-scripts'];
    detection.buildTool = hasVite ? 'vite' : (hasReactScripts ? 'create-react-app' : 'webpack');
    detection.testFramework = detectTestFramework(deps);
    return detection;
  }

  // Express (backend)
  if (deps.express) {
    detection.framework = 'Express';
    detection.frameworkConfidence = 90;
    detection.projectType = 'backend';
    detection.buildTool = detection.features.typescript ? 'tsc' : 'node';
    detection.testFramework = detectTestFramework(deps);
    return detection;
  }

  // Fastify (backend)
  if (deps.fastify) {
    detection.framework = 'Fastify';
    detection.frameworkConfidence = 95;
    detection.projectType = 'backend';
    detection.buildTool = detection.features.typescript ? 'tsc' : 'node';
    detection.testFramework = detectTestFramework(deps);
    return detection;
  }

  // Svelte
  if (deps.svelte) {
    if (deps['@sveltejs/kit']) {
      detection.framework = 'SvelteKit';
      detection.frameworkConfidence = 100;
      detection.projectType = 'fullstack';
      detection.buildTool = 'vite';
    } else {
      detection.framework = 'Svelte';
      detection.frameworkConfidence = 95;
      detection.projectType = 'frontend';
      detection.buildTool = 'vite';
    }
    detection.testFramework = detectTestFramework(deps);
    return detection;
  }

  // Remix
  if (deps['@remix-run/react']) {
    detection.framework = 'Remix';
    detection.frameworkConfidence = 100;
    detection.projectType = 'fullstack';
    detection.buildTool = 'remix';
    detection.testFramework = detectTestFramework(deps);
    return detection;
  }

  // Astro
  if (deps.astro) {
    detection.framework = 'Astro';
    detection.frameworkConfidence = 100;
    detection.projectType = 'frontend';
    detection.buildTool = 'astro';
    detection.testFramework = detectTestFramework(deps);
    return detection;
  }

  // Generic Node.js project
  if (pkg.main || pkg.scripts?.start) {
    detection.framework = 'Node.js';
    detection.frameworkConfidence = 70;
    detection.projectType = 'backend';
    detection.buildTool = detection.features.typescript ? 'tsc' : 'node';
    detection.testFramework = detectTestFramework(deps);
    return detection;
  }

  // Fallback: generic JavaScript/TypeScript project
  detection.framework = detection.features.typescript ? 'TypeScript' : 'JavaScript';
  detection.frameworkConfidence = 60;
  detection.projectType = 'library';
  // Extract nested ternary to intermediate variable
  const hasVite = deps.vite;
  const hasWebpack = deps.webpack;
  detection.buildTool = hasVite ? 'vite' : (hasWebpack ? 'webpack' : 'npm');
  detection.testFramework = detectTestFramework(deps);

  return detection;
}

// Display project detection results
function displayProjectType(detection) {
  if (!detection.hasPackageJson) return;

  console.log('');
  console.log(chalk.cyan('  📦 Project Detection:'));

  if (detection.framework) {
    const confidence = detection.frameworkConfidence >= 90 ? '✓' : '~';
    console.log(`     Framework: ${chalk.bold(detection.framework)} ${confidence}`);
  }

  if (detection.projectType) {
    console.log(`     Type: ${detection.projectType}`);
  }

  if (detection.buildTool) {
    console.log(`     Build: ${detection.buildTool}`);
  }

  if (detection.testFramework) {
    console.log(`     Tests: ${detection.testFramework}`);
  }

  const features = [];
  if (detection.features.typescript) features.push('TypeScript');
  if (detection.features.monorepo) features.push('Monorepo');
  if (detection.features.docker) features.push('Docker');
  if (detection.features.cicd) features.push('CI/CD');

  if (features.length > 0) {
    console.log(`     Features: ${features.join(', ')}`);
  }
}

// Generate framework-specific tips
function generateFrameworkTips(detection) {
  const tips = {
    'Next.js': [
      '- Use `npm run dev` for development with hot reload',
      '- Server components are default in App Router',
      '- API routes live in `app/api/` or `pages/api/`'
    ],
    'React': [
      '- Prefer functional components with hooks',
      '- Use `React.memo()` for expensive components',
      '- State management: Context API or external library'
    ],
    'Vue.js': [
      '- Use Composition API for better TypeScript support',
      '- `<script setup>` is the recommended syntax',
      '- Pinia is the official state management'
    ],
    'Angular': [
      '- Use standalone components (Angular 14+)',
      '- Signals for reactive state (Angular 16+)',
      '- RxJS for async operations'
    ],
    'NestJS': [
      '- Dependency injection via decorators',
      '- Use `@nestjs/config` for environment variables',
      '- Guards for authentication, Interceptors for logging'
    ],
    'Express': [
      '- Use middleware for cross-cutting concerns',
      '- Error handling with next(err)',
      '- Consider Helmet.js for security headers'
    ],
    'Fastify': [
      '- Schema-based validation with JSON Schema',
      '- Plugins for reusable functionality',
      '- Async/await by default'
    ],
    'SvelteKit': [
      '- File-based routing in `src/routes/`',
      '- Server-side rendering by default',
      '- Form actions for mutations'
    ],
    'Nuxt': [
      '- Auto-imports for components and composables',
      '- `useAsyncData()` for data fetching',
      '- Nitro server engine for deployment'
    ],
    'Remix': [
      '- Loaders for data fetching',
      '- Actions for mutations',
      '- Progressive enhancement by default'
    ],
    'Astro': [
      '- Zero JS by default',
      '- Use client:* directives for interactivity',
      '- Content collections for type-safe content'
    ]
  };

  return tips[detection.framework] || [];
}

// Update AGENTS.md with project type metadata
function updateAgentsMdWithProjectType(detection) {
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) return;

  let content = fs.readFileSync(agentsPath, 'utf-8');

  // Find the project description line (line 3)
  const lines = content.split('\n');
  let insertIndex = -1;

  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    if (lines[i].startsWith('This is a ')) {
      insertIndex = i + 1;
      break;
    }
  }

  if (insertIndex === -1) return;

  // Build metadata section
  const metadata = [];
  metadata.push('');
  if (detection.framework) {
    metadata.push(`**Framework**: ${detection.framework}`);
  }
  if (detection.language && detection.language !== 'javascript') {
    metadata.push(`**Language**: ${detection.language}`);
  }
  if (detection.projectType) {
    metadata.push(`**Type**: ${detection.projectType}`);
  }
  if (detection.buildTool) {
    metadata.push(`**Build**: \`${detection.buildTool}\``);
  }
  if (detection.testFramework) {
    metadata.push(`**Tests**: ${detection.testFramework}`);
  }

  // Add framework-specific tips
  const tips = generateFrameworkTips(detection);
  if (tips.length > 0) {
    metadata.push('', '**Framework conventions**:', ...tips);
  }

  // Insert metadata
  lines.splice(insertIndex, 0, ...metadata);

  fs.writeFileSync(agentsPath, lines.join('\n'), 'utf-8');
}

// Smart file selection with context warnings
async function handleInstructionFiles(rl, question, selectedAgents, projectStatus) {
  const hasClaude = selectedAgents.some(a => a.key === 'claude');
  const hasOtherAgents = selectedAgents.some(a => a.key !== 'claude');

  // Calculate estimated tokens (rough: ~4 chars per token)
  const estimateTokens = (bytes) => Math.ceil(bytes / 4);

  const result = {
    createAgentsMd: false,
    createClaudeMd: false,
    skipAgentsMd: false,
    skipClaudeMd: false
  };

  // Scenario 1: Both files exist (potential context bloat)
  if (projectStatus.hasAgentsMd && projectStatus.hasClaudeMd) {
    const totalLines = projectStatus.agentsMdLines + projectStatus.claudeMdLines;
    const totalTokens = estimateTokens(projectStatus.agentsMdSize + projectStatus.claudeMdSize);

    console.log('');
    console.log('⚠️  WARNING: Multiple Instruction Files Detected');
    console.log('='.repeat(60));
    console.log(`  AGENTS.md:  ${projectStatus.agentsMdLines} lines (~${estimateTokens(projectStatus.agentsMdSize)} tokens)`);
    console.log(`  CLAUDE.md:  ${projectStatus.claudeMdLines} lines (~${estimateTokens(projectStatus.claudeMdSize)} tokens)`);
    console.log(`  Total:      ${totalLines} lines (~${totalTokens} tokens)`);
    console.log('');
    console.log('  ⚠️  Claude Code reads BOTH files on every request');
    console.log('  ⚠️  This increases context usage and costs');
    console.log('');
    console.log('  Options:');
    console.log('  1) Keep CLAUDE.md only (recommended for Claude Code only)');
    console.log('  2) Keep AGENTS.md only (recommended for multi-agent users)');
    console.log('  3) Keep both (higher context usage)');
    console.log('');

    while (true) {
      const choice = await question('Your choice (1/2/3) [2]: ');
      const normalized = choice.trim() || '2';

      if (normalized === '1') {
        result.skipAgentsMd = true;
        result.createClaudeMd = false; // Keep existing
        console.log('  ✓ Will keep CLAUDE.md, remove AGENTS.md');
        break;
      } else if (normalized === '2') {
        result.skipClaudeMd = true;
        result.createAgentsMd = false; // Keep existing
        console.log('  ✓ Will keep AGENTS.md, remove CLAUDE.md');
        break;
      } else if (normalized === '3') {
        result.createAgentsMd = false; // Keep existing
        result.createClaudeMd = false; // Keep existing
        console.log('  ✓ Will keep both files (context: ~' + totalTokens + ' tokens)');
        break;
      } else {
        console.log('  Please enter 1, 2, or 3');
      }
    }

    return result;
  }

  // Scenario 2: Only CLAUDE.md exists
  if (projectStatus.hasClaudeMd && !projectStatus.hasAgentsMd) {
    if (hasOtherAgents) {
      console.log('');
      console.log('📋 Found existing CLAUDE.md (' + projectStatus.claudeMdLines + ' lines)');
      console.log('   You selected multiple agents. Recommendation:');
      console.log('   → Migrate to AGENTS.md (works with all agents)');
      console.log('');

      const migrate = await askYesNo(question, 'Migrate CLAUDE.md to AGENTS.md?', false);
      if (migrate) {
        result.createAgentsMd = true;
        result.skipClaudeMd = true;
        console.log('  ✓ Will migrate content to AGENTS.md');
      } else {
        result.createAgentsMd = true;
        result.createClaudeMd = false; // Keep existing
        console.log('  ✓ Will keep CLAUDE.md and create AGENTS.md');
      }
    } else {
      // Claude Code only - keep CLAUDE.md
      result.createClaudeMd = false; // Keep existing
      console.log('  ✓ Keeping existing CLAUDE.md');
    }

    return result;
  }

  // Scenario 3: Only AGENTS.md exists
  if (projectStatus.hasAgentsMd && !projectStatus.hasClaudeMd) {
    if (hasClaude && !hasOtherAgents) {
      console.log('');
      console.log('📋 Found existing AGENTS.md (' + projectStatus.agentsMdLines + ' lines)');
      console.log('   You selected Claude Code only. Options:');
      console.log('   1) Keep AGENTS.md (works fine)');
      console.log('   2) Rename to CLAUDE.md (Claude-specific naming)');
      console.log('');

      const rename = await askYesNo(question, 'Rename to CLAUDE.md?', true);
      if (rename) {
        result.createClaudeMd = true;
        result.skipAgentsMd = true;
        console.log('  ✓ Will rename to CLAUDE.md');
      } else {
        result.createAgentsMd = false; // Keep existing
        console.log('  ✓ Keeping AGENTS.md');
      }
    } else {
      // Multi-agent or other agents - keep AGENTS.md
      result.createAgentsMd = false; // Keep existing
      console.log('  ✓ Keeping existing AGENTS.md');
    }

    return result;
  }

  // Scenario 4: Neither file exists (fresh install)
  if (hasClaude && !hasOtherAgents) {
    // Claude Code only → create CLAUDE.md
    result.createClaudeMd = true;
    console.log('  ✓ Will create CLAUDE.md (Claude Code specific)');
  } else if (!hasClaude && hasOtherAgents) {
    // Other agents only → create AGENTS.md
    result.createAgentsMd = true;
    console.log('  ✓ Will create AGENTS.md (universal)');
  } else {
    // Multiple agents including Claude → create AGENTS.md + reference CLAUDE.md
    result.createAgentsMd = true;
    result.createClaudeMd = true; // Will be minimal reference
    console.log('  ✓ Will create AGENTS.md (main) + CLAUDE.md (reference)');
  }

  return result;
}

// Create minimal CLAUDE.md that references AGENTS.md
function createClaudeReference(destPath) {
  const content = `# Claude Code Instructions

See [AGENTS.md](AGENTS.md) for all project instructions.

This file exists to avoid Claude Code reading both CLAUDE.md and AGENTS.md (which doubles context usage). Keep project-level instructions in AGENTS.md.

---

<!-- Add Claude Code-specific instructions below (if needed) -->
<!-- Examples: MCP server setup, custom commands, Claude-only workflows -->

💡 **Keep this minimal** - Main instructions are in AGENTS.md
`;

  fs.writeFileSync(destPath, content, 'utf8');
  return true;
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

    const reconfigure = await askYesNo(question, 'Reconfigure external services?', true);
    if (!reconfigure) {
      console.log('');
      console.log('Keeping existing configuration.');
      return;
    }
    console.log('');
  }

  console.log('Would you like to configure external services?');
  console.log('(You can also add them later to .env.local)');
  console.log('');

  const configure = await askYesNo(question, 'Configure external services?', false);

  if (!configure) {
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
    case '1': {
      tokens['CODE_REVIEW_TOOL'] = 'github-code-quality';
      console.log('  ✓ Using GitHub Code Quality (FREE)');
      break;
    }
    case '2': {
      tokens['CODE_REVIEW_TOOL'] = 'coderabbit';
      console.log('  ✓ Using CodeRabbit - Install the GitHub App to activate');
      console.log('     https://coderabbit.ai');
      break;
    }
    case '3': {
      const greptileKey = await question('  Enter Greptile API key: ');
      if (greptileKey?.trim()) {
        tokens['CODE_REVIEW_TOOL'] = 'greptile';
        tokens['GREPTILE_API_KEY'] = greptileKey.trim();
        console.log('  ✓ Greptile configured');
      } else {
        tokens['CODE_REVIEW_TOOL'] = 'none';
        console.log('  Skipped - No API key provided');
      }
      break;
    }
    default: {
      tokens['CODE_REVIEW_TOOL'] = 'none';
      console.log('  Skipped code review integration');
    }
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
    case '1': {
      tokens['CODE_QUALITY_TOOL'] = 'eslint';
      console.log('  ✓ Using ESLint (built-in)');
      break;
    }
    case '2': {
      const sonarToken = await question('  Enter SonarCloud token: ');
      const sonarOrg = await question('  Enter SonarCloud organization: ');
      const sonarProject = await question('  Enter SonarCloud project key: ');
      if (sonarToken?.trim()) {
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
    }
    case '3': {
      console.log('');
      console.log('  SonarQube Self-Hosted Setup:');
      console.log('  docker run -d --name sonarqube -p 9000:9000 sonarqube:community');
      console.log('  Access: http://localhost:9000 (admin/admin)');
      console.log('');
      const sqUrl = await question('  Enter SonarQube URL [http://localhost:9000]: ') || 'http://localhost:9000';
      const sqToken = await question('  Enter SonarQube token (optional): ');
      tokens['CODE_QUALITY_TOOL'] = 'sonarqube';
      tokens['SONARQUBE_URL'] = sqUrl;
      if (sqToken?.trim()) {
        tokens['SONARQUBE_TOKEN'] = sqToken.trim();
      }
      console.log('  ✓ SonarQube self-hosted configured');
      break;
    }
    default: {
      tokens['CODE_QUALITY_TOOL'] = 'none';
      console.log('  Skipped code quality integration');
    }
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
    if (parallelKey?.trim()) {
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
  console.log(`  v${VERSION}`);
  console.log('');
  if (subtitle) {
    console.log(`  ${subtitle}`);
  }
}

// Setup core documentation and directories
function setupCoreDocs() {
  // Create core directories
  ensureDir('docs/planning');
  ensureDir('docs/research');

  // Copy WORKFLOW.md
  const workflowSrc = path.join(packageDir, 'docs/WORKFLOW.md');
  if (copyFile(workflowSrc, 'docs/WORKFLOW.md')) {
    console.log('  Created: docs/WORKFLOW.md');
  }

  // Copy research TEMPLATE.md
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
}

// Minimal installation (postinstall)
function minimalInstall() {
  // Check if this looks like a project (has package.json)
  const hasPackageJson = fs.existsSync(path.join(projectRoot, 'package.json'));

  if (!hasPackageJson) {
    console.log('');
    console.log('  ✅ Forge installed successfully!');
    console.log('');
    console.log('  To set up in a project:');
    console.log('    cd your-project');
    console.log('    npx forge setup');
    console.log('');
    console.log('  Or specify a project directory:');
    console.log('    npx forge setup --path ./my-project');
    console.log('');
    return;
  }

  showBanner();
  console.log('');

  // Setup core documentation
  setupCoreDocs();

  // Copy AGENTS.md (only if not exists - preserve user customizations in minimal install)
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (fs.existsSync(agentsPath)) {
    console.log('  Skipped: AGENTS.md (already exists)');
  } else {
    const agentsSrc = path.join(packageDir, 'AGENTS.md');
    if (copyFile(agentsSrc, 'AGENTS.md')) {
      console.log('  Created: AGENTS.md (universal standard)');

      // Detect project type and update AGENTS.md
      const detection = detectProjectType();
      if (detection.hasPackageJson) {
        updateAgentsMdWithProjectType(detection);
        displayProjectType(detection);
      }
    }
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
    if (fs.existsSync(aiderPath)) {
      console.log('  Skipped: .aider.conf.yml already exists');
    } else {
      writeFile('.aider.conf.yml', `# Aider configuration
# Read AGENTS.md for workflow instructions
read:
  - AGENTS.md
  - docs/WORKFLOW.md
`);
      console.log('  Created: .aider.conf.yml');
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
    if (fs.existsSync(mcpPath)) {
      console.log('  Skipped: .mcp.json already exists');
    } else {
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
    }
  }

  // Create config.yaml with Context7 MCP (Continue only)
  if (agentKey === 'continue') {
    const configPath = path.join(projectRoot, '.continue/config.yaml');
    if (fs.existsSync(configPath)) {
      console.log('  Skipped: config.yaml already exists');
    } else {
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

  // Show target directory
  console.log(`  Target directory: ${process.cwd()}`);
  console.log('  (Use --path <dir> to change target directory)');
  console.log('');

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
    const overwriteAgents = await askYesNo(question, 'Found existing AGENTS.md. Overwrite?', true);
    if (overwriteAgents) {
      console.log('  Will overwrite AGENTS.md');
    } else {
      skipFiles.agentsMd = true;
      console.log('  Keeping existing AGENTS.md');
    }
  }

  // Ask about overwriting .claude/commands/ if it exists
  if (projectStatus.hasClaudeCommands) {
    const overwriteCommands = await askYesNo(question, 'Found existing .claude/commands/. Overwrite?', true);
    if (overwriteCommands) {
      console.log('  Will overwrite .claude/commands/');
    } else {
      skipFiles.claudeCommands = true;
      console.log('  Keeping existing .claude/commands/');
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
      const nums = answer.split(/[\s,]+/).map(n => Number.parseInt(n.trim())).filter(n => !Number.isNaN(n));

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
    const agentsDest = path.join(projectRoot, 'AGENTS.md');

    // Try smart merge if file exists
    if (fs.existsSync(agentsDest)) {
      const existingContent = fs.readFileSync(agentsDest, 'utf8');
      const newContent = fs.readFileSync(agentsSrc, 'utf8');
      const merged = smartMergeAgentsMd(existingContent, newContent);

      if (merged) {
        fs.writeFileSync(agentsDest, merged, 'utf8');
        console.log('  Updated: AGENTS.md (preserved USER sections)');
      } else if (copyFile(agentsSrc, 'AGENTS.md')) {
        // No markers, do normal copy (user already approved overwrite)
        console.log('  Updated: AGENTS.md (universal standard)');
      }
    } else if (copyFile(agentsSrc, 'AGENTS.md')) {
      // New file
      console.log('  Created: AGENTS.md (universal standard)');

      // Detect project type and update AGENTS.md
      const detection = detectProjectType();
      if (detection.hasPackageJson) {
        updateAgentsMdWithProjectType(detection);
        displayProjectType(detection);
      }
    }
  }
  console.log('');

  // Setup core documentation
  setupCoreDocs();
  console.log('');

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
  console.log(`  Forge v${VERSION} Setup Complete!`);
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
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋  NEXT STEP - Complete AGENTS.md');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('Ask your AI agent:');
  console.log('  "Fill in the project description in AGENTS.md"');
  console.log('');
  console.log('The agent will:');
  console.log('  ✓ Add one-sentence project description');
  console.log('  ✓ Confirm package manager');
  console.log('  ✓ Verify build commands');
  console.log('');
  console.log('Takes ~30 seconds. Done!');
  console.log('');
  console.log('💡 As you work: Add project patterns to AGENTS.md');
  console.log('   USER:START section. Keep it minimal - budget is');
  console.log('   ~150-200 instructions max.');
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('Optional tools:');
  console.log(`  ${PKG_MANAGER} install -g @beads/bd && bd init`);
  console.log(`  ${PKG_MANAGER} install -g @fission-ai/openspec`);
  console.log('');
  console.log('Start with: /status');
  console.log('');
  console.log(`Package manager: ${PKG_MANAGER}`);
  console.log('');
}

// Parse CLI flags
function parseFlags() {
  const flags = {
    quick: false,
    skipExternal: false,
    agents: null,
    all: false,
    help: false,
    path: null
  };

  for (let i = 0; i < args.length; ) {
    const arg = args[i];

    if (arg === '--quick' || arg === '-q') {
      flags.quick = true;
      i++;
    } else if (arg === '--skip-external' || arg === '--skip-services') {
      flags.skipExternal = true;
      i++;
    } else if (arg === '--all') {
      flags.all = true;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true;
      i++;
    } else if (arg === '--path' || arg === '-p') {
      // --path <directory> or -p <directory>
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.path = args[i + 1];
        i += 2; // Skip current and next arg
      } else {
        i++;
      }
    } else if (arg.startsWith('--path=')) {
      // --path=/some/dir format
      flags.path = arg.replace('--path=', '');
      i++;
    } else if (arg === '--agents') {
      // --agents claude cursor format
      const agentList = [];
      let j = i + 1;
      while (j < args.length && !args[j].startsWith('-')) {
        agentList.push(args[j]);
        j++;
      }
      if (agentList.length > 0) {
        flags.agents = agentList.join(',');
      }
      i = j; // Skip all consumed arguments
    } else if (arg.startsWith('--agents=')) {
      // --agents=claude,cursor format
      flags.agents = arg.replace('--agents=', '');
      i++;
    } else {
      i++;
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
  console.log('  --path, -p <dir>     Target project directory (default: current directory)');
  console.log('                       Creates the directory if it doesn\'t exist');
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
  console.log('  npx forge setup -p ./my-project          # Setup in specific directory');
  console.log('  npx forge setup --path=/home/user/app    # Same, different syntax');
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
  console.log('');

  // Setup core documentation
  setupCoreDocs();
  console.log('');

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
  if (skipExternal) {
    console.log('');
    console.log('Skipping external services configuration...');
  } else {
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
  }

  // Final summary
  console.log('');
  console.log('==============================================');
  console.log(`  Forge v${VERSION} Quick Setup Complete!`);
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

  // Show target directory
  console.log(`  Target directory: ${process.cwd()}`);
  console.log('  (Use --path <dir> to change target directory)');
  console.log('');

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
    const overwriteAgents = await askYesNo(question, 'Found existing AGENTS.md. Overwrite?', true);
    if (overwriteAgents) {
      console.log('  Will overwrite AGENTS.md');
    } else {
      skipFiles.agentsMd = true;
      console.log('  Keeping existing AGENTS.md');
    }
  }

  // Ask about overwriting .claude/commands/ if it exists
  if (projectStatus.hasClaudeCommands) {
    const overwriteCommands = await askYesNo(question, 'Found existing .claude/commands/. Overwrite?', true);
    if (overwriteCommands) {
      console.log('  Will overwrite .claude/commands/');
    } else {
      skipFiles.claudeCommands = true;
      console.log('  Keeping existing .claude/commands/');
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
      const nums = answer.split(/[\s,]+/).map(n => Number.parseInt(n.trim())).filter(n => !Number.isNaN(n));

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
    const agentsDest = path.join(projectRoot, 'AGENTS.md');

    // Try smart merge if file exists
    if (fs.existsSync(agentsDest)) {
      const existingContent = fs.readFileSync(agentsDest, 'utf8');
      const newContent = fs.readFileSync(agentsSrc, 'utf8');
      const merged = smartMergeAgentsMd(existingContent, newContent);

      if (merged) {
        fs.writeFileSync(agentsDest, merged, 'utf8');
        console.log('  Updated: AGENTS.md (preserved USER sections)');
      } else if (copyFile(agentsSrc, 'AGENTS.md')) {
        // No markers, do normal copy (user already approved overwrite)
        console.log('  Updated: AGENTS.md (universal standard)');
      }
    } else if (copyFile(agentsSrc, 'AGENTS.md')) {
      // New file
      console.log('  Created: AGENTS.md (universal standard)');

      // Detect project type and update AGENTS.md
      const detection = detectProjectType();
      if (detection.hasPackageJson) {
        updateAgentsMdWithProjectType(detection);
        displayProjectType(detection);
      }
    }
  }
  console.log('');

  // Setup core documentation
  setupCoreDocs();
  console.log('');

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
  if (flags.skipExternal) {
    console.log('');
    console.log('Skipping external services configuration...');
  } else {
    console.log('');
    console.log('STEP 2: External Services (Optional)');
    console.log('=====================================');

    await configureExternalServices(rl, question, selectedAgents, projectStatus);
  }

  setupCompleted = true;
  rl.close();

  // =============================================
  // Final Summary
  // =============================================
  console.log('');
  console.log('==============================================');
  console.log(`  Forge v${VERSION} Setup Complete!`);
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
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('📋  NEXT STEP - Complete AGENTS.md');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('Ask your AI agent:');
  console.log('  "Fill in the project description in AGENTS.md"');
  console.log('');
  console.log('The agent will:');
  console.log('  ✓ Add one-sentence project description');
  console.log('  ✓ Confirm package manager');
  console.log('  ✓ Verify build commands');
  console.log('');
  console.log('Takes ~30 seconds. Done!');
  console.log('');
  console.log('💡 As you work: Add project patterns to AGENTS.md');
  console.log('   USER:START section. Keep it minimal - budget is');
  console.log('   ~150-200 instructions max.');
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('Optional tools:');
  console.log(`  ${PKG_MANAGER} install -g @beads/bd && bd init`);
  console.log(`  ${PKG_MANAGER} install -g @fission-ai/openspec`);
  console.log('');
  console.log('Start with: /status');
  console.log('');
  console.log(`Package manager: ${PKG_MANAGER}`);
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

  // Handle --path option: change to target directory
  if (flags.path) {
    const targetPath = path.resolve(flags.path);

    // Create directory if it doesn't exist
    if (!fs.existsSync(targetPath)) {
      try {
        fs.mkdirSync(targetPath, { recursive: true });
        console.log(`Created directory: ${targetPath}`);
      } catch (err) {
        console.error(`Error creating directory: ${err.message}`);
        process.exit(1);
      }
    }

    // Verify it's a directory
    if (!fs.statSync(targetPath).isDirectory()) {
      console.error(`Error: ${targetPath} is not a directory`);
      process.exit(1);
    }

    // Change to target directory
    try {
      process.chdir(targetPath);
      console.log(`Working directory: ${targetPath}`);
      console.log('');
    } catch (err) {
      console.error(`Error changing to directory: ${err.message}`);
      process.exit(1);
    }
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
      console.log('');

      // Setup core documentation
      setupCoreDocs();
      console.log('');

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
      if (flags.skipExternal) {
        console.log('');
        console.log('Skipping external services configuration...');
      } else {
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
      }

      console.log('');
      console.log('Done! Get started with: /status');
      return;
    }

    // Interactive setup (skip-external still applies)
    await interactiveSetupWithFlags(flags);
  } else if (command === 'rollback') {
    // Execute rollback menu
    await showRollbackMenu();
  } else {
    // Default: minimal install (postinstall behavior)
    minimalInstall();
  }
}

// ============================================================================
// ROLLBACK SYSTEM - TDD Validated
// ============================================================================
// Security: All inputs validated before use in git commands
// See test/rollback-validation.test.js for validation test coverage

// Validate rollback inputs (security-critical)
function validateRollbackInput(method, target) {
  const validMethods = ['commit', 'pr', 'partial', 'branch'];
  if (!validMethods.includes(method)) {
    return { valid: false, error: 'Invalid method' };
  }

  // Validate commit hash (git allows 4-40 char abbreviations)
  if (method === 'commit' || method === 'pr') {
    if (target !== 'HEAD' && !/^[0-9a-f]{4,40}$/i.test(target)) {
      return { valid: false, error: 'Invalid commit hash format' };
    }
  }

  // Validate file paths
  if (method === 'partial') {
    const files = target.split(',').map(f => f.trim());
    for (const file of files) {
      // Reject shell metacharacters
      if (/[;|&$`()<>\r\n]/.test(file)) {
        return { valid: false, error: `Invalid characters in path: ${file}` };
      }
      // Reject URL-encoded path traversal attempts
      if (/%2[eE]|%2[fF]|%5[cC]/.test(file)) {
        return { valid: false, error: `URL-encoded characters not allowed: ${file}` };
      }
      // Reject non-ASCII/unicode characters
      if (!/^[\x20-\x7E]+$/.test(file)) {
        return { valid: false, error: `Only ASCII characters allowed in path: ${file}` };
      }
      // Prevent path traversal
      const resolved = path.resolve(projectRoot, file);
      if (!resolved.startsWith(projectRoot)) {
        return { valid: false, error: `Path outside project: ${file}` };
      }
    }
  }

  // Validate branch range
  if (method === 'branch') {
    if (!target.includes('..')) {
      return { valid: false, error: 'Branch range must use format: start..end' };
    }
    const [start, end] = target.split('..');
    if (!/^[0-9a-f]{4,40}$/i.test(start) || !/^[0-9a-f]{4,40}$/i.test(end)) {
      return { valid: false, error: 'Invalid commit hashes in range' };
    }
  }

  return { valid: true };
}

// Extract USER sections before rollback
function extractUserSections(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const content = fs.readFileSync(filePath, 'utf-8');
  const sections = {};

  // Extract USER sections
  const userRegex = /<!-- USER:START -->([\s\S]*?)<!-- USER:END -->/g;
  let match;
  let index = 0;

  while ((match = userRegex.exec(content)) !== null) {
    sections[`user_${index}`] = match[1];
    index++;
  }

  // Extract custom commands
  const customCommandsDir = path.join(path.dirname(filePath), '.claude', 'commands', 'custom');
  if (fs.existsSync(customCommandsDir)) {
    sections.customCommands = fs.readdirSync(customCommandsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => ({
        name: f,
        content: fs.readFileSync(path.join(customCommandsDir, f), 'utf-8')
      }));
  }

  return sections;
}

// Restore USER sections after rollback
function preserveUserSections(filePath, savedSections) {
  if (!fs.existsSync(filePath) || Object.keys(savedSections).length === 0) {
    return;
  }

  let content = fs.readFileSync(filePath, 'utf-8');

  // Restore USER sections
  let index = 0;
  content = content.replaceAll(
    /<!-- USER:START -->[\s\S]*?<!-- USER:END -->/g,
    () => {
      const section = savedSections[`user_${index}`];
      index++;
      return section ? `<!-- USER:START -->${section}<!-- USER:END -->` : '';
    }
  );

  fs.writeFileSync(filePath, content, 'utf-8');

  // Restore custom commands
  if (savedSections.customCommands) {
    const customCommandsDir = path.join(path.dirname(filePath), '.claude', 'commands', 'custom');
    if (!fs.existsSync(customCommandsDir)) {
      fs.mkdirSync(customCommandsDir, { recursive: true });
    }

    savedSections.customCommands.forEach(cmd => {
      fs.writeFileSync(
        path.join(customCommandsDir, cmd.name),
        cmd.content,
        'utf-8'
      );
    });
  }
}

// Perform rollback operation
async function performRollback(method, target, dryRun = false) {
  console.log('');
  console.log(chalk.cyan(`  🔄 Rollback: ${method}`));
  console.log(`     Target: ${target}`);
  if (dryRun) {
    console.log(chalk.yellow('     Mode: DRY RUN (preview only)'));
  }
  console.log('');

  // Validate inputs BEFORE any git operations
  const validation = validateRollbackInput(method, target);
  if (!validation.valid) {
    console.log(chalk.red(`  ❌ ${validation.error}`));
    return false;
  }

  // Check for clean working directory
  try {
    const { execSync } = require('node:child_process');
    const status = execSync('git status --porcelain', { encoding: 'utf-8' });
    if (status.trim() !== '') {
      console.log(chalk.red('  ❌ Working directory has uncommitted changes'));
      console.log('     Commit or stash changes before rollback');
      return false;
    }
  } catch (err) {
    console.log(chalk.red('  ❌ Git error:'), err.message);
    return false;
  }

  // Extract USER sections before rollback
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const savedSections = extractUserSections(agentsPath);

  if (!dryRun) {
    console.log('  📦 Backing up user content...');
  }

  try {
    const { execSync } = require('node:child_process');

    if (method === 'commit') {
      if (dryRun) {
        console.log(`     Would revert: ${target}`);
        const files = execSync(`git diff-tree --no-commit-id --name-only -r ${target}`, { encoding: 'utf-8' });
        console.log('     Affected files:');
        files.trim().split('\n').forEach(f => console.log(`       - ${f}`));
      } else {
        execSync(`git revert --no-edit ${target}`, { stdio: 'inherit' });
      }
    } else if (method === 'pr') {
      if (dryRun) {
        console.log(`     Would revert merge: ${target}`);
        const files = execSync(`git diff-tree --no-commit-id --name-only -r ${target}`, { encoding: 'utf-8' });
        console.log('     Affected files:');
        files.trim().split('\n').forEach(f => console.log(`       - ${f}`));
      } else {
        execSync(`git revert -m 1 --no-edit ${target}`, { stdio: 'inherit' });

        // Update Beads issue if linked
        const commitMsg = execSync(`git log -1 --format=%B ${target}`, { encoding: 'utf-8' });
        const issueMatch = commitMsg.match(/#(\d+)/);
        if (issueMatch) {
          try {
            execSync(`bd update ${issueMatch[1]} --status reverted --comment "PR reverted"`, { stdio: 'inherit' });
            console.log(`     Updated Beads issue #${issueMatch[1]} to 'reverted'`);
          } catch {
            // Beads not installed - silently continue
          }
        }
      }
    } else if (method === 'partial') {
      const files = target.split(',').map(f => f.trim());
      if (dryRun) {
        console.log('     Would restore files:');
        files.forEach(f => console.log(`       - ${f}`));
      } else {
        files.forEach(f => {
          execSync(`git checkout HEAD~1 -- "${f}"`, { stdio: 'inherit' });
        });
        execSync(`git commit -m "chore: rollback ${files.join(', ')}"`, { stdio: 'inherit' });
      }
    } else if (method === 'branch') {
      const [startCommit, endCommit] = target.split('..');
      if (dryRun) {
        console.log(`     Would revert range: ${startCommit}..${endCommit}`);
        const commits = execSync(`git log --oneline ${startCommit}..${endCommit}`, { encoding: 'utf-8' });
        console.log('     Commits to revert:');
        commits.trim().split('\n').forEach(c => console.log(`       ${c}`));
      } else {
        execSync(`git revert --no-edit ${startCommit}..${endCommit}`, { stdio: 'inherit' });
      }
    }

    if (!dryRun) {
      console.log('  📦 Restoring user content...');
      preserveUserSections(agentsPath, savedSections);

      // Amend commit to include restored USER sections
      if (fs.existsSync(agentsPath)) {
        execSync('git add AGENTS.md', { stdio: 'inherit' });
        execSync('git commit --amend --no-edit', { stdio: 'inherit' });
      }

      console.log('');
      console.log(chalk.green('  ✅ Rollback complete'));
      console.log('     User content preserved');
    }

    return true;
  } catch (err) {
    console.log('');
    console.log(chalk.red('  ❌ Rollback failed:'), err.message);
    console.log('     Try manual rollback with: git revert <commit>');
    return false;
  }
}

// Interactive rollback menu
async function showRollbackMenu() {
  console.log('');
  console.log(chalk.cyan.bold('  🔄 Forge Rollback'));
  console.log('');
  console.log('  Choose rollback method:');
  console.log('');
  console.log('  1. Rollback last commit');
  console.log('  2. Rollback specific commit');
  console.log('  3. Rollback merged PR');
  console.log('  4. Rollback specific files only');
  console.log('  5. Rollback entire branch');
  console.log('  6. Preview rollback (dry run)');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const choice = await new Promise(resolve => {
    rl.question('  Enter choice (1-6): ', resolve);
  });

  let method, target, dryRun = false;

  switch (choice.trim()) {
    case '1': {
      method = 'commit';
      target = 'HEAD';
      break;
    }
    case '2': {
      target = await new Promise(resolve => {
        rl.question('  Enter commit hash: ', resolve);
      });
      method = 'commit';
      break;
    }
    case '3': {
      target = await new Promise(resolve => {
        rl.question('  Enter merge commit hash: ', resolve);
      });
      method = 'pr';
      break;
    }
    case '4': {
      target = await new Promise(resolve => {
        rl.question('  Enter file paths (comma-separated): ', resolve);
      });
      method = 'partial';
      break;
    }
    case '5': {
      const start = await new Promise(resolve => {
        rl.question('  Enter start commit: ', resolve);
      });
      const end = await new Promise(resolve => {
        rl.question('  Enter end commit: ', resolve);
      });
      target = `${start.trim()}..${end.trim()}`;
      method = 'branch';
      break;
    }
    case '6': {
      dryRun = true;
      const dryMethod = await new Promise(resolve => {
        rl.question('  Preview method (commit/pr/partial/branch): ', resolve);
      });
      method = dryMethod.trim();
      target = await new Promise(resolve => {
        rl.question('  Enter target (commit/files/range): ', resolve);
      });
      break;
    }
    default: {
      console.log(chalk.red('  Invalid choice'));
      rl.close();
      return;
    }
  }

  rl.close();

  await performRollback(method, target, dryRun);
}

main().catch(console.error);
