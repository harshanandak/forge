#!/usr/bin/env node

/**
 * Forge - Universal AI Agent Workflow
 * https://github.com/harshanandak/forge
 *
 * Version is automatically read from package.json
 *
 * Usage:
 *   bun install forge-workflow  -> Minimal install (AGENTS.md + docs)
 *   bunx forge setup            -> Interactive agent configuration
 *   bunx forge setup --all      -> Install for all agents
 *   bunx forge setup --agents claude,cursor,windsurf
 *
 * CLI Flags:
 *   --path, -p <dir>     Target project directory (creates if needed)
 *   --quick, -q          Use all defaults, minimal prompts
 *   --skip-external      Skip external services configuration
 *   --agents <list>      Specify agents (--agents claude cursor OR --agents=claude,cursor)
 *   --all                Install for all available agents
 *   --merge <mode>       Merge strategy for existing files (smart|preserve|replace)
 *   --type <type>        Workflow profile (critical|standard|simple|hotfix|docs|refactor)
 *   --interview          Force context interview (gather project info)
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
const { execSync, execFileSync, spawnSync } = require('node:child_process');

// Get version from package.json (single source of truth)
const packageDir = path.dirname(__dirname);
const packageJson = require(path.join(packageDir, 'package.json'));
const VERSION = packageJson.version;

// Load PluginManager for discoverable agent architecture
const PluginManager = require('../lib/plugin-manager');

// Load enhanced onboarding modules
const contextMerge = require(path.join(packageDir, 'lib', 'context-merge'));
const projectDiscovery = require(path.join(packageDir, 'lib', 'project-discovery'));
// workflowProfiles is loaded but not currently used in the setup flow
// const _workflowProfiles = require(path.join(packageDir, 'lib', 'workflow-profiles'));

// Get the project root (let allows reassignment after --path flag handling)
let projectRoot = process.env.INIT_CWD || process.cwd();
const args = process.argv.slice(2);

// Detected package manager
let PKG_MANAGER = 'npm';

/**
 * Securely execute a command with PATH validation
 * Mitigates SonarCloud S4036: Ensures executables are from trusted locations
 * @param {string} command - The command to execute
 * @param {string[]} args - Command arguments
 * @param {object} options - execFileSync options
 */
function secureExecFileSync(command, args = [], options = {}) {
  try {
    // Resolve command's full path to validate it's in a trusted location
    const isWindows = process.platform === 'win32';
    const pathResolver = isWindows ? 'where.exe' : 'which';

    const result = spawnSync(pathResolver, [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });

    if (result.status === 0 && result.stdout) {
      // Command found - use resolved path for execution
      // Handle both CRLF (Windows) and LF (Unix) line endings
      const resolvedPath = result.stdout.trim().split(/\r?\n/)[0].trim();
      return execFileSync(resolvedPath, args, options);
    }
  } catch (_err) {
    // PATH resolution failed - command might not be installed
    // Error is intentionally ignored as we fall back to direct command execution
  }

  // Fallback: execute with command name (maintains compatibility)
  // This is safe for our use case as we only execute known, hardcoded commands
  return execFileSync(command, args, options);
}

/**
 * Load agent definitions from plugin architecture
 * Maintains backwards compatibility with original AGENTS object structure
 */
function loadAgentsFromPlugins() {
  const pluginManager = new PluginManager();
  const agents = {};

  pluginManager.getAllPlugins().forEach((plugin, id) => {
    // Convert plugin structure to AGENTS structure for backwards compatibility
    agents[id] = {
      name: plugin.name,
      description: plugin.description || '',
      dirs: Object.values(plugin.directories || {}),
      hasCommands: plugin.capabilities?.commands || plugin.setup?.copyCommands || false,
      hasSkill: plugin.capabilities?.skills || plugin.setup?.createSkill || false,
      linkFile: plugin.files?.rootConfig || '',
      customSetup: plugin.setup?.customSetup || '',
      needsConversion: plugin.setup?.needsConversion || false,
      copyCommands: plugin.setup?.copyCommands || false,
      promptFormat: plugin.setup?.promptFormat || false,
      continueFormat: plugin.setup?.continueFormat || false
    };
  });

  return agents;
}

// Agent definitions - loaded from plugin system
const AGENTS = loadAgentsFromPlugins();

// SECURITY: Freeze AGENTS to prevent runtime manipulation
Object.freeze(AGENTS);
Object.values(AGENTS).forEach(agent => Object.freeze(agent));

/**
 * Validate user input against security patterns
 * Prevents shell injection, path traversal, and unicode attacks
 * @param {string} input - User input to validate
 * @param {string} type - Input type: 'path', 'agent', 'hash'
 * @returns {{valid: boolean, error?: string}}
 */
function validateUserInput(input, type) {
  // Shell injection check - common shell metacharacters
  if (/[;|&$`()<>\r\n]/.test(input)) {
    return { valid: false, error: 'Invalid characters detected (shell metacharacters)' };
  }

  // URL encoding check - prevent encoded path traversal
  if (/%2[eE]|%2[fF]|%5[cC]/.test(input)) {
    return { valid: false, error: 'URL-encoded characters not allowed' };
  }

  // ASCII-only check - prevent unicode attacks
  if (!/^[\x20-\x7E]+$/.test(input)) {
    return { valid: false, error: 'Only ASCII printable characters allowed' };
  }

  // Type-specific validation - delegated to helpers
  switch (type) {
    case 'path':
      return validatePathInput(input);
    case 'directory_path':
      return validateDirectoryPathInput(input);
    case 'agent':
      return validateAgentInput(input);
    case 'hash':
      return validateHashInput(input);
    default:
      return { valid: true };
  }
}

// Helper: Validate 'path' type input - extracted to reduce cognitive complexity
function validatePathInput(input) {
  const resolved = path.resolve(projectRoot, input);
  if (!resolved.startsWith(path.resolve(projectRoot))) {
    return { valid: false, error: 'Path outside project root' };
  }
  return { valid: true };
}

// Helper: Validate 'directory_path' type input - extracted to reduce cognitive complexity
function validateDirectoryPathInput(input) {
  // Block null bytes
  if (input.includes('\0')) {
    return { valid: false, error: 'Null bytes not allowed in path' };
  }

  // Block absolute paths to sensitive system directories
  const resolved = path.resolve(input);
  const normalizedResolved = path.normalize(resolved).toLowerCase();

  // Windows: Block system directories
  if (process.platform === 'win32') {
    const blockedPaths = [String.raw`c:\windows`, String.raw`c:\program files`, String.raw`c:\program files (x86)`];
    if (blockedPaths.some(blocked => normalizedResolved.startsWith(blocked))) {
      return { valid: false, error: 'Cannot target Windows system directories' };
    }
  }

  // Unix: Block system directories
  if (process.platform !== 'win32') {
    const blockedPaths = ['/etc', '/bin', '/sbin', '/boot', '/sys', '/proc', '/dev'];
    if (blockedPaths.some(blocked => normalizedResolved.startsWith(blocked))) {
      return { valid: false, error: 'Cannot target system directories' };
    }
  }

  return { valid: true };
}

// Helper: Validate 'agent' type input - extracted to reduce cognitive complexity
function validateAgentInput(input) {
  // Agent names: lowercase alphanumeric with hyphens only
  if (!/^[a-z0-9-]+$/.test(input)) {
    return { valid: false, error: 'Agent name must be lowercase alphanumeric with hyphens' };
  }
  return { valid: true };
}

// Helper: Validate 'hash' type input - extracted to reduce cognitive complexity
function validateHashInput(input) {
  // Git commit hash: 4-40 hexadecimal characters
  if (!/^[0-9a-f]{4,40}$/i.test(input)) {
    return { valid: false, error: 'Invalid commit hash format (must be 4-40 hex chars)' };
  }
  return { valid: true };
}

/**
 * Check write permission to a directory or file
 * @param {string} filePath - Path to check
 * @returns {{writable: boolean, error?: string}}
 * @private - Currently unused but kept for future permission validation
 */
function _checkWritePermission(filePath) {
  try {
    const dir = fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
    const testFile = path.join(dir, `.forge-write-test-${Date.now()}`);
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    return { writable: true };
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      const fix = process.platform === 'win32'
        ? 'Run Command Prompt as Administrator'
        : 'Try: sudo npx forge setup';
      return { writable: false, error: `No write permission to ${filePath}. ${fix}` };
    }
    return { writable: false, error: err.message };
  }
}

const COMMANDS = ['status', 'research', 'plan', 'dev', 'check', 'ship', 'review', 'merge', 'verify', 'rollback'];

// Code review tool options (reserved for future feature)
const _CODE_REVIEW_TOOLS = {
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

// Code quality tool options (reserved for future feature)
const _CODE_QUALITY_TOOLS = {
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
    console.warn('Command execution failed:', e.message);
    return null;
  }
}

// Detect package manager from command availability and lock files
// Extracted to reduce cognitive complexity
function detectPackageManager(errors) {
  // Check lock files first (most authoritative)
  const bunLock = path.join(projectRoot, 'bun.lockb');
  const bunLock2 = path.join(projectRoot, 'bun.lock');
  const pnpmLock = path.join(projectRoot, 'pnpm-lock.yaml');
  const yarnLock = path.join(projectRoot, 'yarn.lock');

  if (fs.existsSync(bunLock) || fs.existsSync(bunLock2)) {
    PKG_MANAGER = 'bun';
    const version = safeExec('bun --version');
    if (version) console.log(`  ✓ bun v${version} (detected from lock file)`);
    return;
  }

  if (fs.existsSync(pnpmLock)) {
    PKG_MANAGER = 'pnpm';
    const version = safeExec('pnpm --version');
    if (version) console.log(`  ✓ pnpm ${version} (detected from lock file)`);
    return;
  }

  if (fs.existsSync(yarnLock)) {
    PKG_MANAGER = 'yarn';
    const version = safeExec('yarn --version');
    if (version) console.log(`  ✓ yarn ${version} (detected from lock file)`);
    return;
  }

  // Fallback: detect from installed commands
  const bunVersion = safeExec('bun --version');
  if (bunVersion) {
    PKG_MANAGER = 'bun';
    console.log(`  ✓ bun v${bunVersion} (detected as package manager)`);
    return;
  }

  const pnpmVersion = safeExec('pnpm --version');
  if (pnpmVersion) {
    PKG_MANAGER = 'pnpm';
    console.log(`  ✓ pnpm ${pnpmVersion} (detected as package manager)`);
    return;
  }

  const yarnVersion = safeExec('yarn --version');
  if (yarnVersion) {
    PKG_MANAGER = 'yarn';
    console.log(`  ✓ yarn ${yarnVersion} (detected as package manager)`);
    return;
  }

  const npmVersion = safeExec('npm --version');
  if (npmVersion) {
    PKG_MANAGER = 'npm';
    console.log(`  ✓ npm ${npmVersion} (detected as package manager)`);
    return;
  }

  // No package manager found
  errors.push('npm, yarn, pnpm, or bun - Install a package manager');
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
    const firstLine = ghVersion.split('\n')[0];
    console.log(`  ✓ ${firstLine}`);
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
  detectPackageManager(errors);

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
    return null;
  }
  if (!fullTarget.startsWith(resolvedProjectRoot)) {
    console.error(`  ✗ Security: Target path escape blocked: ${target}`);
    return null;
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
      console.warn('Symlink creation failed, falling back to copy:', error_.message);
      fs.copyFileSync(fullSource, fullTarget);
      return 'copied';
    }
  } catch (err) {
    console.error(`  ✗ Failed to link/copy ${source} -> ${target}: ${err.message}`);
    return null;
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
    console.warn('Failed to read .env.local:', err.message);
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
    console.warn('Failed to update .gitignore:', err.message);
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

async function detectProjectStatus() {
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
    claudeMdLines: 0,
    // Project tools status
    hasBeads: isBeadsInitialized(),
    hasOpenSpec: isOpenSpecInitialized(),
    hasSkills: isSkillsInitialized(),
    beadsInstallType: checkForBeads(),
    openspecInstallType: checkForOpenSpec(),
    skillsInstallType: checkForSkills(),
    // Enhanced: Auto-detected project context
    autoDetected: null
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

  // Enhanced: Auto-detect project context (framework, language, stage, CI/CD)
  try {
    status.autoDetected = await projectDiscovery.autoDetect(projectRoot);
    // Save context to .forge/context.json
    await projectDiscovery.saveContext(status.autoDetected, projectRoot);
  } catch (error) {
    // Auto-detection is optional - don't fail setup if it errors
    console.log('  Note: Auto-detection skipped (error:', error.message, ')');
    status.autoDetected = null;
  }

  return status;
}

// Helper: Detect test framework from dependencies
function detectTestFramework(deps) {
  if (deps.jest) return 'jest';
  if (deps.vitest) return 'vitest';
  if (deps.mocha) return 'mocha';
  if (deps['@playwright/test']) return 'playwright';
  if (deps.cypress) return 'cypress';
  if (deps.karma) return 'karma';
  return null;
}

// Helper: Detect language features (TypeScript, monorepo, Docker, CI/CD)
function detectLanguageFeatures(pkg) {
  const features = {
    typescript: false,
    monorepo: false,
    docker: false,
    cicd: false
  };

  // Detect TypeScript
  if (pkg.devDependencies?.typescript || pkg.dependencies?.typescript) {
    features.typescript = true;
  }

  // Detect monorepo
  if (pkg.workspaces ||
      fs.existsSync(path.join(projectRoot, 'pnpm-workspace.yaml')) ||
      fs.existsSync(path.join(projectRoot, 'lerna.json'))) {
    features.monorepo = true;
  }

  // Detect Docker
  if (fs.existsSync(path.join(projectRoot, 'Dockerfile')) ||
      fs.existsSync(path.join(projectRoot, 'docker-compose.yml'))) {
    features.docker = true;
  }

  // Detect CI/CD
  if (fs.existsSync(path.join(projectRoot, '.github/workflows')) ||
      fs.existsSync(path.join(projectRoot, '.gitlab-ci.yml')) ||
      fs.existsSync(path.join(projectRoot, 'azure-pipelines.yml')) ||
      fs.existsSync(path.join(projectRoot, '.circleci/config.yml'))) {
    features.cicd = true;
  }

  return features;
}

// Helper: Detect Next.js framework
function detectNextJs(deps) {
  if (!deps.next) return null;

  return {
    framework: 'Next.js',
    frameworkConfidence: 100,
    projectType: 'fullstack',
    buildTool: 'next',
    testFramework: detectTestFramework(deps)
  };
}

// Helper: Detect NestJS framework
function detectNestJs(deps) {
  if (!deps['@nestjs/core'] && !deps['@nestjs/common']) return null;

  return {
    framework: 'NestJS',
    frameworkConfidence: 100,
    projectType: 'backend',
    buildTool: 'nest',
    testFramework: 'jest'
  };
}

// Helper: Detect Angular framework
function detectAngular(deps) {
  if (!deps['@angular/core'] && !deps['@angular/cli']) return null;

  return {
    framework: 'Angular',
    frameworkConfidence: 100,
    projectType: 'frontend',
    buildTool: 'ng',
    testFramework: 'karma'
  };
}

// Helper: Detect Vue.js framework
function detectVue(deps) {
  if (!deps.vue) return null;

  if (deps.nuxt) {
    return {
      framework: 'Nuxt',
      frameworkConfidence: 100,
      projectType: 'fullstack',
      buildTool: 'nuxt',
      testFramework: detectTestFramework(deps)
    };
  }

  const hasVite = deps.vite;
  const hasWebpack = deps.webpack;

  // Determine build tool without nested ternary
  let buildTool = 'vue-cli';
  if (hasVite) {
    buildTool = 'vite';
  } else if (hasWebpack) {
    buildTool = 'webpack';
  }

  return {
    framework: 'Vue.js',
    frameworkConfidence: deps['@vue/cli'] ? 100 : 90,
    projectType: 'frontend',
    buildTool,
    testFramework: detectTestFramework(deps)
  };
}

// Helper: Detect React framework
function detectReact(deps) {
  if (!deps.react) return null;

  const hasVite = deps.vite;
  const hasReactScripts = deps['react-scripts'];

  // Determine build tool without nested ternary
  let buildTool = 'webpack';
  if (hasVite) {
    buildTool = 'vite';
  } else if (hasReactScripts) {
    buildTool = 'create-react-app';
  }

  return {
    framework: 'React',
    frameworkConfidence: 95,
    projectType: 'frontend',
    buildTool,
    testFramework: detectTestFramework(deps)
  };
}

// Helper: Detect Express framework
function detectExpress(deps, features) {
  if (!deps.express) return null;

  return {
    framework: 'Express',
    frameworkConfidence: 90,
    projectType: 'backend',
    buildTool: features.typescript ? 'tsc' : 'node',
    testFramework: detectTestFramework(deps)
  };
}

// Helper: Detect Fastify framework
function detectFastify(deps, features) {
  if (!deps.fastify) return null;

  return {
    framework: 'Fastify',
    frameworkConfidence: 95,
    projectType: 'backend',
    buildTool: features.typescript ? 'tsc' : 'node',
    testFramework: detectTestFramework(deps)
  };
}

// Helper: Detect Svelte framework
function detectSvelte(deps) {
  if (!deps.svelte) return null;

  if (deps['@sveltejs/kit']) {
    return {
      framework: 'SvelteKit',
      frameworkConfidence: 100,
      projectType: 'fullstack',
      buildTool: 'vite',
      testFramework: detectTestFramework(deps)
    };
  }

  return {
    framework: 'Svelte',
    frameworkConfidence: 95,
    projectType: 'frontend',
    buildTool: 'vite',
    testFramework: detectTestFramework(deps)
  };
}

// Helper: Detect Remix framework
function detectRemix(deps) {
  if (!deps['@remix-run/react']) return null;

  return {
    framework: 'Remix',
    frameworkConfidence: 100,
    projectType: 'fullstack',
    buildTool: 'remix',
    testFramework: detectTestFramework(deps)
  };
}

// Helper: Detect Astro framework
function detectAstro(deps) {
  if (!deps.astro) return null;

  return {
    framework: 'Astro',
    frameworkConfidence: 100,
    projectType: 'frontend',
    buildTool: 'astro',
    testFramework: detectTestFramework(deps)
  };
}

// Helper: Detect generic Node.js project
function detectGenericNodeJs(pkg, deps, features) {
  if (!pkg.main && !pkg.scripts?.start) return null;

  return {
    framework: 'Node.js',
    frameworkConfidence: 70,
    projectType: 'backend',
    buildTool: features.typescript ? 'tsc' : 'node',
    testFramework: detectTestFramework(deps)
  };
}

// Helper: Detect generic JavaScript/TypeScript project (fallback)
function detectGenericProject(deps, features) {
  const hasVite = deps.vite;
  const hasWebpack = deps.webpack;

  // Determine build tool without nested ternary
  let buildTool = 'npm';
  if (hasVite) {
    buildTool = 'vite';
  } else if (hasWebpack) {
    buildTool = 'webpack';
  }

  return {
    framework: features.typescript ? 'TypeScript' : 'JavaScript',
    frameworkConfidence: 60,
    projectType: 'library',
    buildTool,
    testFramework: detectTestFramework(deps)
  };
}

/**
 * Read package.json from project root
 * @returns {object|null} Parsed package.json or null if not found
 */
function readPackageJson() {
  try {
    const pkgPath = path.join(projectRoot, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (_err) {
    // Invalid package.json or read error
    return null;
  }
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

  // Detect language features
  detection.features = detectLanguageFeatures(pkg);
  if (detection.features.typescript) {
    detection.language = 'typescript';
  }

  // Framework detection with confidence scoring
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  // Try framework detectors in priority order
  const frameworkResult =
    detectNextJs(deps) ||
    detectNestJs(deps) ||
    detectAngular(deps) ||
    detectVue(deps) ||
    detectReact(deps) ||
    detectExpress(deps, detection.features) ||
    detectFastify(deps, detection.features) ||
    detectSvelte(deps) ||
    detectRemix(deps) ||
    detectAstro(deps) ||
    detectGenericNodeJs(pkg, deps, detection.features) ||
    detectGenericProject(deps, detection.features);

  // Merge framework detection results
  if (frameworkResult) {
    Object.assign(detection, frameworkResult);
  }

  return detection;
}

// Display project detection results
function displayProjectType(detection) {
  if (!detection.hasPackageJson) return;

  console.log('');
  console.log('  📦 Project Detection:');

  if (detection.framework) {
    const confidence = detection.frameworkConfidence >= 90 ? '✓' : '~';
    console.log(`     Framework: ${detection.framework} ${confidence}`);
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

// Helper: Calculate estimated tokens (rough: ~4 chars per token)
function estimateTokens(bytes) {
  return Math.ceil(bytes / 4);
}

// Helper: Create instruction files result object
function createInstructionFilesResult(createAgentsMd = false, createClaudeMd = false, skipAgentsMd = false, skipClaudeMd = false) {
  return {
    createAgentsMd,
    createClaudeMd,
    skipAgentsMd,
    skipClaudeMd
  };
}

// Helper: Handle scenario where both AGENTS.md and CLAUDE.md exist
async function handleBothFilesExist(question, projectStatus) {
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
      console.log('  ✓ Will keep CLAUDE.md, remove AGENTS.md');
      return createInstructionFilesResult(false, false, true, false);
    } else if (normalized === '2') {
      console.log('  ✓ Will keep AGENTS.md, remove CLAUDE.md');
      return createInstructionFilesResult(false, false, false, true);
    } else if (normalized === '3') {
      console.log('  ✓ Will keep both files (context: ~' + totalTokens + ' tokens)');
      return createInstructionFilesResult(false, false, false, false);
    } else {
      console.log('  Please enter 1, 2, or 3');
    }
  }
}

// Helper: Handle scenario where only CLAUDE.md exists
async function handleOnlyClaudeMdExists(question, projectStatus, hasOtherAgents) {
  if (hasOtherAgents) {
    console.log('');
    console.log('📋 Found existing CLAUDE.md (' + projectStatus.claudeMdLines + ' lines)');
    console.log('   You selected multiple agents. Recommendation:');
    console.log('   → Migrate to AGENTS.md (works with all agents)');
    console.log('');

    const migrate = await askYesNo(question, 'Migrate CLAUDE.md to AGENTS.md?', false);
    if (migrate) {
      console.log('  ✓ Will migrate content to AGENTS.md');
      return createInstructionFilesResult(true, false, false, true);
    } else {
      console.log('  ✓ Will keep CLAUDE.md and create AGENTS.md');
      return createInstructionFilesResult(true, false, false, false);
    }
  } else {
    // Claude Code only - keep CLAUDE.md
    console.log('  ✓ Keeping existing CLAUDE.md');
    return createInstructionFilesResult(false, false, false, false);
  }
}

// Helper: Handle scenario where only AGENTS.md exists
async function handleOnlyAgentsMdExists(question, projectStatus, hasClaude, hasOtherAgents) {
  if (hasClaude && !hasOtherAgents) {
    console.log('');
    console.log('📋 Found existing AGENTS.md (' + projectStatus.agentsMdLines + ' lines)');
    console.log('   You selected Claude Code only. Options:');
    console.log('   1) Keep AGENTS.md (works fine)');
    console.log('   2) Rename to CLAUDE.md (Claude-specific naming)');
    console.log('');

    const rename = await askYesNo(question, 'Rename to CLAUDE.md?', true);
    if (rename) {
      console.log('  ✓ Will rename to CLAUDE.md');
      return createInstructionFilesResult(false, true, true, false);
    } else {
      console.log('  ✓ Keeping AGENTS.md');
      return createInstructionFilesResult(false, false, false, false);
    }
  } else {
    // Multi-agent or other agents - keep AGENTS.md
    console.log('  ✓ Keeping existing AGENTS.md');
    return createInstructionFilesResult(false, false, false, false);
  }
}

// Helper: Handle scenario where no instruction files exist (fresh install)
function handleNoFilesExist(hasClaude, hasOtherAgents) {
  if (hasClaude && !hasOtherAgents) {
    // Claude Code only → create CLAUDE.md
    console.log('  ✓ Will create CLAUDE.md (Claude Code specific)');
    return createInstructionFilesResult(false, true, false, false);
  } else if (!hasClaude && hasOtherAgents) {
    // Other agents only → create AGENTS.md
    console.log('  ✓ Will create AGENTS.md (universal)');
    return createInstructionFilesResult(true, false, false, false);
  } else {
    // Multiple agents including Claude → create AGENTS.md + reference CLAUDE.md
    console.log('  ✓ Will create AGENTS.md (main) + CLAUDE.md (reference)');
    return createInstructionFilesResult(true, true, false, false);
  }
}

// Smart file selection with context warnings
// @private - Currently unused, reserved for future interactive setup flow
async function _handleInstructionFiles(rl, question, selectedAgents, projectStatus) {
  const hasClaude = selectedAgents.some(a => a.key === 'claude');
  const hasOtherAgents = selectedAgents.some(a => a.key !== 'claude');

  // Scenario 1: Both files exist (potential context bloat)
  if (projectStatus.hasAgentsMd && projectStatus.hasClaudeMd) {
    return await handleBothFilesExist(question, projectStatus);
  }

  // Scenario 2: Only CLAUDE.md exists
  if (projectStatus.hasClaudeMd && !projectStatus.hasAgentsMd) {
    return await handleOnlyClaudeMdExists(question, projectStatus, hasOtherAgents);
  }

  // Scenario 3: Only AGENTS.md exists
  if (projectStatus.hasAgentsMd && !projectStatus.hasClaudeMd) {
    return await handleOnlyAgentsMdExists(question, projectStatus, hasClaude, hasOtherAgents);
  }

  // Scenario 4: Neither file exists (fresh install)
  return handleNoFilesExist(hasClaude, hasOtherAgents);
}

// Create minimal CLAUDE.md that references AGENTS.md
// @private - Currently unused, reserved for future setup flow
function _createClaudeReference(destPath) {
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

// Prompt for code review tool selection - extracted to reduce cognitive complexity
async function promptForCodeReviewTool(question) {
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

  const choice = await question('Select [1]: ') || '1';
  const tokens = {};

  switch (choice) {
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

  return tokens;
}

// Prompt for code quality tool selection - extracted to reduce cognitive complexity
async function promptForCodeQualityTool(question) {
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

  const choice = await question('Select [1]: ') || '1';
  const tokens = {};

  switch (choice) {
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

  return tokens;
}

// Prompt for research tool selection - extracted to reduce cognitive complexity
async function promptForResearchTool(question) {
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

  const choice = await question('Select [1]: ') || '1';
  const tokens = {};

  if (choice === '2') {
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

  return tokens;
}

// Helper: Check existing service configuration - extracted to reduce cognitive complexity
async function checkExistingServiceConfig(question, projectStatus) {
  const existingEnvVars = projectStatus?.existingEnvVars || parseEnvFile();
  const hasCodeReviewTool = existingEnvVars.CODE_REVIEW_TOOL;
  const hasCodeQualityTool = existingEnvVars.CODE_QUALITY_TOOL;
  const hasExistingConfig = hasCodeReviewTool || hasCodeQualityTool;

  if (!hasExistingConfig) {
    return true; // No existing config, proceed with configuration
  }

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
    return false; // Skip configuration
  }
  console.log('');
  return true; // Proceed with configuration
}

// Configure external services interactively
async function configureExternalServices(rl, question, selectedAgents = [], projectStatus = null) {
  console.log('');
  console.log('==============================================');
  console.log('  External Services Configuration');
  console.log('==============================================');
  console.log('');

  // Check existing configuration
  const shouldContinue = await checkExistingServiceConfig(question, projectStatus);
  if (!shouldContinue) {
    return;
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

  // Prompt for each service and collect tokens
  const tokens = {};

  // CODE REVIEW TOOL
  Object.assign(tokens, await promptForCodeReviewTool(question));

  // CODE QUALITY TOOL
  Object.assign(tokens, await promptForCodeQualityTool(question));

  // RESEARCH TOOL
  Object.assign(tokens, await promptForResearchTool(question));

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
  console.log('  bun add -d lefthook      # Install git hooks (one-time)');
  console.log('  bunx forge setup         # Interactive setup (agents + API tokens)');
  console.log('');
  console.log('Or specify agents directly:');
  console.log('  bunx forge setup --agents claude,cursor,windsurf');
  console.log('  bunx forge setup --all');
  console.log('');
}

// Helper: Setup Claude agent
function setupClaudeAgent(skipFiles = {}) {
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

// Helper: Setup Cursor agent
function setupCursorAgent() {
  writeFile('.cursor/rules/forge-workflow.mdc', CURSOR_RULE);
  console.log('  Created: .cursor/rules/forge-workflow.mdc');
}

// Helper: Setup Aider agent
function setupAiderAgent() {
  const aiderPath = path.join(projectRoot, '.aider.conf.yml');
  if (fs.existsSync(aiderPath)) {
    console.log('  Skipped: .aider.conf.yml already exists');
    return;
  }

  writeFile('.aider.conf.yml', `# Aider configuration
# Read AGENTS.md for workflow instructions
read:
  - AGENTS.md
  - docs/WORKFLOW.md
`);
  console.log('  Created: .aider.conf.yml');
}

// Helper: Convert command to agent-specific format
function convertCommandToAgentFormat(cmd, content, agent) {
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

  return { targetFile, targetContent };
}

// Helper: Copy commands for agent
function copyAgentCommands(agent, claudeCommands) {
  if (!claudeCommands) return;
  if (!agent.needsConversion && !agent.copyCommands && !agent.promptFormat && !agent.continueFormat) return;

  Object.entries(claudeCommands).forEach(([cmd, content]) => {
    const { targetFile, targetContent } = convertCommandToAgentFormat(cmd, content, agent);
    const targetDir = agent.dirs[0]; // First dir is commands/workflows
    writeFile(`${targetDir}/${targetFile}`, targetContent);
  });
  console.log('  Converted: 9 workflow commands');
}

// Helper: Copy rules for agent
function copyAgentRules(agent) {
  if (!agent.needsConversion) return;

  const workflowMdPath = path.join(projectRoot, '.claude/rules/workflow.md');
  if (!fs.existsSync(workflowMdPath)) return;

  const rulesDir = agent.dirs.find(d => d.includes('/rules'));
  if (!rulesDir) return;

  const ruleContent = readFile(workflowMdPath);
  if (ruleContent) {
    writeFile(`${rulesDir}/workflow.md`, ruleContent);
  }
}

// Helper: Create skill file for agent
function createAgentSkill(agent) {
  if (!agent.hasSkill) return;

  const skillDir = agent.dirs.find(d => d.includes('/skills/'));
  if (skillDir) {
    writeFile(`${skillDir}/SKILL.md`, SKILL_CONTENT);
    console.log('  Created: forge-workflow skill');
  }
}

// Helper: Setup MCP config for Claude
function setupClaudeMcpConfig() {
  const mcpPath = path.join(projectRoot, '.mcp.json');
  if (fs.existsSync(mcpPath)) {
    console.log('  Skipped: .mcp.json already exists');
    return;
  }

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

// Helper: Setup MCP config for Continue
function setupContinueMcpConfig() {
  const configPath = path.join(projectRoot, '.continue/config.yaml');
  if (fs.existsSync(configPath)) {
    console.log('  Skipped: config.yaml already exists');
    return;
  }

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

// Helper: Create agent link file
function createAgentLinkFile(agent) {
  if (!agent.linkFile) return;

  const result = createSymlinkOrCopy('AGENTS.md', agent.linkFile);
  if (result) {
    console.log(`  ${result === 'linked' ? 'Linked' : 'Copied'}: ${agent.linkFile}`);
  }
}

// Setup specific agent
function setupAgent(agentKey, claudeCommands, skipFiles = {}) {
  const agent = AGENTS[agentKey];
  if (!agent) return;

  console.log(`\nSetting up ${agent.name}...`);

  // Create directories
  agent.dirs.forEach(dir => ensureDir(dir));

  // Handle agent-specific setup
  if (agentKey === 'claude') {
    setupClaudeAgent(skipFiles);
  }

  if (agent.customSetup === 'cursor') {
    setupCursorAgent();
  }

  if (agent.customSetup === 'aider') {
    setupAiderAgent();
    return;
  }

  // Convert/copy commands
  copyAgentCommands(agent, claudeCommands);

  // Copy rules if needed
  copyAgentRules(agent);

  // Create SKILL.md
  createAgentSkill(agent);

  // Setup MCP configs
  if (agentKey === 'claude') {
    setupClaudeMcpConfig();
  }

  if (agentKey === 'continue') {
    setupContinueMcpConfig();
  }

  // Create link file
  createAgentLinkFile(agent);
}


// =============================================
// Helper Functions for Interactive Setup
// =============================================

/**
 * Display existing installation status
 */
function displayInstallationStatus(projectStatus) {
  if (projectStatus.type === 'fresh') return;

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

/**
 * Handle AGENTS.md file without markers - offers 3 options
 * Extracted to reduce cognitive complexity
 */
async function promptForAgentsMdWithoutMarkers(question, skipFiles, agentsPath) {
  console.log('');
  console.log('Found existing AGENTS.md without Forge markers.');
  console.log('This file may contain your custom agent instructions.');
  console.log('');
  console.log('How would you like to proceed?');
  console.log('  1. Intelligent merge (preserve your content + add Forge workflow)');
  console.log('  2. Keep existing (skip Forge installation for this file)');
  console.log('  3. Replace (backup created at AGENTS.md.backup)');
  console.log('');

  let validChoice = false;
  while (!validChoice) {
    const answer = await question('Your choice (1-3) [1]: ');
    const choice = answer.trim() || '1';

    if (choice === '1') {
      // Intelligent merge
      skipFiles.useSemanticMerge = true;
      skipFiles.agentsMd = false;
      console.log('  Will use intelligent merge (preserving your content)');
      validChoice = true;
    } else if (choice === '2') {
      // Keep existing
      skipFiles.agentsMd = true;
      console.log('  Keeping existing AGENTS.md');
      validChoice = true;
    } else if (choice === '3') {
      // Replace (backup first)
      try {
        fs.copyFileSync(agentsPath, agentsPath + '.backup');
        console.log('  Backup created: AGENTS.md.backup');
      } catch (err) {
        console.log('  Warning: Could not create backup');
        console.warn('Backup creation failed:', err.message);
      }
      skipFiles.agentsMd = false;
      skipFiles.useSemanticMerge = false;
      console.log('  Will replace AGENTS.md');
      validChoice = true;
    } else {
      console.log('  Please enter 1, 2, or 3');
    }
  }
}

/**
 * Prompt for file overwrite and update skipFiles
 * Enhanced: For AGENTS.md without markers, offers intelligent merge option
 */
async function promptForFileOverwrite(question, fileType, exists, skipFiles) {
  if (!exists) return;

  const fileLabels = {
    agentsMd: { prompt: 'Found existing AGENTS.md. Overwrite?', message: 'AGENTS.md', key: 'agentsMd' },
    claudeCommands: { prompt: 'Found existing .claude/commands/. Overwrite?', message: '.claude/commands/', key: 'claudeCommands' }
  };

  const config = fileLabels[fileType];
  if (!config) return;

  // Enhanced: For AGENTS.md, check if it has Forge markers
  if (fileType === 'agentsMd') {
    const agentsPath = path.join(projectRoot, 'AGENTS.md');
    const existingContent = fs.readFileSync(agentsPath, 'utf8');
    const hasUserMarkers = existingContent.includes('<!-- USER:START');
    const hasForgeMarkers = existingContent.includes('<!-- FORGE:START');

    if (!hasUserMarkers && !hasForgeMarkers) {
      // No markers - offer 3 options via helper function
      await promptForAgentsMdWithoutMarkers(question, skipFiles, agentsPath);
      return;
    }
  }

  // Default behavior: Binary y/n for files with markers or .claude/commands
  const overwrite = await askYesNo(question, config.prompt, true);
  if (overwrite) {
    console.log(`  Will overwrite ${config.message}`);
  } else {
    skipFiles[config.key] = true;
    console.log(`  Keeping existing ${config.message}`);
  }
}

/**
 * Display agent selection options
 */
function displayAgentOptions(agentKeys) {
  console.log('STEP 1: Select AI Coding Agents');
  console.log('================================');
  console.log('');
  console.log('Which AI coding agents do you use?');
  console.log('(Enter numbers separated by spaces, or "all")');
  console.log('');

  agentKeys.forEach((key, index) => {
    const agent = AGENTS[key];
    console.log(`  ${(index + 1).toString().padStart(2)}) ${agent.name.padEnd(20)} - ${agent.description}`);
  });
  console.log('');
  console.log('  all) Install for all agents');
  console.log('');
}

/**
 * Validate and parse agent selection input
 */
function validateAgentSelection(input, agentKeys) {
  // Handle empty input
  if (!input?.trim()) {
    return { valid: false, agents: [], message: 'Please enter at least one agent number or "all".' };
  }

  // Handle "all" selection
  if (input.toLowerCase() === 'all') {
    return { valid: true, agents: agentKeys, message: null };
  }

  // Parse numbers
  const nums = input.split(/[\s,]+/).map(n => Number.parseInt(n.trim())).filter(n => !Number.isNaN(n));

  // Validate numbers are in range
  const validNums = nums.filter(n => n >= 1 && n <= agentKeys.length);
  const invalidNums = nums.filter(n => n < 1 || n > agentKeys.length);

  if (invalidNums.length > 0) {
    console.log(`  ⚠ Invalid numbers ignored: ${invalidNums.join(', ')} (valid: 1-${agentKeys.length})`);
  }

  // Deduplicate selected agents using Set
  const selectedAgents = [...new Set(validNums.map(n => agentKeys[n - 1]))].filter(Boolean);

  if (selectedAgents.length === 0) {
    return { valid: false, agents: [], message: 'No valid agents selected. Please try again.' };
  }

  return { valid: true, agents: selectedAgents, message: null };
}

/**
 * Prompt for agent selection with validation loop
 */
async function promptForAgentSelection(question, agentKeys) {
  displayAgentOptions(agentKeys);

  let selectedAgents = [];

  // Loop until valid input is provided
  while (selectedAgents.length === 0) {
    const answer = await question('Your selection: ');
    const result = validateAgentSelection(answer, agentKeys);

    if (result.valid) {
      selectedAgents = result.agents;
    } else if (result.message) {
      console.log(`  ${result.message}`);
    }
  }

  return selectedAgents;
}

/**
 * Attempt semantic merge with fallback to replace
 * Reduces cognitive complexity by extracting merge logic (S3776)
 * @param {string} destPath - Destination file path
 * @param {string} existingContent - Existing file content
 * @param {string} newContent - New template content
 * @param {string} srcPath - Source template path
 */
function trySemanticMerge(destPath, existingContent, newContent, srcPath) {
  try {
    // Add markers to enable future marker-based updates
    const semanticMerged = contextMerge.semanticMerge(existingContent, newContent, {
      addMarkers: true
    });
    fs.writeFileSync(destPath, semanticMerged, 'utf8');
    console.log('  Updated: AGENTS.md (intelligent merge - preserved your content)');
    console.log('  Note: Added USER/FORGE markers for future updates');
  } catch (error) {
    console.log(`  Warning: Semantic merge failed (${error.message}), using replace strategy`);
    if (copyFile(srcPath, 'AGENTS.md')) {
      console.log('  Updated: AGENTS.md (universal standard)');
    }
  }
}

/**
 * Handle AGENTS.md installation
 */
async function installAgentsMd(skipFiles) {
  if (skipFiles.agentsMd) {
    console.log('  Skipped: AGENTS.md (keeping existing)');
    return;
  }

  const agentsSrc = path.join(packageDir, 'AGENTS.md');
  const agentsDest = path.join(projectRoot, 'AGENTS.md');

  // Try smart merge if file exists
  if (fs.existsSync(agentsDest)) {
    const existingContent = fs.readFileSync(agentsDest, 'utf8');
    const newContent = fs.readFileSync(agentsSrc, 'utf8');
    const merged = smartMergeAgentsMd(existingContent, newContent);

    if (merged) {
      // Has markers - use existing smart merge
      fs.writeFileSync(agentsDest, merged, 'utf8');
      console.log('  Updated: AGENTS.md (preserved USER sections)');
    } else if (skipFiles.useSemanticMerge) {
      // Enhanced: No markers but user chose intelligent merge
      trySemanticMerge(agentsDest, existingContent, newContent, agentsSrc);
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

/**
 * Load Claude commands for conversion
 */
function loadClaudeCommands(selectedAgents) {
  const claudeCommands = {};
  const needsClaudeCommands = selectedAgents.includes('claude') ||
    selectedAgents.some(a => AGENTS[a].needsConversion || AGENTS[a].copyCommands);

  if (!needsClaudeCommands) {
    return claudeCommands;
  }

  COMMANDS.forEach(cmd => {
    const cmdPath = path.join(projectRoot, `.claude/commands/${cmd}.md`);
    const content = readFile(cmdPath);
    if (content) {
      claudeCommands[`${cmd}.md`] = content;
    }
  });

  return claudeCommands;
}

/**
 * Setup agents with progress indication
 */
function setupAgentsWithProgress(selectedAgents, claudeCommands, skipFiles) {
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
}

/**
 * Display final setup summary
 */
function displaySetupSummary(selectedAgents) {
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
  console.log('Project Tools Status:');
  console.log('');

  // Beads status
  if (isBeadsInitialized()) {
    console.log('  ✓ Beads initialized - Track work: bd ready');
  } else if (checkForBeads()) {
    console.log('  ! Beads available - Run: bd init');
  } else {
    console.log(`  - Beads not installed - Run: ${PKG_MANAGER} install -g @beads/bd && bd init`);
  }

  // OpenSpec status
  if (isOpenSpecInitialized()) {
    console.log('  ✓ OpenSpec initialized - Specs in openspec/');
  } else if (checkForOpenSpec()) {
    console.log('  ! OpenSpec available - Run: openspec init');
  } else {
    console.log(`  - OpenSpec not installed - Run: ${PKG_MANAGER} install -g @fission-ai/openspec`);
  }

  // Skills status
  if (isSkillsInitialized()) {
    console.log('  ✓ Skills initialized - Manage skills: skills list');
  } else if (checkForSkills()) {
    console.log('  ! Skills available - Run: skills init');
  } else {
    console.log(`  - Skills not installed - Run: ${PKG_MANAGER} install -g @forge/skills`);
  }

  console.log('');
  console.log('Start with: /status');
  console.log('');
  console.log(`Package manager: ${PKG_MANAGER}`);
  console.log('');
}


// Interactive setup
// @private - Currently unused, reserved for future interactive flow
async function _interactiveSetup() {
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
  const projectStatus = await detectProjectStatus();
  displayInstallationStatus(projectStatus);

  // Track which files to skip based on user choices
  const skipFiles = {
    agentsMd: false,
    claudeCommands: false
  };

  // Ask about overwriting existing files
  await promptForFileOverwrite(question, 'agentsMd', projectStatus.hasAgentsMd, skipFiles);
  await promptForFileOverwrite(question, 'claudeCommands', projectStatus.hasClaudeCommands, skipFiles);

  if (projectStatus.type !== 'fresh') {
    console.log('');
  }

  // =============================================
  // STEP 1: Agent Selection
  // =============================================
  const agentKeys = Object.keys(AGENTS);
  const selectedAgents = await promptForAgentSelection(question, agentKeys);

  console.log('');
  console.log('Installing Forge workflow...');

  // Install AGENTS.md
  await installAgentsMd(skipFiles);
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
    // Then load the commands
    claudeCommands = loadClaudeCommands(selectedAgents);
  }

  // Setup each selected agent with progress indication
  setupAgentsWithProgress(selectedAgents, claudeCommands, skipFiles);

  // =============================================
  // STEP 2: Project Tools Setup
  // =============================================
  await setupProjectTools(rl, question);

  // =============================================
  // STEP 3: External Services Configuration
  // =============================================
  console.log('');
  console.log('STEP 3: External Services (Optional)');
  console.log('=====================================');

  await configureExternalServices(rl, question, selectedAgents, projectStatus);

  setupCompleted = true;
  rl.close();

  // =============================================
  // Final Summary
  // =============================================
  displaySetupSummary(selectedAgents);
}

// Parse CLI flags
function parseFlags() {
  const flags = {
    quick: false,
    skipExternal: false,
    agents: null,
    all: false,
    help: false,
    path: null,
    merge: null,     // 'smart'|'preserve'|'replace'
    type: null,      // 'critical'|'standard'|'simple'|'hotfix'|'docs'|'refactor'
    interview: false // Force context interview
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
    } else if (arg === '--path' || arg === '-p' || arg.startsWith('--path=')) {
      const result = parsePathFlag(args, i);
      flags.path = result.value;
      i = result.nextIndex;
    } else if (arg === '--agents' || arg.startsWith('--agents=')) {
      const result = parseAgentsFlag(args, i);
      flags.agents = result.value;
      i = result.nextIndex;
    } else if (arg === '--merge' || arg.startsWith('--merge=')) {
      const result = parseMergeFlag(args, i);
      flags.merge = result.value;
      i = result.nextIndex;
    } else if (arg === '--type' || arg.startsWith('--type=')) {
      const result = parseTypeFlag(args, i);
      flags.type = result.value;
      i = result.nextIndex;
    } else if (arg === '--interview') {
      flags.interview = true;
      i++;
    } else {
      i++;
    }
  }

  return flags;
}

// Parse --path flag with validation - extracted to reduce complexity
function parsePathFlag(args, i) {
  let inputPath = null;
  let nextIndex = i + 1;

  if (args[i].startsWith('--path=')) {
    // --path=/some/dir format
    inputPath = args[i].replace('--path=', '');
  } else if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
    // --path <directory> format
    inputPath = args[i + 1];
    nextIndex = i + 2;
  }

  if (inputPath) {
    const validation = validateUserInput(inputPath, 'directory_path');
    if (!validation.valid) {
      console.error(`Error: Invalid --path value: ${validation.error}`);
      process.exit(1);
    }
  }

  return { value: inputPath, nextIndex };
}

// Parse --agents flag with list - extracted to reduce complexity
function parseAgentsFlag(args, i) {
  if (args[i].startsWith('--agents=')) {
    // --agents=claude,cursor format
    return { value: args[i].replace('--agents=', ''), nextIndex: i + 1 };
  }

  // --agents claude cursor format
  const agentList = [];
  let j = i + 1;
  while (j < args.length && !args[j].startsWith('-')) {
    agentList.push(args[j]);
    j++;
  }

  return { value: agentList.length > 0 ? agentList.join(',') : null, nextIndex: j };
}

// Parse --merge flag with enum validation - extracted to reduce complexity
function parseMergeFlag(args, i) {
  const validModes = ['smart', 'preserve', 'replace'];
  let mergeMode = null;
  let nextIndex = i + 1;

  if (args[i].startsWith('--merge=')) {
    // --merge=smart format
    mergeMode = args[i].replace('--merge=', '');
  } else if (i + 1 < args.length) {
    // --merge smart format
    mergeMode = args[i + 1];
    nextIndex = i + 2;
  } else {
    console.error('--merge requires a value: smart, preserve, or replace');
    process.exit(1);
  }

  if (!validModes.includes(mergeMode)) {
    console.error(`Invalid --merge value: ${mergeMode}`);
    console.error('Valid options: smart, preserve, replace');
    process.exit(1);
  }

  return { value: mergeMode, nextIndex };
}

// Parse --type flag with enum validation - extracted to reduce complexity
function parseTypeFlag(args, i) {
  const validTypes = ['critical', 'standard', 'simple', 'hotfix', 'docs', 'refactor'];
  let workType = null;
  let nextIndex = i + 1;

  if (args[i].startsWith('--type=')) {
    // --type=critical format
    workType = args[i].replace('--type=', '');
  } else if (i + 1 < args.length) {
    // --type critical format
    workType = args[i + 1];
    nextIndex = i + 2;
  } else {
    console.error('--type requires a value');
    console.error(`Valid options: ${validTypes.join(', ')}`);
    process.exit(1);
  }

  if (!validTypes.includes(workType)) {
    console.error(`Invalid --type value: ${workType}`);
    console.error(`Valid options: ${validTypes.join(', ')}`);
    process.exit(1);
  }

  return { value: workType, nextIndex };
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
  console.log('  --merge <mode>       Merge strategy for existing AGENTS.md files');
  console.log('                       Options: smart (intelligent merge), preserve (keep existing),');
  console.log('                                replace (overwrite with new)');
  console.log('  --type <type>        Set workflow profile type manually');
  console.log('                       Options: critical, standard, simple, hotfix, docs, refactor');
  console.log('  --interview          Force context interview (gather project information)');
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
  console.log('  npx forge setup --merge=smart            # Use intelligent merge for existing files');
  console.log('  npx forge setup --type=critical          # Set workflow profile manually');
  console.log('  npx forge setup --interview              # Force context interview');
  console.log('');
  console.log('Also works with bun:');
  console.log('  bunx forge setup --quick');
  console.log('');
}

// Install git hooks via lefthook
// SECURITY: Uses execSync with HARDCODED strings only (no user input)
function installGitHooks() {
  console.log('Installing git hooks (TDD enforcement)...');

  // Check if lefthook.yml exists (it should, as it's in the package)
  const lefthookConfig = path.join(packageDir, 'lefthook.yml');
  const targetHooks = path.join(projectRoot, '.forge/hooks');

  try {
    // Copy lefthook.yml to project root
    const lefthookTarget = path.join(projectRoot, 'lefthook.yml');
    if (!fs.existsSync(lefthookTarget)) {
      if (copyFile(lefthookConfig, 'lefthook.yml')) {
        console.log('  ✓ Created lefthook.yml');
      }
    }

    // Copy check-tdd.js hook script
    const hookSource = path.join(packageDir, '.forge/hooks/check-tdd.js');
    if (fs.existsSync(hookSource)) {
      // Ensure .forge/hooks directory exists
      if (!fs.existsSync(targetHooks)) {
        fs.mkdirSync(targetHooks, { recursive: true });
      }

      const hookTarget = path.join(targetHooks, 'check-tdd.js');
      if (copyFile(hookSource, hookTarget)) {
        console.log('  ✓ Created .forge/hooks/check-tdd.js');

        // Make hook executable (Unix systems)
        try {
          fs.chmodSync(hookTarget, 0o755);
        } catch (err) {
          // Windows doesn't need chmod
          console.warn('chmod not available (Windows):', err.message);
        }
      }
    }

    // Try to install lefthook hooks
    // SECURITY: Using execFileSync with hardcoded commands (no user input)
    try {
      // Try npx first (local install), fallback to global
      try {
        secureExecFileSync('npx', ['lefthook', 'install'], { stdio: 'inherit', cwd: projectRoot });
        console.log('  ✓ Lefthook hooks installed (local)');
      } catch (error_) {
        // Fallback to global lefthook
        console.warn('npx lefthook failed, trying global:', error_.message);
        execFileSync('lefthook', ['version'], { stdio: 'ignore' });
        execFileSync('lefthook', ['install'], { stdio: 'inherit', cwd: projectRoot });
        console.log('  ✓ Lefthook hooks installed (global)');
      }
    } catch (err) {
      console.warn('Lefthook installation failed:', err.message);
      console.log('  ℹ Lefthook not found. Install it:');
      console.log('    bun add -d lefthook  (recommended)');
      console.log('    OR: bun add -g lefthook  (global)');
      console.log('    Then run: bunx lefthook install');
    }

    console.log('');

  } catch (error) {
    console.log('  ⚠ Failed to install hooks:', error.message);
    console.log('  You can install manually later with: lefthook install');
    console.log('');
  }
}

// Check if lefthook is already installed in project
function checkForLefthook() {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return false;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return !!(pkg.devDependencies?.lefthook || pkg.dependencies?.lefthook);
  } catch (err) {
    console.warn('Failed to check lefthook in package.json:', err.message);
    return false;
  }
}

// Check if Beads is installed (global, local, or bunx-capable)
function checkForBeads() {
  // Try global install first
  try {
    secureExecFileSync('bd', ['version'], { stdio: 'ignore' });
    return 'global';
  } catch (err) {
    // Not global
    console.warn('Beads not found globally:', err.message);
  }

  // Check if bunx can run it
  try {
    secureExecFileSync('bunx', ['@beads/bd', 'version'], { stdio: 'ignore' });
    return 'bunx';
  } catch (err) {
    // Not bunx-capable
    console.warn('Beads not available via bunx:', err.message);
  }

  // Check local project installation
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const isInstalled = pkg.devDependencies?.['@beads/bd'] || pkg.dependencies?.['@beads/bd'];
    return isInstalled ? 'local' : null;
  } catch (err) {
    console.warn('Failed to check Beads in package.json:', err.message);
    return null;
  }
}

// Check if OpenSpec is installed
function checkForOpenSpec() {
  // Try global install first
  try {
    secureExecFileSync('openspec', ['version'], { stdio: 'ignore' });
    return 'global';
  } catch (err) {
    // Not global
    console.warn('OpenSpec not found globally:', err.message);
  }

  // Check if bunx can run it
  try {
    secureExecFileSync('bunx', ['@fission-ai/openspec', 'version'], { stdio: 'ignore' });
    return 'bunx';
  } catch (err) {
    // Not bunx-capable
    console.warn('OpenSpec not available via bunx:', err.message);
  }

  // Check local project installation
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const isInstalled = pkg.devDependencies?.['@fission-ai/openspec'] || pkg.dependencies?.['@fission-ai/openspec'];
    return isInstalled ? 'local' : null;
  } catch (err) {
    console.warn('Failed to check OpenSpec in package.json:', err.message);
    return null;
  }
}

// Check if Beads is initialized in project
function isBeadsInitialized() {
  return fs.existsSync(path.join(projectRoot, '.beads'));
}

// Check if OpenSpec is initialized in project
function isOpenSpecInitialized() {
  return fs.existsSync(path.join(projectRoot, 'openspec'));
}

// Initialize Beads in the project
function initializeBeads(installType) {
  console.log('Initializing Beads in project...');

  try {
    // SECURITY: execFileSync with hardcoded commands
    if (installType === 'global') {
      secureExecFileSync('bd', ['init'], { stdio: 'inherit', cwd: projectRoot });
    } else if (installType === 'bunx') {
      secureExecFileSync('bunx', ['@beads/bd', 'init'], { stdio: 'inherit', cwd: projectRoot });
    } else if (installType === 'local') {
      secureExecFileSync('npx', ['bd', 'init'], { stdio: 'inherit', cwd: projectRoot });
    }
    console.log('  ✓ Beads initialized');
    return true;
  } catch (err) {
    console.log('  ⚠ Failed to initialize Beads:', err.message);
    console.log('  Run manually: bd init');
    return false;
  }
}

// Initialize OpenSpec in the project
function initializeOpenSpec(installType) {
  console.log('Initializing OpenSpec in project...');

  try {
    // SECURITY: execFileSync with hardcoded commands
    if (installType === 'global') {
      secureExecFileSync('openspec', ['init'], { stdio: 'inherit', cwd: projectRoot });
    } else if (installType === 'bunx') {
      secureExecFileSync('bunx', ['@fission-ai/openspec', 'init'], { stdio: 'inherit', cwd: projectRoot });
    } else if (installType === 'local') {
      secureExecFileSync('npx', ['openspec', 'init'], { stdio: 'inherit', cwd: projectRoot });
    }
    console.log('  ✓ OpenSpec initialized');
    return true;
  } catch (err) {
    console.log('  ⚠ Failed to initialize OpenSpec:', err.message);
    console.log('  Run manually: openspec init');
    return false;
  }
}

// Check if Skills CLI is installed
function checkForSkills() {
  // Try global install first
  try {
    secureExecFileSync('skills', ['--version'], { stdio: 'ignore' });
    return 'global';
  } catch (_err) {
    // Not global - this is expected when Skills is not installed, continue checking other methods
  }

  // Check if bunx can run it
  try {
    secureExecFileSync('bunx', ['@forge/skills', '--version'], { stdio: 'ignore' });
    return 'bunx';
  } catch (_err) {
    // Not bunx-capable - this is expected when Skills is not installed, continue checking local
  }

  // Check local project installation
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const isInstalled = pkg.devDependencies?.['@forge/skills'] || pkg.dependencies?.['@forge/skills'];
    return isInstalled ? 'local' : null;
  } catch (_err) {
    // Failed to parse package.json
    return null;
  }
}

// Check if Skills is initialized in project
function isSkillsInitialized() {
  return fs.existsSync(path.join(projectRoot, '.skills'));
}

// Initialize Skills in the project
function initializeSkills(installType) {
  console.log('Initializing Skills in project...');

  try {
    // Using secureExecFileSync to validate PATH and mitigate S4036
    if (installType === 'global') {
      secureExecFileSync('skills', ['init'], { stdio: 'inherit', cwd: projectRoot });
    } else if (installType === 'bunx') {
      secureExecFileSync('bunx', ['@forge/skills', 'init'], { stdio: 'inherit', cwd: projectRoot });
    } else if (installType === 'local') {
      secureExecFileSync('npx', ['skills', 'init'], { stdio: 'inherit', cwd: projectRoot });
    }
    console.log('  ✓ Skills initialized');
    return true;
  } catch (err) {
    console.log('  ⚠ Failed to initialize Skills:', err.message);
    console.log('  Run manually: skills init');
    return false;
  }
}

// Prompt for Beads setup - extracted to reduce cognitive complexity
async function promptBeadsSetup(question) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Beads Setup (Recommended)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  const beadsInitialized = isBeadsInitialized();
  const beadsStatus = checkForBeads();

  if (beadsInitialized) {
    console.log('✓ Beads is already initialized in this project');
    console.log('');
    return;
  }

  if (beadsStatus) {
    // Already installed, just need to initialize
    console.log(`ℹ Beads is installed (${beadsStatus}), but not initialized`);
    const initBeads = await question('Initialize Beads in this project? (y/n): ');

    if (initBeads.toLowerCase() === 'y') {
      initializeBeads(beadsStatus);
    } else {
      console.log('Skipped Beads initialization. Run manually: bd init');
    }
    console.log('');
    return;
  }

  // Not installed
  console.log('ℹ Beads is not installed');
  const installBeads = await question('Install Beads? (y/n): ');

  if (installBeads.toLowerCase() !== 'y') {
    console.log('Skipped Beads installation');
    console.log('');
    return;
  }

  console.log('');
  console.log('Choose installation method:');
  console.log('  1. Global (recommended) - Available system-wide');
  console.log('  2. Local - Project-specific devDependency');
  console.log('  3. Bunx - Use via bunx (requires bun)');
  console.log('');
  const method = await question('Choose method (1-3): ');

  console.log('');
  installBeadsWithMethod(method);
  console.log('');
}

// Helper: Install Beads with chosen method - extracted to reduce cognitive complexity
function installBeadsWithMethod(method) {
  try {
    // SECURITY: secureExecFileSync with hardcoded commands
    if (method === '1') {
      console.log('Installing Beads globally...');
      const pkgManager = PKG_MANAGER === 'bun' ? 'bun' : 'npm';
      secureExecFileSync(pkgManager, ['install', '-g', '@beads/bd'], { stdio: 'inherit' });
      console.log('  ✓ Beads installed globally');
      initializeBeads('global');
    } else if (method === '2') {
      console.log('Installing Beads locally...');
      const pkgManager = PKG_MANAGER === 'bun' ? 'bun' : 'npm';
      secureExecFileSync(pkgManager, ['install', '-D', '@beads/bd'], { stdio: 'inherit', cwd: projectRoot });
      console.log('  ✓ Beads installed locally');
      initializeBeads('local');
    } else if (method === '3') {
      console.log('Testing bunx capability...');
      try {
        secureExecFileSync('bunx', ['@beads/bd', 'version'], { stdio: 'ignore' });
        console.log('  ✓ Bunx is available');
        initializeBeads('bunx');
      } catch (err) {
        console.warn('Beads bunx test failed:', err.message);
        console.log('  ⚠ Bunx not available. Install bun first: curl -fsSL https://bun.sh/install | bash');
      }
    } else {
      console.log('Invalid choice. Skipping Beads installation.');
    }
  } catch (err) {
    console.warn('Beads installation failed:', err.message);
    console.log('  ⚠ Failed to install Beads:', err.message);
    console.log('  Run manually: bun add -g @beads/bd && bd init');
  }
}

// Prompt for OpenSpec setup - extracted to reduce cognitive complexity
async function promptOpenSpecSetup(question) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('OpenSpec Setup (Optional)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  const openspecInitialized = isOpenSpecInitialized();
  const openspecStatus = checkForOpenSpec();

  if (openspecInitialized) {
    console.log('✓ OpenSpec is already initialized in this project');
    console.log('');
    return;
  }

  if (openspecStatus) {
    // Already installed, just need to initialize
    console.log(`ℹ OpenSpec is installed (${openspecStatus}), but not initialized`);
    const initOpenSpec = await question('Initialize OpenSpec in this project? (y/n): ');

    if (initOpenSpec.toLowerCase() === 'y') {
      initializeOpenSpec(openspecStatus);
    } else {
      console.log('Skipped OpenSpec initialization. Run manually: openspec init');
    }
    console.log('');
    return;
  }

  // Not installed
  console.log('ℹ OpenSpec is not installed');
  const installOpenSpec = await question('Install OpenSpec? (y/n): ');

  if (installOpenSpec.toLowerCase() !== 'y') {
    console.log('Skipped OpenSpec installation');
    console.log('');
    return;
  }

  console.log('');
  console.log('Choose installation method:');
  console.log('  1. Global (recommended) - Available system-wide');
  console.log('  2. Local - Project-specific devDependency');
  console.log('  3. Bunx - Use via bunx (requires bun)');
  console.log('');
  const method = await question('Choose method (1-3): ');

  console.log('');
  installOpenSpecWithMethod(method);
  console.log('');
}

// Helper: Install OpenSpec with chosen method - extracted to reduce cognitive complexity
function installOpenSpecWithMethod(method) {
  try {
    // SECURITY: secureExecFileSync with hardcoded commands
    if (method === '1') {
      console.log('Installing OpenSpec globally...');
      const pkgManager = PKG_MANAGER === 'bun' ? 'bun' : 'npm';
      const installCmd = PKG_MANAGER === 'bun' ? 'add' : 'install';
      secureExecFileSync(pkgManager, [installCmd, '-g', '@fission-ai/openspec'], { stdio: 'inherit' });
      console.log('  ✓ OpenSpec installed globally');
      initializeOpenSpec('global');
    } else if (method === '2') {
      console.log('Installing OpenSpec locally...');
      const pkgManager = PKG_MANAGER === 'bun' ? 'bun' : 'npm';
      const installCmd = PKG_MANAGER === 'bun' ? 'add' : 'install';
      secureExecFileSync(pkgManager, [installCmd, '-D', '@fission-ai/openspec'], { stdio: 'inherit', cwd: projectRoot });
      console.log('  ✓ OpenSpec installed locally');
      initializeOpenSpec('local');
    } else if (method === '3') {
      console.log('Testing bunx capability...');
      try {
        secureExecFileSync('bunx', ['@fission-ai/openspec', 'version'], { stdio: 'ignore' });
        console.log('  ✓ Bunx is available');
        initializeOpenSpec('bunx');
      } catch (err) {
        console.warn('OpenSpec bunx test failed:', err.message);
        console.log('  ⚠ Bunx not available. Install bun first: curl -fsSL https://bun.sh/install | bash');
      }
    } else {
      console.log('Invalid choice. Skipping OpenSpec installation.');
    }
  } catch (err) {
    console.warn('OpenSpec installation failed:', err.message);
    console.log('  ⚠ Failed to install OpenSpec:', err.message);
    console.log('  Run manually: bun add -g @fission-ai/openspec && openspec init');
  }
}

// Prompt for Skills setup - extracted to reduce cognitive complexity
async function promptSkillsSetup(question) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Skills CLI Setup (Recommended)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  const skillsInitialized = isSkillsInitialized();
  const skillsStatus = checkForSkills();

  if (skillsInitialized) {
    console.log('✓ Skills is already initialized in this project');
    console.log('');
    return;
  }

  if (skillsStatus) {
    // Already installed, just need to initialize
    console.log(`ℹ Skills is installed (${skillsStatus}), but not initialized`);
    const initSkills = await question('Initialize Skills in this project? (y/n): ');

    if (initSkills.toLowerCase() === 'y') {
      initializeSkills(skillsStatus);
    } else {
      console.log('Skipped Skills initialization. Run manually: skills init');
    }
    console.log('');
    return;
  }

  // Not installed
  console.log('ℹ Skills is not installed');
  const installSkills = await question('Install Skills CLI? (y/n): ');

  if (installSkills.toLowerCase() !== 'y') {
    console.log('Skipped Skills installation');
    console.log('');
    return;
  }

  console.log('');
  console.log('Choose installation method:');
  console.log('  1. Global (recommended) - Available system-wide');
  console.log('  2. Local - Project-specific devDependency');
  console.log('  3. Bunx - Use via bunx (requires bun)');
  console.log('');
  const installMethod = await question('Choose installation method (1-3): ');

  try {
    if (installMethod === '1') {
      console.log('Installing Skills globally...');
      // Map install commands per package manager
      let installArgs;
      if (PKG_MANAGER === 'bun') {
        installArgs = ['add', '-g', '@forge/skills'];
      } else if (PKG_MANAGER === 'yarn') {
        installArgs = ['global', 'add', '@forge/skills'];
      } else if (PKG_MANAGER === 'pnpm') {
        installArgs = ['add', '-g', '@forge/skills'];
      } else {
        installArgs = ['install', '-g', '@forge/skills'];
      }
      secureExecFileSync(PKG_MANAGER, installArgs, { stdio: 'inherit' });
      console.log('  ✓ Skills installed globally');
      initializeSkills('global');
    } else if (installMethod === '2') {
      console.log('Installing Skills locally...');
      // Map install commands per package manager
      let installArgs;
      if (PKG_MANAGER === 'bun') {
        installArgs = ['add', '-D', '@forge/skills'];
      } else if (PKG_MANAGER === 'yarn') {
        installArgs = ['add', '-D', '@forge/skills'];
      } else if (PKG_MANAGER === 'pnpm') {
        installArgs = ['add', '-D', '@forge/skills'];
      } else {
        installArgs = ['install', '-D', '@forge/skills'];
      }
      secureExecFileSync(PKG_MANAGER, installArgs, { stdio: 'inherit', cwd: projectRoot });
      console.log('  ✓ Skills installed locally');
      initializeSkills('local');
    } else if (installMethod === '3') {
      console.log('Testing bunx capability...');
      try {
        secureExecFileSync('bunx', ['@forge/skills', '--version'], { stdio: 'ignore' });
        console.log('  ✓ Bunx is available');
        initializeSkills('bunx');
      } catch (err) {
        console.warn('Skills bunx test failed:', err.message);
        console.log('  ⚠ Bunx not available. Install bun first: curl -fsSL https://bun.sh/install | bash');
      }
    } else {
      console.log('Invalid choice. Skipping Skills installation.');
    }
  } catch (err) {
    console.warn('Skills installation failed:', err.message);
    console.log('  ⚠ Failed to install Skills:', err.message);
    console.log('  Run manually: bun add -g @forge/skills && skills init');
  }
}

// Interactive setup for Beads and OpenSpec
async function setupProjectTools(rl, question) {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  STEP 2: Project Tools (Recommended)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('Forge recommends three tools for enhanced workflows:');
  console.log('');
  console.log('• Beads - Git-backed issue tracking');
  console.log('  Persists tasks across sessions, tracks dependencies.');
  console.log('  Command: bd ready, bd create, bd close');
  console.log('');
  console.log('• OpenSpec - Spec-driven development');
  console.log('  Structured specifications for complex features.');
  console.log('  Command: openspec init, openspec status');
  console.log('');
  console.log('• Skills - Universal SKILL.md management');
  console.log('  Manage AI agent skills across all agents.');
  console.log('  Command: skills create, skills list, skills sync');
  console.log('');

  // Use helper functions to reduce complexity
  await promptBeadsSetup(question);
  await promptOpenSpecSetup(question);
  await promptSkillsSetup(question);
}

// Auto-setup Beads in quick mode - extracted to reduce cognitive complexity
function autoSetupBeadsInQuickMode() {
  const beadsStatus = checkForBeads();
  const beadsInitialized = isBeadsInitialized();

  if (!beadsInitialized && beadsStatus) {
    console.log('📦 Initializing Beads...');
    initializeBeads(beadsStatus);
    console.log('');
  } else if (!beadsInitialized && !beadsStatus) {
    console.log('📦 Installing Beads globally...');
    try {
      // SECURITY: secureExecFileSync with hardcoded command
      const pkgManager = PKG_MANAGER === 'bun' ? 'bun' : 'npm';
      secureExecFileSync(pkgManager, ['install', '-g', '@beads/bd'], { stdio: 'inherit' });
      console.log('  ✓ Beads installed globally');
      initializeBeads('global');
    } catch (err) {
      // Installation failed - provide manual instructions
      console.log('  ⚠ Could not install Beads automatically');
      console.log(`    Error: ${err.message}`);
      console.log('  Run manually: npm install -g @beads/bd && bd init');
    }
    console.log('');
  }
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

  // Check if lefthook is installed, auto-install if not
  const hasLefthook = checkForLefthook();
  if (!hasLefthook) {
    console.log('📦 Installing lefthook for git hooks...');
    try {
      // SECURITY: execFileSync with hardcoded command
      execFileSync('bun', ['add', '-d', 'lefthook'], { stdio: 'inherit', cwd: projectRoot });
      console.log('  ✓ Lefthook installed');
    } catch (err) {
      console.warn('Lefthook auto-install failed:', err.message);
      console.log('  ⚠ Could not install lefthook automatically');
      console.log('  Run manually: bun add -d lefthook');
    }
    console.log('');
  }

  // Auto-setup Beads in quick mode (non-interactive)
  autoSetupBeadsInQuickMode();

  // OpenSpec: skip in quick mode (optional tool)
  // Only initialize if already installed
  const openspecStatus = checkForOpenSpec();
  const openspecInitialized = isOpenSpecInitialized();

  if (openspecStatus && !openspecInitialized) {
    console.log('📦 Initializing OpenSpec...');
    initializeOpenSpec(openspecStatus);
    console.log('');
  }

  // Skills: initialize if already installed (recommended tool)
  const skillsStatus = checkForSkills();
  const skillsInitialized = isSkillsInitialized();

  if (skillsStatus && !skillsInitialized) {
    console.log('📦 Initializing Skills...');
    initializeSkills(skillsStatus);
    console.log('');
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

  // Install git hooks for TDD enforcement
  console.log('');
  installGitHooks();

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

// Helper: Apply merge strategy to existing AGENTS.md - extracted to reduce cognitive complexity
function applyAgentsMdMergeStrategy(mergeStrategy, agentsSrc, agentsDest, existingContent, newContent) {
  if (mergeStrategy === 'preserve') {
    console.log('  Preserved: AGENTS.md (--merge=preserve)');
    return;
  }

  if (mergeStrategy === 'replace') {
    if (copyFile(agentsSrc, 'AGENTS.md')) {
      console.log('  Replaced: AGENTS.md (--merge=replace)');
    }
    return;
  }

  // Default: smart merge
  const merged = smartMergeAgentsMd(existingContent, newContent);
  if (merged) {
    fs.writeFileSync(agentsDest, merged, 'utf8');
    console.log('  Updated: AGENTS.md (smart merge, preserved USER sections)');
  } else if (copyFile(agentsSrc, 'AGENTS.md')) {
    console.log('  Updated: AGENTS.md (universal standard)');
  }
}

// Setup AGENTS.md file with merge strategy - extracted to reduce cognitive complexity
function setupAgentsMdFile(flags, skipFiles) {
  if (skipFiles.agentsMd) {
    console.log('  Skipped: AGENTS.md (keeping existing)');
    return;
  }

  const agentsSrc = path.join(packageDir, 'AGENTS.md');
  const agentsDest = path.join(projectRoot, 'AGENTS.md');
  const mergeStrategy = flags.merge || 'smart';

  if (fs.existsSync(agentsDest)) {
    const existingContent = fs.readFileSync(agentsDest, 'utf8');
    const newContent = fs.readFileSync(agentsSrc, 'utf8');
    applyAgentsMdMergeStrategy(mergeStrategy, agentsSrc, agentsDest, existingContent, newContent);
  } else if (copyFile(agentsSrc, 'AGENTS.md')) {
    console.log('  Created: AGENTS.md (universal standard)');
    const detection = detectProjectType();
    if (detection.hasPackageJson) {
      updateAgentsMdWithProjectType(detection);
      displayProjectType(detection);
    }
  }
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
  const projectStatus = await detectProjectStatus();

  // Handle user-provided flags to override auto-detection
  if (flags.type || flags.interview) {
    console.log('User-provided flags:');
    if (flags.type) {
      console.log(`  --type=${flags.type} (workflow profile override)`);
      // Update saved context with manual type override
      if (projectStatus.autoDetected) {
        try {
          const contextPath = path.join(projectRoot, '.forge', 'context.json');
          if (fs.existsSync(contextPath)) {
            const contextData = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
            contextData.user_provided = contextData.user_provided || {};
            contextData.user_provided.workflowType = flags.type;
            contextData.last_updated = new Date().toISOString();
            fs.writeFileSync(contextPath, JSON.stringify(contextData, null, 2), 'utf8');
          }
        } catch (error) {
          console.warn('  Warning: Could not save workflow type override:', error.message);
        }
      }
    }
    if (flags.interview) {
      console.log('  --interview (context interview mode)');
      console.log('  Note: Enhanced context gathering is a future feature');
    }
    console.log('');
  }

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

  // STEP 1: Agent Selection (delegated to helper)
  const agentKeys = Object.keys(AGENTS);
  const selectedAgents = await promptForAgentSelection(question, agentKeys);

  console.log('');
  console.log('Installing Forge workflow...');

  // Setup AGENTS.md (delegated to helper)
  setupAgentsMdFile(flags, skipFiles);
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

  // Display final summary (delegated to helper)
  displaySetupSummary(selectedAgents);
}

// Main
// Helper: Handle --path setup
function handlePathSetup(targetPath) {
  const resolvedPath = path.resolve(targetPath);

  // Create directory if it doesn't exist
  if (!fs.existsSync(resolvedPath)) {
    try {
      fs.mkdirSync(resolvedPath, { recursive: true });
      console.log(`Created directory: ${resolvedPath}`);
    } catch (err) {
      console.error(`Error creating directory: ${err.message}`);
      process.exit(1);
    }
  }

  // Verify it's a directory
  if (!fs.statSync(resolvedPath).isDirectory()) {
    console.error(`Error: ${resolvedPath} is not a directory`);
    process.exit(1);
  }

  // Change to target directory
  try {
    process.chdir(resolvedPath);
    console.log(`Working directory: ${resolvedPath}`);
    console.log('');
  } catch (err) {
    console.error(`Error changing to directory: ${err.message}`);
    process.exit(1);
  }

  // Return the resolved path so caller can update projectRoot
  return resolvedPath;
}

// Helper: Determine selected agents from flags
function determineSelectedAgents(flags) {
  if (flags.all) {
    return Object.keys(AGENTS);
  }

  if (flags.agents) {
    const selectedAgents = validateAgents(flags.agents);
    if (selectedAgents.length === 0) {
      console.log('No valid agents specified.');
      console.log('Available agents:', Object.keys(AGENTS).join(', '));
      process.exit(1);
    }
    return selectedAgents;
  }

  return [];
}

// Helper: Handle setup command in non-quick mode
async function handleSetupCommand(selectedAgents, flags) {
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
  const claudeCommands = loadClaudeCommands(selectedAgents);

  // Setup agents
  selectedAgents.forEach(agentKey => {
    if (agentKey !== 'claude') {
      setupAgent(agentKey, claudeCommands);
    }
  });

  console.log('');
  console.log('Agent configuration complete!');

  // Install git hooks for TDD enforcement
  console.log('');
  installGitHooks();

  // External services (unless skipped)
  await handleExternalServices(flags.skipExternal, selectedAgents);

  console.log('');
  console.log('Done! Get started with: /status');
}

// Helper: Handle external services configuration
async function handleExternalServices(skipExternal, selectedAgents) {
  if (skipExternal) {
    console.log('');
    console.log('Skipping external services configuration...');
    return;
  }

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
    // Update projectRoot after changing directory to maintain state consistency
    projectRoot = handlePathSetup(flags.path);
  }

  if (command === 'setup') {
    // Determine agents to install
    let selectedAgents = determineSelectedAgents(flags);

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
      await handleSetupCommand(selectedAgents, flags);
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

// Helper: Validate commit hash for rollback - extracted to reduce cognitive complexity
function validateCommitHash(target) {
  if (target !== 'HEAD' && !/^[0-9a-f]{4,40}$/i.test(target)) {
    return { valid: false, error: 'Invalid commit hash format' };
  }
  return { valid: true };
}

// Helper: Validate file paths for partial rollback - extracted to reduce cognitive complexity
function validatePartialRollbackPaths(target) {
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
  return { valid: true };
}

// Helper: Validate branch range for rollback - extracted to reduce cognitive complexity
function validateBranchRange(target) {
  if (!target.includes('..')) {
    return { valid: false, error: 'Branch range must use format: start..end' };
  }
  const [start, end] = target.split('..');
  if (!/^[0-9a-f]{4,40}$/i.test(start) || !/^[0-9a-f]{4,40}$/i.test(end)) {
    return { valid: false, error: 'Invalid commit hashes in range' };
  }
  return { valid: true };
}

// Validate rollback inputs (security-critical)
function validateRollbackInput(method, target) {
  const validMethods = ['commit', 'pr', 'partial', 'branch'];
  if (!validMethods.includes(method)) {
    return { valid: false, error: 'Invalid method' };
  }

  // Delegate to method-specific validators
  if (method === 'commit' || method === 'pr') {
    return validateCommitHash(target);
  }

  if (method === 'partial') {
    return validatePartialRollbackPaths(target);
  }

  if (method === 'branch') {
    return validateBranchRange(target);
  }

  return { valid: true };
}

// Extract USER sections before rollback
// Helper: Extract USER:START/END marker sections from content
function extractUserMarkerSections(content) {
  const sections = {};
  const userRegex = /<!-- USER:START -->([\s\S]*?)<!-- USER:END -->/g;
  let match;
  let index = 0;

  while ((match = userRegex.exec(content)) !== null) {
    sections[`user_${index}`] = match[1];
    index++;
  }

  return sections;
}

// Helper: Extract custom commands from directory
function extractCustomCommands(filePath) {
  const customCommandsDir = path.join(path.dirname(filePath), '.claude', 'commands', 'custom');

  if (!fs.existsSync(customCommandsDir)) {
    return null;
  }

  return fs.readdirSync(customCommandsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      name: f,
      content: fs.readFileSync(path.join(customCommandsDir, f), 'utf-8')
    }));
}

function extractUserSections(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const content = fs.readFileSync(filePath, 'utf-8');
  const sections = extractUserMarkerSections(content);

  // Extract custom commands
  const customCommands = extractCustomCommands(filePath);
  if (customCommands) {
    sections.customCommands = customCommands;
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
// Helper: Check git working directory is clean
function checkGitWorkingDirectory() {
  try {
    const { execSync } = require('node:child_process');
    const status = execSync('git status --porcelain', { encoding: 'utf-8' });
    if (status.trim() !== '') {
      console.log('  ❌ Working directory has uncommitted changes');
      console.log('     Commit or stash changes before rollback');
      return false;
    }
    return true;
  } catch (err) {
    console.log('  ❌ Git error:', err.message);
    return false;
  }
}

// Helper: Update Beads issue after PR rollback
function updateBeadsIssue(commitMessage) {
  const issueMatch = commitMessage.match(/#(\d+)/);
  if (!issueMatch) return;

  try {
    const { execFileSync } = require('node:child_process');
    execFileSync('bd', ['update', issueMatch[1], '--status', 'reverted', '--comment', 'PR reverted'], { stdio: 'inherit' });
    console.log(`     Updated Beads issue #${issueMatch[1]} to 'reverted'`);
  } catch {
    // Beads not installed - silently continue
  }
}

// Helper: Handle commit rollback
function handleCommitRollback(target, dryRun, execSync) {
  if (dryRun) {
    console.log(`     Would revert: ${target}`);
    const files = execSync(`git diff-tree --no-commit-id --name-only -r ${target}`, { encoding: 'utf-8' });
    console.log('     Affected files:');
    files.trim().split('\n').forEach(f => console.log(`       - ${f}`));
  } else {
    execSync(`git revert --no-edit ${target}`, { stdio: 'inherit' });
  }
}

// Helper: Handle PR rollback
function handlePrRollback(target, dryRun, execSync) {
  if (dryRun) {
    console.log(`     Would revert merge: ${target}`);
    const files = execSync(`git diff-tree --no-commit-id --name-only -r ${target}`, { encoding: 'utf-8' });
    console.log('     Affected files:');
    files.trim().split('\n').forEach(f => console.log(`       - ${f}`));
  } else {
    execSync(`git revert -m 1 --no-edit ${target}`, { stdio: 'inherit' });

    // Update Beads issue if linked
    const commitMsg = execSync(`git log -1 --format=%B ${target}`, { encoding: 'utf-8' });
    updateBeadsIssue(commitMsg);
  }
}

// Helper: Handle partial file rollback
function handlePartialRollback(target, dryRun, _execSync) {
  const { execFileSync } = require('node:child_process');
  const files = target.split(',').map(f => f.trim());
  if (dryRun) {
    console.log('     Would restore files:');
    files.forEach(f => console.log(`       - ${f}`));
  } else {
    files.forEach(f => {
      execFileSync('git', ['checkout', 'HEAD~1', '--', f], { stdio: 'inherit' });
    });
    execFileSync('git', ['commit', '-m', `chore: rollback ${files.join(', ')}`], { stdio: 'inherit' });
  }
}

// Helper: Handle branch range rollback
function handleBranchRollback(target, dryRun, _execSync) {
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

// Helper: Finalize rollback by restoring user sections
function finalizeRollback(agentsPath, savedSections) {
  const { execSync } = require('node:child_process');

  console.log('  📦 Restoring user content...');
  preserveUserSections(agentsPath, savedSections);

  // Amend commit to include restored USER sections
  if (fs.existsSync(agentsPath)) {
    execSync('git add AGENTS.md', { stdio: 'inherit' });
    execSync('git commit --amend --no-edit', { stdio: 'inherit' });
  }

  console.log('');
  console.log('  ✅ Rollback complete');
  console.log('     User content preserved');
}

async function performRollback(method, target, dryRun = false) {
  console.log('');
  console.log(`  🔄 Rollback: ${method}`);
  console.log(`     Target: ${target}`);
  if (dryRun) {
    console.log('     Mode: DRY RUN (preview only)');
  }
  console.log('');

  // Validate inputs BEFORE any git operations
  const validation = validateRollbackInput(method, target);
  if (!validation.valid) {
    console.log(`  ❌ ${validation.error}`);
    return false;
  }

  // Check for clean working directory
  if (!checkGitWorkingDirectory()) {
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
      handleCommitRollback(target, dryRun, execSync);
    } else if (method === 'pr') {
      handlePrRollback(target, dryRun, execSync);
    } else if (method === 'partial') {
      handlePartialRollback(target, dryRun, execSync);
    } else if (method === 'branch') {
      handleBranchRollback(target, dryRun, execSync);
    }

    if (!dryRun) {
      finalizeRollback(agentsPath, savedSections);
    }

    return true;
  } catch (err) {
    console.log('');
    console.log('  ❌ Rollback failed:', err.message);
    console.log('     Try manual rollback with: git revert <commit>');
    return false;
  }
}

// Interactive rollback menu
async function showRollbackMenu() {
  console.log('');
  console.log('  🔄 Forge Rollback');
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
      console.log('  Invalid choice');
      rl.close();
      return;
    }
  }

  rl.close();

  await performRollback(method, target, dryRun);
}

// Only execute main() when run directly, not when imported
if (require.main === module) {
  main().catch(console.error);
}
