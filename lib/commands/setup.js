'use strict';

/**
 * Setup Command — Extracted from bin/forge.js
 *
 * Contains all setup-related functions: interactive setup, agent configuration,
 * tool installation, external services, dry-run, quick mode, etc.
 *
 * @module commands/setup
 */

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execSync, execFileSync } = require('node:child_process');

// Compute packageDir relative to this file (lib/commands/setup.js -> project root)
const packageDir = path.resolve(__dirname, '..', '..');
const packageJson = require(path.join(packageDir, 'package.json'));
const VERSION = packageJson.version;

// Load PluginManager for discoverable agent architecture
const PluginManager = require('../plugin-manager');
const { scaffoldGithubBeadsSync } = require('../setup');
const { copyEssentialDocs } = require('../docs-copy');
const { secureExecFileSync } = require('../shell-utils');
const { askYesNo: _askYesNoBase } = require('../ui-utils');

// Load enhanced onboarding modules
const contextMerge = require(path.join(packageDir, 'lib', 'context-merge'));
const projectDiscovery = require(path.join(packageDir, 'lib', 'project-discovery'));

// Load lib modules for symlink, beads, and PAT setup
const { createSymlinkOrCopy: libCreateSymlinkOrCopy } = require(path.join(packageDir, 'lib', 'symlink-utils'));
const beadsSetupLib = require(path.join(packageDir, 'lib', 'beads-setup'));
const { beadsHealthCheck } = require(path.join(packageDir, 'lib', 'beads-health-check'));
const { setupPAT } = require(path.join(packageDir, 'lib', 'pat-setup'));
const { detectDefaultBranch, detectBeadsVersion, templateWorkflows, scaffoldBeadsSync } = require(path.join(packageDir, 'lib', 'beads-sync-scaffold'));

// Load incremental setup modules
const { detectEnvironment } = require('../detect-agent');
const { fileMatchesContent } = require('../file-hash');
const { SetupActionLog } = require('../setup-action-log');
const { ActionCollector } = require('../setup-utils');
const { renderSetupSummary } = require('../setup-summary-renderer');
const { smartMergeAgentsMd } = require('../smart-merge');
const { checkLefthookStatus } = require('../lefthook-check');
const { resolveShellRuntime } = require('../runtime-health');
const { listCodexSkillEntries } = require('../codex-skills');
const {
  generateCopilotConfig,
  generateCursorConfig,
  generateKiloConfig,
  generateOpenCodeConfig,
} = require('../agents-config');
const fileUtils = require('../file-utils');
const detectionUtils = require('../detection-utils');
const { detectHusky, migrateHusky } = require('../husky-migration');

// --- Module-level state (deferred from ForgeContext migration) ---
// Follow-up tracked in forge-vi7v: migrate setup state to a ForgeContext instance passed via handler args.
// Setup's ~100 functions reference these globals extensively; converting all
// call sites is a separate task to avoid scope creep in the extraction PR.
let projectRoot = process.env.INIT_CWD || process.cwd();
let FORCE_MODE = false;
let VERBOSE_MODE = false;
let NON_INTERACTIVE = false;
let SYMLINK_ONLY = false;
let SYNC_ENABLED = false;
let actionLog = new SetupActionLog();
let PKG_MANAGER = 'npm';

/**
 * Load agent definitions from plugin architecture
 * (Duplicated from bin/forge.js to keep setup self-contained)
 */
function loadAgentsFromPlugins() {
  const pluginManager = new PluginManager();
  const agents = {};
  pluginManager.getAllPlugins().forEach((plugin, id) => {
    agents[id] = {
      name: plugin.name,
      description: plugin.description || '',
      dirs: Object.values(plugin.directories || {}),
      hasCommands: plugin.capabilities?.commands || plugin.setup?.copyCommands || false,
      hasSkill: plugin.capabilities?.skills || plugin.setup?.createSkill || false,
      linkFile: plugin.files?.rootConfig || '',
      customSetup: plugin.setup?.customSetup || '',
      supportStatus: plugin.support?.status || 'supported',
      needsConversion: plugin.setup?.needsConversion || false,
      copyCommands: plugin.setup?.copyCommands || false,
      promptFormat: plugin.setup?.promptFormat || false
    };
  });
  return agents;
}

const AGENTS = loadAgentsFromPlugins();
Object.freeze(AGENTS);
Object.values(AGENTS).forEach(agent => Object.freeze(agent));

/**
 * Safe exec helper (duplicated from bin/forge.js)
 */
function safeExec(cmd, opts = {}) {
  try {
    return execSync(cmd, { stdio: 'pipe', ...opts }).toString().trim();
  } catch (_e) { // NOSONAR — intentional: safeExec returns empty string on any failure
    return '';
  }
}

/**
 * Detect package manager
 */
function detectPackageManager() {
  if (fs.existsSync(path.join(projectRoot, 'bun.lockb')) || fs.existsSync(path.join(projectRoot, 'bun.lock'))) return 'bun';
  if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/**
 * Reads workflow command names from commands/*.md in the package directory.
 * Falls back to .claude/commands/ if commands/ does not exist (backwards compat).
 * @returns {string[]} Command names (filenames without .md extension)
 */
function getWorkflowCommands() {
  const canonicalDir = path.join(packageDir, 'commands');
  const commandsDir = fs.existsSync(canonicalDir)
    ? canonicalDir
    : path.join(packageDir, '.claude', 'commands');
  try {
    return fs.readdirSync(commandsDir)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace(/\.md$/, ''));
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.warn(`Warning: commands directory not found at ${commandsDir}`);
    } else {
      console.warn(`Warning: failed to read commands — ${err.code}: ${err.message}`);
    }
    return [];
  }
}

const WORKFLOW_RUNTIME_ASSETS = Object.freeze([
  'scripts/beads-context.sh',
  'scripts/conflict-detect.sh',
  'scripts/dep-guard-analyze.js',
  'scripts/dep-guard.sh',
  'scripts/file-index.sh',
  'scripts/pr-coordinator.sh',
  'scripts/smart-status.sh',
  'scripts/sync-utils.sh',
  'scripts/validate.sh',
  'scripts/lib/jsonl-lock.sh',
  'scripts/lib/sanitize.sh',
  'scripts/forge-team/index.sh',
  'scripts/forge-team/lib/agent-prompt.sh',
  'scripts/forge-team/lib/claim.sh',
  'scripts/forge-team/lib/dashboard.sh',
  'scripts/forge-team/lib/epic.sh',
  'scripts/forge-team/lib/hooks.sh',
  'scripts/forge-team/lib/identity.sh',
  'scripts/forge-team/lib/sync-github.sh',
  'scripts/forge-team/lib/verify.sh',
  'scripts/forge-team/lib/workload.sh',
  '.claude/scripts/greptile-resolve.sh'
]);

/**
 * Validate agent names against known AGENTS.
 * @param {string} agentList - Comma-separated agent names
 * @returns {string[]} Valid agent names
 */
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

// Prerequisite check function
function checkPrerequisites(options = {}) {
  const requireGithubCli = options.requireGithubCli !== false;
  const requireBeadsCli = options.requireBeadsCli === true;
  const requireJq = options.requireJq === true;
  const commandRunner = options.commandRunner || safeExec;
  const errors = [];
  const warnings = [];

  console.log('');
  console.log('Checking prerequisites...');
  console.log('');

  // Check git
  const gitVersion = commandRunner('git --version');
  if (gitVersion) {
    console.log(`  ✓ ${gitVersion}`);
  } else {
    errors.push('git - Install from https://git-scm.com');
  }

  // Check GitHub CLI
  const ghVersion = commandRunner('gh --version');
  if (ghVersion) {
    const firstLine = ghVersion.split('\n')[0];
    console.log(`  ✓ ${firstLine}`);
    // Check if authenticated
    const authStatus = commandRunner('gh auth status');
    if (!authStatus) {
      warnings.push('GitHub CLI not authenticated. Run: gh auth login');
    }
  } else {
    const message = 'gh (GitHub CLI) - Install from https://cli.github.com';
    if (requireGithubCli) {
      errors.push(message);
    } else {
      warnings.push(`${message} (required later for GitHub-integrated workflow steps)`);
    }
  }

  const bdVersion = commandRunner('bd --version');
  if (bdVersion) {
    console.log(`  ✓ ${bdVersion.split('\n')[0]}`);
  } else if (requireBeadsCli) {
    errors.push('bd (Beads CLI) - Install from https://github.com/steveyegge/beads');
  }

  // Check Node.js version
  const nodeVersion = Number.parseInt(process.version.slice(1).split('.')[0]);
  if (nodeVersion >= 20) {
    console.log(`  ✓ node ${process.version}`);
  } else {
    errors.push(`Node.js 20+ required (current: ${process.version})`);
  }

  const jqVersion = commandRunner('jq --version');
  if (jqVersion) {
    console.log(`  âœ“ ${jqVersion.split('\n')[0]}`);
  } else if (requireJq) {
    errors.push('jq - Install from https://jqlang.org/download/');
  }

  // Detect package manager
  detectPackageManager();

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
description: 7-stage TDD-first workflow for feature development. Use when building features, fixing bugs, or shipping PRs.
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

## 7 Stages

| Stage | Command | Description |
|-------|---------|-------------|
| utility | \`/status\` | Check current context, active work, recent completions |
| 1 | \`/plan\` | Design intent -> research -> branch + worktree + task list |
| 2 | \`/dev\` | TDD development (implementer -> spec review -> quality review) |
| 3 | \`/validate\` | Type check, lint, security, tests - all fresh output |
| 4 | \`/ship\` | Push branch and create PR with full documentation |
| 5 | \`/review\` | Address ALL PR feedback (GitHub Actions, Greptile, SonarCloud) |
| 6 | \`/premerge\` | Update docs, hand off PR to user |
| 7 | \`/verify\` | Post-merge health check (CI on main, close Beads) |

## Workflow Flow

\`\`\`
/status -> /plan -> /dev -> /validate -> /ship -> /review -> /premerge -> /verify
\`\`\`

## Core Principles

- **TDD-First**: Write tests BEFORE implementation (RED-GREEN-REFACTOR)
- **Research-First**: Understand before building, document decisions
- **Security Built-In**: OWASP Top 10 analysis for every feature
- **Documentation Progressive**: Update at each stage, verify at end
`;

// Helper functions



// Helper functions

function ensureDir(dir) {
  return fileUtils.ensureDir(dir, projectRoot);
}



function writeFile(filePath, content) {
  return fileUtils.writeFile(filePath, content, projectRoot);
}



function readFile(filePath) {
  return fileUtils.readFile(filePath);
}



function copyFile(src, dest) { // NOSONAR — Extracted as-is from bin/forge.js; complexity reduction deferred
  try {
    const destPath = path.resolve(projectRoot, dest);
    const resolvedProjectRoot = path.resolve(projectRoot);

    // SECURITY: Prevent path traversal
    if (!destPath.startsWith(resolvedProjectRoot)) {
      console.error(`  ✗ Security: Copy destination escape blocked: ${dest}`);
      return false;
    }

    if (fs.existsSync(src)) {
      // Content-hash comparison: skip if destination already matches source
      if (!FORCE_MODE) {
        const sourceContent = fs.readFileSync(src, 'utf8');
        if (fileMatchesContent(destPath, sourceContent)) {
          actionLog.add(dest, 'skipped', 'identical content');
          return true;
        }
      }

      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
      }
      const isNew = !fs.existsSync(destPath);
      fs.copyFileSync(src, destPath);
      let action;
      if (FORCE_MODE) {
        action = 'force-created';
      } else {
        action = isNew ? 'created' : 'updated';
      }
      actionLog.add(dest, action);
      return true;
    } else {
      console.warn(`  ⚠ Source file not found: ${src}`);
    }
  } catch (err) {
    console.error(`  ✗ Failed to copy ${src} -> ${dest}: ${err.message}`);
  }
  return false;
}

function needsWorkflowRuntimeAssets(selectedAgents) {
  return selectedAgents.some((agentKey) => {
    const agent = AGENTS[agentKey];
    return Boolean(agent && (agent.hasCommands || agent.needsConversion || agent.copyCommands || agent.promptFormat));
  });
}

function getWorkflowRuntimeAssets() {
  return [...WORKFLOW_RUNTIME_ASSETS];
}

function findMissingWorkflowRuntimeAssets(targetRoot = projectRoot, selectedAgents = Object.keys(AGENTS)) {
  if (!needsWorkflowRuntimeAssets(selectedAgents)) {
    return [];
  }

  return WORKFLOW_RUNTIME_ASSETS.filter((relativePath) => !fs.existsSync(path.join(targetRoot, relativePath)));
}

function resolveConfiguredWorkflowAgents(targetRoot = projectRoot) {
  const configuredAgents = detectConfiguredAgents(targetRoot)
    .map(normalizeDetectedAgent)
    .filter((agentName) => AGENTS[agentName]);

  return configuredAgents.length > 0 ? configuredAgents : Object.keys(AGENTS);
}

function scaffoldWorkflowRuntimeAssets(selectedAgents) {
  if (!needsWorkflowRuntimeAssets(selectedAgents)) {
    return [];
  }

  for (const relativePath of WORKFLOW_RUNTIME_ASSETS) {
    const sourcePath = path.join(packageDir, relativePath);
    copyFile(sourcePath, relativePath);
  }

  return findMissingWorkflowRuntimeAssets(projectRoot, selectedAgents);
}

function ensureWorkflowRuntimeAssets(selectedAgents) {
  const missingAssets = scaffoldWorkflowRuntimeAssets(selectedAgents);
  if (missingAssets.length > 0) {
    throw new Error(`setup is incomplete: missing workflow runtime assets: ${missingAssets.join(', ')}`);
  }
}

function repairWorkflowRuntimeAssets(targetRoot = projectRoot, selectedAgents = null) {
  const agents = selectedAgents && selectedAgents.length > 0
    ? selectedAgents
    : resolveConfiguredWorkflowAgents(targetRoot);

  const missingBefore = findMissingWorkflowRuntimeAssets(targetRoot, agents);
  if (missingBefore.length === 0) {
    return { attempted: false, agents, repaired: [], missing: [] };
  }

  const previousRoot = projectRoot;
  projectRoot = targetRoot;
  try {
    const missingAfter = scaffoldWorkflowRuntimeAssets(agents);
    return {
      attempted: true,
      agents,
      repaired: missingBefore.filter((assetPath) => !missingAfter.includes(assetPath)),
      missing: missingAfter,
    };
  } finally {
    projectRoot = previousRoot;
  }
}

async function repairRuntimeReadiness(selectedAgents = null, options = {}) {
  const targetRoot = options.projectRoot || projectRoot;
  const agents = selectedAgents && selectedAgents.length > 0
    ? selectedAgents
    : resolveConfiguredWorkflowAgents(targetRoot);
  const previousRoot = projectRoot;
  const previousInteractive = NON_INTERACTIVE;

  projectRoot = targetRoot;
  NON_INTERACTIVE = true;

  try {
    const shellPolicy = ensureWorkflowShellPolicy(agents, options);
    const runtimeAssets = repairWorkflowRuntimeAssets(targetRoot, agents);

    if (options.installLefthook !== false) {
      repairDeclaredLefthookDependency(agents);
    }
    if (options.migrateHusky !== false) {
      await handleHuskyMigration();
    }
    if (options.installHooks !== false) {
      installGitHooks();
    }

    return {
      agents,
      shellPolicy,
      ...runtimeAssets,
    };
  } finally {
    projectRoot = previousRoot;
    NON_INTERACTIVE = previousInteractive;
  }
}

function resolveWorkflowShellPolicy(selectedAgents, options = {}) {
  const platform = options.platform || process.platform;

  if (!needsWorkflowRuntimeAssets(selectedAgents)) {
    return {
      required: false,
      available: true,
      platform,
      policy: platform === 'win32' ? 'git-bash' : 'system-shell',
      command: platform === 'win32' ? null : 'sh',
      message: ''
    };
  }

  const shellOptions = { platform };
  if (Object.hasOwn(options, 'candidates')) {
    shellOptions.candidates = options.candidates;
  }
  if (typeof options._exists === 'function') {
    shellOptions._exists = options._exists;
  }
  if (typeof options._canExecute === 'function') {
    shellOptions._canExecute = options._canExecute;
  }

  return {
    required: true,
    ...resolveShellRuntime(shellOptions)
  };
}

function ensureWorkflowShellPolicy(selectedAgents, options = {}) {
  const shellPolicy = resolveWorkflowShellPolicy(selectedAgents, options);

  if (shellPolicy.required && shellPolicy.platform === 'win32' && !shellPolicy.available) {
    throw new Error(
      shellPolicy.message || 'Git Bash is required on Windows for Forge workflow helper scripts.'
    );
  }

  return shellPolicy;
}



function createSymlinkOrCopy(source, target, options = {}) {
  const fullSource = path.resolve(projectRoot, source);
  const fullTarget = path.resolve(projectRoot, target);
  const resolvedProjectRoot = path.resolve(projectRoot);

  // SECURITY: Prevent path traversal attacks
  if (!fullSource.startsWith(resolvedProjectRoot)) {
    console.error(`  ✗ Security: Source path escape blocked: ${source}`);
    return '';
  }
  if (!fullTarget.startsWith(resolvedProjectRoot)) {
    console.error(`  ✗ Security: Target path escape blocked: ${target}`);
    return '';
  }

  // Delegate to lib/symlink-utils after security validation
  return libCreateSymlinkOrCopy(fullSource, fullTarget, options);
}

function shouldLinkAgentsMd(agent) {
  if (!agent?.linkFile) return false;
  return !['copilot', 'opencode'].includes(agent.customSetup);
}



function stripFrontmatter(content) {
  return fileUtils.stripFrontmatter(content);
}

// Read existing .env.local


// Read existing .env.local (thin wrapper preserved for potential external callers)
function _readEnvFile() {
  return fileUtils.readEnvFile(projectRoot);
}

// Parse .env.local and return key-value pairs


// Parse .env.local and return key-value pairs
function parseEnvFile() {
  return fileUtils.parseEnvFile(projectRoot);
}

// Write or update .env.local - PRESERVES existing values


// Write or update .env.local - PRESERVES existing values
function writeEnvTokens(tokens, preserveExisting = true) {
  return fileUtils.writeEnvTokens(tokens, projectRoot, preserveExisting);
}

// Detect existing project installation status
// Smart merge for AGENTS.md - extracted to lib/smart-merge.js for testability

// Helper function for yes/no prompts with validation
// askYesNo — wrapper around lib/ui-utils.js that passes NON_INTERACTIVE global


// Detect existing project installation status
// Smart merge for AGENTS.md - extracted to lib/smart-merge.js for testability

// Helper function for yes/no prompts with validation
// askYesNo — wrapper around lib/ui-utils.js that passes NON_INTERACTIVE global
async function askYesNo(question, prompt, defaultNo = true) {
  return _askYesNoBase(question, prompt, defaultNo, NON_INTERACTIVE);
}



async function detectProjectStatus() {
  const status = {
    type: 'fresh', // 'fresh', 'upgrade', or 'partial'
    hasAgentsMd: fs.existsSync(path.join(projectRoot, 'AGENTS.md')),
    hasClaudeMd: fs.existsSync(path.join(projectRoot, 'CLAUDE.md')),
    hasClaudeCommands: fs.existsSync(path.join(projectRoot, '.claude/commands')),
    hasEnvLocal: fs.existsSync(path.join(projectRoot, '.env.local')),
    existingEnvVars: {},
    agentsMdSize: 0,
    claudeMdSize: 0,
    agentsMdLines: 0,
    claudeMdLines: 0,
    // Project tools status
    hasBeads: isBeadsInitialized(),
    hasSkills: isSkillsInitialized(),
    beadsInstallType: checkForBeads(),
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
  if (status.hasAgentsMd && status.hasClaudeCommands) {
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

// Detection helpers — delegated to lib/detection-utils.js


// Detection helpers — delegated to lib/detection-utils.js
function detectTestFramework(deps) { return detectionUtils.detectTestFramework(deps); }

function detectLanguageFeatures(pkg) { return detectionUtils.detectLanguageFeatures(pkg, projectRoot); }

function detectNextJs(deps) { return detectionUtils.detectNextJs(deps); }

function detectNestJs(deps) { return detectionUtils.detectNestJs(deps); }

function detectAngular(deps) { return detectionUtils.detectAngular(deps); }

function detectVue(deps) { return detectionUtils.detectVue(deps); }

function detectReact(deps) { return detectionUtils.detectReact(deps); }

function detectExpress(deps, features) { return detectionUtils.detectExpress(deps, features); }

function detectFastify(deps, features) { return detectionUtils.detectFastify(deps, features); }

function detectSvelte(deps) { return detectionUtils.detectSvelte(deps); }

function detectRemix(deps) { return detectionUtils.detectRemix(deps); }

function detectAstro(deps) { return detectionUtils.detectAstro(deps); }

function detectGenericNodeJs(pkg, deps, features) { return detectionUtils.detectGenericNodeJs(pkg, deps, features); }

// Helper: Detect generic JavaScript/TypeScript project (fallback)


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
  } catch (_err) { // NOSONAR - S2486: Returns null on invalid/missing package.json
    return null;
  }
}

// Detect project type from package.json


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


// Helper: Calculate estimated tokens (rough: ~4 chars per token)
function estimateTokens(bytes) {
  return Math.ceil(bytes / 4);
}

// Helper: Create instruction files result object


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

// Prompt for code review tool selection - extracted to reduce cognitive complexity


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

// Helper: Display Context7 MCP status for selected agents - extracted to reduce cognitive complexity


// Helper: Display Context7 MCP status for selected agents - extracted to reduce cognitive complexity
function displayMcpStatus(selectedAgents) {
  console.log('');
  console.log('Context7 MCP - Library Documentation');
  console.log('-------------------------------------');
  console.log('Provides up-to-date library docs for AI coding agents.');
  console.log('');

  // Show what was/will be auto-installed
  if (selectedAgents.includes('claude')) {
    console.log('  ✓ Auto-installed for Claude Code (.mcp.json)');
  }
  // Show manual setup instructions for GUI-based agents
  const manualMcpMap = {
    cursor: 'Cursor: Configure via Cursor Settings > MCP',
    cline: 'Cline: Install via MCP Marketplace',
  };
  const needsManualMcp = Object.entries(manualMcpMap)
    .filter(([key]) => selectedAgents.includes(key))
    .map(([, msg]) => msg);

  if (needsManualMcp.length > 0) {
    needsManualMcp.forEach(msg => console.log(`  ! ${msg}`));
    console.log('');
    console.log('  Package: @upstash/context7-mcp@latest');
    console.log('  Docs: https://github.com/upstash/context7-mcp');
  }
}

// Helper: Display env token write results - extracted to reduce cognitive complexity


// Helper: Display env token write results - extracted to reduce cognitive complexity
function displayEnvTokenResults(added, preserved) {
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

// Configure external services interactively


// Configure external services interactively
async function configureExternalServices(rl, question, selectedAgents = [], projectStatus = null) { // NOSONAR — Extracted as-is from bin/forge.js; complexity reduction deferred
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

  // Context7 MCP - Library Documentation
  displayMcpStatus(selectedAgents);

  // Save package manager preference
  tokens['PKG_MANAGER'] = PKG_MANAGER;

  // Write all tokens to .env.local (preserving existing values)
  const { added, preserved } = writeEnvTokens(tokens, true);
  displayEnvTokenResults(added, preserved);

  // GitHub-Beads issue sync setup
  console.log('');
  const enableSync = await askYesNo(question, 'Enable GitHub ↔ Beads issue sync?', true);
  if (enableSync) {
    try {
      const result = await scaffoldGithubBeadsSync(projectRoot, packageDir);
      for (const f of result.created) {
        console.log(`  Created: ${f}`);
      }
      for (const f of result.skipped) {
        console.log(`  Skipped: ${f} (already exists)`);
      }

      // PAT setup guidance for Beads sync (non-fatal)
      // Skip if --sync flag is set — handleSyncScaffold will handle PAT setup
      if (!SYNC_ENABLED) {
        try {
          const patResult = setupPAT(projectRoot, { interactive: !NON_INTERACTIVE });
          if (patResult.success) {
            console.log('  ✓ Beads sync PAT configured');
          } else if (patResult.reminder) {
            console.log(`  ℹ ${patResult.reminder}`);
          } else if (patResult.instructions) {
            console.log(`  ℹ ${patResult.instructions.split('\n')[0]}`);
          }
        } catch (_patErr) { // NOSONAR — best-effort PAT setup, non-fatal
          // PAT setup is best-effort — don't block sync scaffold
        }
      }
    } catch (err) {
      console.error(`  Error scaffolding GitHub-Beads sync: ${err.message}`);
    }
  }
}

// Display the Forge banner


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

/**
 * Creates a directory on first use and prints a one-time purpose note.
 * Delegates to lib/file-utils.js.
 * @param {string} dir - Absolute path to the directory to create.
 * @param {string} purpose - Human-readable purpose description.
 * @returns {string|null} Purpose message if created, null if already existed.
 */


/**
 * Creates a directory on first use and prints a one-time purpose note.
 * Delegates to lib/file-utils.js.
 * @param {string} dir - Absolute path to the directory to create.
 * @param {string} purpose - Human-readable purpose description.
 * @returns {string|null} Purpose message if created, null if already existed.
 */
function ensureDirWithNote(dir, purpose) { // eslint-disable-line no-unused-vars -- exported via module.exports
  return fileUtils.ensureDirWithNote(dir, purpose);
}

// Setup core documentation and directories


// Setup core documentation and directories
function setupCoreDocs() {
  // docs/planning/ and docs/research/ are created lazily on first use
  // by /plan Phase 1 and Phase 2 respectively, via ensureDirWithNote().
  // TEMPLATE.md and PROGRESS.md are also deferred to first use.

  // Copy essential docs (TOOLCHAIN.md, VALIDATION.md) to consumer's docs/forge/
  const result = copyEssentialDocs(projectRoot, packageDir);
  for (const f of result.created) {
    console.log(`  Created: ${f}`);
  }
  for (const f of result.skipped) {
    if (VERBOSE_MODE) {
      console.log(`  Skipped: ${f} (already exists)`);
    }
  }
}

// Minimal installation (postinstall)


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
  console.log('  bunx forge setup --agents claude,cursor');
  console.log('  bunx forge setup --all');
  console.log('');
}

// Helper: Setup Claude agent


// Helper: Setup Claude agent
function setupClaudeAgent(skipFiles = {}) {
  // Copy commands from package (unless skipped)
  if (skipFiles.claudeCommands) {
    console.log('  Skipped: .claude/commands/ (keeping existing)');
  } else {
    const cmds = getWorkflowCommands();
    let copied = 0;
    cmds.forEach(cmd => {
      const src = path.join(packageDir, `.claude/commands/${cmd}.md`);
      if (copyFile(src, `.claude/commands/${cmd}.md`)) copied++;
    });
    console.log(`  Copied: ${copied} workflow commands`);
  }

  // Copy rules
  const rulesSrc = path.join(packageDir, '.claude/rules/workflow.md');
  copyFile(rulesSrc, '.claude/rules/workflow.md');

  // Copy scripts
  const scriptSrc = path.join(packageDir, '.claude/scripts/load-env.sh');
  copyFile(scriptSrc, '.claude/scripts/load-env.sh');
}

// Helper: Setup Cursor agent


// Helper: Setup Cursor agent
async function setupCursorAgent() {
  await generateCursorConfig(projectRoot, { overwrite: false });
  console.log('  Created: Cursor native rules');
}

async function setupKiloAgent() {
  await generateKiloConfig(projectRoot, { overwrite: false });
  console.log('  Created: Kilo native workflow files');
}

async function setupCopilotAgent() {
  await generateCopilotConfig(projectRoot, { overwrite: false });
  console.log('  Created: Copilot native config');
}

async function setupOpenCodeAgent() {
  await generateOpenCodeConfig(projectRoot, { overwrite: false });
  console.log('  Created: OpenCode native config');
}

// Helper: Convert command to agent-specific format


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

  return { targetFile, targetContent };
}

// Helper: Copy commands for agent


// Helper: Copy commands for agent
function copyAgentCommands(agent, claudeCommands) {
  if (!claudeCommands) return;
  if (!agent.needsConversion && !agent.copyCommands && !agent.promptFormat) return;

  Object.entries(claudeCommands).forEach(([cmd, content]) => {
    const { targetFile, targetContent } = convertCommandToAgentFormat(cmd, content, agent);
    const targetDir = agent.dirs[0]; // First dir is commands/workflows
    writeFile(`${targetDir}/${targetFile}`, targetContent);
  });
  console.log(`  Converted: ${Object.keys(claudeCommands).length} workflow commands`);
}

// Helper: Copy rules for agent


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


// Helper: Create skill file for agent
function createAgentSkill(agent, agentKey) {
  if (agentKey === 'codex') {
    createCodexSkills();
    return;
  }

  if (!agent.hasSkill) return;

  const skillDir = agent.dirs.find(d => d.includes('/skills/'));
  if (skillDir) {
    writeFile(`${skillDir}/SKILL.md`, SKILL_CONTENT);
    console.log('  Created: forge-workflow skill');
  }
}

// Helper: Create Codex per-stage skills from canonical commands
function createCodexSkills() {
  const entries = listCodexSkillEntries(packageDir);

  for (const entry of entries) {
    writeFile(path.join(entry.dir, entry.filename), entry.content);
  }

  if (entries.length > 0) {
    console.log(`  Created: Codex stage skills (${entries.length})`);
  }
}

// Helper: Setup MCP config for Claude


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

// Helper: Create agent link file
// When symlinkOnly is true (--symlink flag), skip copy fallback


// Helper: Create agent link file
// When symlinkOnly is true (--symlink flag), skip copy fallback
function createAgentLinkFile(agent, symlinkOnly = false) {
  if (!shouldLinkAgentsMd(agent)) return;

  const result = createSymlinkOrCopy('AGENTS.md', agent.linkFile, { symlinkOnly });
  if (result) {
    console.log(`  ${result === 'linked' ? 'Linked' : 'Copied'}: ${agent.linkFile}`);
  }
}

// Setup specific agent


// Setup specific agent
async function setupAgent(agentKey, claudeCommands, skipFiles = {}) {
  const agent = AGENTS[agentKey];
  if (!agent) return;

  console.log(`\nSetting up ${agent.name}...`);
  if (agent.supportStatus === 'deprecated') {
    console.log(`  Warning: ${agent.name} is in deprecated compatibility mode; Forge will scaffold converted workflow files only.`);
  }

  // Create directories
  agent.dirs.forEach(dir => ensureDir(dir));

  // Handle agent-specific setup
  if (agentKey === 'claude') {
    setupClaudeAgent(skipFiles);
  }

  if (agent.customSetup === 'cursor') {
    await setupCursorAgent();
  }

  if (agentKey === 'kilocode') {
    await setupKiloAgent();
  }

  if (agentKey === 'copilot') {
    await setupCopilotAgent();
  }

  if (agentKey === 'opencode') {
    await setupOpenCodeAgent();
  }

  // Convert/copy commands
  copyAgentCommands(agent, claudeCommands);

  // Copy rules if needed
  copyAgentRules(agent);

  // Create SKILL.md or Codex stage skills
  createAgentSkill(agent, agentKey);

  // Setup MCP configs
  if (agentKey === 'claude') {
    setupClaudeMcpConfig();
  }

  // Create link file (SYMLINK_ONLY = --symlink flag disables copy fallback)
  createAgentLinkFile(agent, SYMLINK_ONLY);
}


// =============================================
// Helper Functions for Interactive Setup
// =============================================

/**
 * Display existing installation status
 */



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
  console.log('');
}

/**
 * Handle AGENTS.md file without markers - offers 3 options
 * Extracted to reduce cognitive complexity
 */


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

  getWorkflowCommands().forEach(cmd => {
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
 * Delegates to setupSelectedAgents to avoid duplicate implementations (S4144)
 */


/**
 * Setup agents with progress indication
 * Delegates to setupSelectedAgents to avoid duplicate implementations (S4144)
 */
async function setupAgentsWithProgress(selectedAgents, claudeCommands, skipFiles) {
  await setupSelectedAgents(selectedAgents, claudeCommands, skipFiles);
}

/**
 * Display final setup summary
 */


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

  const workflowCount = getWorkflowCommands().length;
  selectedAgents.forEach(key => {
    const agent = AGENTS[key];
    if (agent.linkFile) {
      console.log(`  - ${agent.linkFile} (${agent.name})`);
    }
    if (agent.hasCommands && key === 'claude') {
      console.log(`  - .claude/commands/ (${workflowCount} workflow commands)`);
    } else if (agent.hasCommands && key !== 'codex' && agent.dirs[0]) {
      console.log(`  - ${agent.dirs[0]}/ (${workflowCount} workflow commands)`);
    }
    if (key === 'codex') {
      const skillCount = listCodexSkillEntries(packageDir).length;
      console.log(`  - .codex/skills/<stage>/SKILL.md (${skillCount} stage skills)`);
    } else if (agent.hasSkill) {
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
  checkPrerequisites({ requireJq: true });
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
      await setupAgent('claude', null, skipFiles);
    }
    // Then load the commands
    claudeCommands = loadClaudeCommands(selectedAgents);
  }

  // Setup each selected agent with progress indication
  await setupAgentsWithProgress(selectedAgents, claudeCommands, skipFiles);

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


// Detect Husky and offer migration to Lefthook
// Called before installGitHooks() in setup flows
async function handleHuskyMigration() {
  const detection = detectHusky(projectRoot);
  if (!detection.found) return;

  console.log('Husky detected — migrating to Lefthook...');

  // In interactive mode, ask the user before proceeding
  if (!NON_INTERACTIVE) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));
    const userApproved = await askYesNo(question, 'Migrate Husky hooks to Lefthook?', false);
    rl.close();
    if (!userApproved) {
      console.log('  Skipped Husky migration (user declined)');
      console.log('');
      return;
    }
  }

  const result = migrateHusky(projectRoot, { nonInteractive: true });

  if (result.success) {
    console.log(`  Migrated ${result.mappedCount} hook(s) to lefthook.yml`);
    if (result.unmappedCount > 0) {
      console.warn(`  ${result.unmappedCount} hook(s) could not be auto-mapped:`);
      for (const w of result.warnings) {
        console.warn(`    - ${w}`);
      }
    }
    if (result.hooksPathUnset) {
      console.log('  Unset core.hooksPath git config');
    }
    console.log('  Removed .husky/ directory');
    console.log('');
  } else {
    // Validation failed (e.g. symlink detected)
    for (const w of result.warnings) {
      console.warn(`  ${w}`);
    }
    console.log('');
  }
}

// Install git hooks via lefthook
// SECURITY: Uses execSync with HARDCODED strings only (no user input)


// Install git hooks via lefthook
// SECURITY: Uses execSync with HARDCODED strings only (no user input)
function installGitHooks() { // NOSONAR — Extracted as-is from bin/forge.js; complexity reduction deferred
  console.log('Installing git hooks (TDD enforcement)...');

  // Skip lefthook.yml creation if binary is not available
  const lefthookStatus = checkLefthookStatus(projectRoot);
  if (!lefthookStatus.binaryAvailable) {
    if (lefthookStatus.message) {
      console.warn(`  \u26A0 Skipping lefthook setup: ${lefthookStatus.message}`);
    } else {
      console.warn('  \u26A0 Skipping lefthook setup: binary not available');
    }
    return;
  }

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
          fs.chmodSync(hookTarget, 0o755); // NOSONAR — 755 is intentional: git hooks must be executable
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

// Check if lefthook is already installed in project (delegates to lib/lefthook-check)


// Check if lefthook is already installed in project (delegates to lib/lefthook-check)
function checkForLefthook() {
  const status = checkLefthookStatus(projectRoot);
  if (status.installed && !status.binaryAvailable) {
    console.warn(`  \u26A0 ${status.message}`);
  }
  return status;
}

function repairDeclaredLefthookDependency(selectedAgents) {
  if (!needsWorkflowRuntimeAssets(selectedAgents)) {
    return { attempted: false, repaired: false, reason: 'workflow-hooks-not-required' };
  }

  const status = checkLefthookStatus(projectRoot);
  if (!status.installed || status.binaryAvailable) {
    return {
      attempted: false,
      repaired: false,
      reason: status.binaryAvailable ? 'binary-present' : 'dependency-not-declared'
    };
  }

  console.log('Installing lefthook dependencies (binary missing)...');
  try {
    secureExecFileSync(PKG_MANAGER, ['install'], { stdio: 'inherit', cwd: projectRoot });
    console.log('  ✓ Lefthook binary restored');
    console.log('');
    return { attempted: true, repaired: true };
  } catch (err) {
    console.warn('Lefthook install failed:', err.message);
    console.log(`  ⚠ ${status.message}`);
    console.log('');
    return { attempted: true, repaired: false, error: err };
  }
}

// Check if Beads is installed (global, local, or bunx-capable)


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
// Check if Beads is initialized in project — delegates to lib/beads-setup

// Check if Beads is initialized in project — delegates to lib/beads-setup
function isBeadsInitialized() {
  return beadsSetupLib.isBeadsInitialized(projectRoot);
}

// Initialize Beads in the project using the defensive safeBeadsInit wrapper
// Handles config/gitignore writes, hook snapshot/restore, and JSONL pre-seeding


// Initialize Beads in the project using the defensive safeBeadsInit wrapper
// Handles config/gitignore writes, hook snapshot/restore, and JSONL pre-seeding
function initializeBeads(installType) {
  console.log('Initializing Beads in project...');

  // Build the execBdInit function based on installType
  const execBdInit = (root) => {
    // SECURITY: execFileSync with hardcoded commands
    if (installType === 'global') {
      secureExecFileSync('bd', ['init'], { stdio: 'inherit', cwd: root });
    } else if (installType === 'bunx') {
      secureExecFileSync('bunx', ['@beads/bd', 'init'], { stdio: 'inherit', cwd: root });
    } else if (installType === 'local') {
      secureExecFileSync('npx', ['bd', 'init'], { stdio: 'inherit', cwd: root });
    }
  };

  // Derive prefix from package.json name or directory name
  let prefix;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
    prefix = pkg.name || path.basename(projectRoot);
  } catch (_e) { // NOSONAR — fallback to directory name if package.json unreadable
    prefix = path.basename(projectRoot);
  }

  try {
    const result = beadsSetupLib.safeBeadsInit(projectRoot, {
      prefix,
      execBdInit,
      restoreLefthook: (root) => {
        try {
          secureExecFileSync('lefthook', ['install'], { stdio: 'ignore', cwd: root });
        } catch (_e) { // NOSONAR — lefthook may not be installed yet, non-fatal
          // lefthook may not be installed yet — non-fatal
        }
      }
    });

    if (result.skipped) {
      console.log('  ✓ Beads already initialized');
      return true;
    }

    if (!result.success) {
      for (const e of result.errors) {
        console.log(`  ⚠ ${e}`);
      }
      console.log('  Run manually: bd init');
      return false;
    }

    for (const w of result.warnings) {
      console.warn(`  ⚠ ${w}`);
    }
    console.log('  ✓ Beads initialized');

    // Run post-init health check (non-fatal)
    try {
      const health = beadsHealthCheck(projectRoot);
      if (health.healthy) {
        console.log('  ✓ Beads health check passed');
      } else {
        console.log(`  ⚠ Beads health check failed at ${health.failedStep}: ${health.error}`);
      }
    } catch (_healthErr) { // NOSONAR — health check is best-effort, non-fatal
      // Health check is best-effort — don't block setup
    }

    return true;
  } catch (err) {
    console.log('  ⚠ Failed to initialize Beads:', err.message);
    console.log('  Run manually: bd init');
    return false;
  }
}

// Check if Skills CLI is installed


// Check if Skills CLI is installed
function checkForSkills() {
  // Try global install first
  try {
    secureExecFileSync('skills', ['--version'], { stdio: 'ignore' });
    return 'global';
  } catch (_err) { // NOSONAR - S2486: Expected when Skills is not installed globally
  }

  // Check if bunx can run it
  try {
    secureExecFileSync('bunx', ['@forge/skills', '--version'], { stdio: 'ignore' });
    return 'bunx';
  } catch (_err) { // NOSONAR - S2486: Expected when Skills is not available via bunx
  }

  // Check local project installation
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const isInstalled = pkg.devDependencies?.['@forge/skills'] || pkg.dependencies?.['@forge/skills'];
    return isInstalled ? 'local' : null;
  } catch (_err) { // NOSONAR - S2486: Returns null on malformed package.json
    return null;
  }
}

// Check if Skills is initialized in project


// Check if Skills is initialized in project
function isSkillsInitialized() {
  return fs.existsSync(path.join(projectRoot, '.skills'));
}

// Initialize Skills in the project


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

// Helper: Install tool via bunx - extracted to reduce cognitive complexity


// Helper: Install tool via bunx - extracted to reduce cognitive complexity
function installViaBunx(packageName, versionArgs, initFn, toolName) {
  console.log('Testing bunx capability...');
  try {
    secureExecFileSync('bunx', [packageName, ...versionArgs], { stdio: 'ignore' });
    console.log('  ✓ Bunx is available');
    initFn('bunx');
  } catch (err) {
    console.warn(`${toolName} bunx test failed:`, err.message);
    console.log('  ⚠ Bunx not available. Install bun first: curl -fsSL https://bun.sh/install | bash');
  }
}

// Helper: Install Beads with chosen method - extracted to reduce cognitive complexity
// SECURITY NOTE: Downloads and executes a remote PowerShell script.
// The npm @beads/bd package is broken on Windows (GitHub Issue #1031, closed "not planned"),
// so the official PowerShell installer is the only supported path.
// Mitigations: HTTPS transport (prevents MITM), official beads repo, user-visible URL.
// Follow-up: pin to a versioned release tag once beads publishes tagged releases (for example v0.49.1).
const BEADS_INSTALL_PS1_URL = 'https://raw.githubusercontent.com/steveyegge/beads/main/install.ps1';



function installBeadsOnWindows() {
  console.log('  (Windows detected: using PowerShell installer)');
  console.log(`  Downloading: ${BEADS_INSTALL_PS1_URL}`);
  secureExecFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `irm ${BEADS_INSTALL_PS1_URL} | iex`
  ], { stdio: 'inherit' });
}



function installBeadsWithMethod(method) { // NOSONAR — Extracted as-is from bin/forge.js; complexity reduction deferred
  try {
    // SECURITY: secureExecFileSync with hardcoded commands
    if (method === '1') {
      console.log('Installing Beads globally...');
      if (process.platform === 'win32') {
        installBeadsOnWindows();
      } else {
        const pkgManager = PKG_MANAGER === 'bun' ? 'bun' : 'npm';
        secureExecFileSync(pkgManager, ['install', '-g', '@beads/bd'], { stdio: 'inherit' });
      }
      console.log('  ✓ Beads installed globally');
      initializeBeads('global');
    } else if (method === '2') {
      console.log('Installing Beads locally...');
      // On Windows, npm postinstall for @beads/bd runs Expand-Archive which has EPERM file-locking
      // (GitHub Issue #1031, closed "not planned") — same root cause as global install.
      // Redirect Windows users to the global PowerShell installer instead.
      if (process.platform === 'win32') {
        console.log('  ⚠ Local install not supported on Windows (npm @beads/bd EPERM issue).');
        console.log('  Falling back to global PowerShell installer...');
        installBeadsOnWindows();
      } else {
        const pkgManager = PKG_MANAGER === 'bun' ? 'bun' : 'npm';
        secureExecFileSync(pkgManager, ['install', '-D', '@beads/bd'], { stdio: 'inherit', cwd: projectRoot });
      }
      console.log('  ✓ Beads installed');
      // On Windows the fallback was global (PowerShell installer), so init as 'global'
      initializeBeads(process.platform === 'win32' ? 'global' : 'local');
    } else if (method === '3') {
      installViaBunx('@beads/bd', ['version'], initializeBeads, 'Beads');
    } else {
      console.log('Invalid choice. Skipping Beads installation.');
    }
  } catch (err) {
    console.warn('Beads installation failed:', err.message);
    console.log('  ⚠ Failed to install Beads:', err.message);
    if (process.platform === 'win32') {
      console.log(`  Run manually: irm ${BEADS_INSTALL_PS1_URL} | iex`);
    } else {
      console.log(`  Run manually: ${PKG_MANAGER === 'bun' ? 'bun add -g' : 'npm install -g'} @beads/bd && bd init`);
    }
  }
}

// Helper: Get package-manager-specific install args for Skills


// Helper: Get package-manager-specific install args for Skills
function getSkillsInstallArgs(scope) {
  const globalFlag = scope === 'global' ? '-g' : '-D';
  if (PKG_MANAGER === 'yarn' && scope === 'global') {
    return ['global', 'add', '@forge/skills'];
  }
  const cmd = (PKG_MANAGER === 'bun' || PKG_MANAGER === 'pnpm') ? 'add' : 'install';
  return [cmd, globalFlag, '@forge/skills'];
}

// Helper: Install Skills with chosen method - extracted to reduce cognitive complexity


// Helper: Install Skills with chosen method - extracted to reduce cognitive complexity
function installSkillsWithMethod(method) {
  try {
    if (method === '1') {
      console.log('Installing Skills globally...');
      secureExecFileSync(PKG_MANAGER, getSkillsInstallArgs('global'), { stdio: 'inherit' });
      console.log('  ✓ Skills installed globally');
      initializeSkills('global');
    } else if (method === '2') {
      console.log('Installing Skills locally...');
      secureExecFileSync(PKG_MANAGER, getSkillsInstallArgs('local'), { stdio: 'inherit', cwd: projectRoot });
      console.log('  ✓ Skills installed locally');
      initializeSkills('local');
    } else if (method === '3') {
      installViaBunx('@forge/skills', ['--version'], initializeSkills, 'Skills');
    } else {
      console.log('Invalid choice. Skipping Skills installation.');
    }
  } catch (err) {
    console.warn('Skills installation failed:', err.message);
    console.log('  ⚠ Failed to install Skills:', err.message);
    console.log(`  Run manually: ${PKG_MANAGER === 'bun' ? 'bun add -g' : 'npm install -g'} @forge/skills && skills init`);
  }
}

// Prompt for Skills setup - extracted to reduce cognitive complexity


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

  console.log('');
  installSkillsWithMethod(installMethod);
  console.log('');
}

// Interactive setup for Beads and Skills


// Interactive setup for Beads and Skills
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
  console.log('• Skills - Universal SKILL.md management');
  console.log('  Manage AI agent skills across all agents.');
  console.log('  Command: skills create, skills list, skills sync');
  console.log('');

  // Use helper functions to reduce complexity
  await promptBeadsSetup(question);
  await promptSkillsSetup(question);
}

// Auto-setup Beads in quick mode - extracted to reduce cognitive complexity


// Auto-setup Beads in quick mode - extracted to reduce cognitive complexity
function autoSetupBeadsInQuickMode() { // NOSONAR — Extracted as-is from bin/forge.js; complexity reduction deferred
  const beadsStatus = checkForBeads();
  const beadsInitialized = isBeadsInitialized();

  if (!beadsInitialized && beadsStatus) {
    console.log('📦 Initializing Beads...');
    initializeBeads(beadsStatus);
    console.log('');
  } else if (!beadsInitialized && !beadsStatus) {
    console.log('📦 Installing Beads globally...');
    try {
      // SECURITY: use PowerShell on Windows (npm @beads/bd is broken on Windows - Issue #1031)
      if (process.platform === 'win32') {
        installBeadsOnWindows();
      } else {
        const pkgManager = PKG_MANAGER === 'bun' ? 'bun' : 'npm';
        secureExecFileSync(pkgManager, ['install', '-g', '@beads/bd'], { stdio: 'inherit' });
      }
      console.log('  ✓ Beads installed globally');
      initializeBeads('global');
    } catch (err) {
      // Installation failed - provide manual instructions
      console.log('  ⚠ Could not install Beads automatically');
      console.log(`    Error: ${err.message}`);
      if (process.platform === 'win32') {
        console.log(`  Run manually: irm ${BEADS_INSTALL_PS1_URL} | iex`);
      } else {
        console.log(`  Run manually: ${PKG_MANAGER === 'bun' ? 'bun add -g' : 'npm install -g'} @beads/bd && bd init`);
      }
    }
    console.log('');
  }
}

// Helper: Auto-install lefthook if not present - extracted to reduce cognitive complexity


// Helper: Auto-install lefthook if not present - extracted to reduce cognitive complexity
function getLefthookInstallArgs(packageManager) {
  if (packageManager === 'yarn') {
    return ['add', '--dev', 'lefthook'];
  }
  if (packageManager === 'npm') {
    return ['install', '--save-dev', 'lefthook'];
  }
  if (packageManager === 'pnpm') {
    return ['add', '-D', 'lefthook'];
  }
  return ['add', '-d', 'lefthook'];
}

function getLefthookManualInstallCommand(packageManager) {
  return `${packageManager} ${getLefthookInstallArgs(packageManager).join(' ')}`;
}

function autoInstallLefthook() { // NOSONAR — Extracted as-is from bin/forge.js; complexity reduction deferred
  const status = checkForLefthook();

  // Binary available — nothing to do
  if (status.binaryAvailable) return;

  // In package.json but binary missing — just need install, not add
  if (status.installed && !status.binaryAvailable) {
    console.log('📦 Installing lefthook dependencies (binary missing)...');
    try {
      secureExecFileSync(PKG_MANAGER, ['install'], { stdio: 'inherit', cwd: projectRoot });
      console.log('  ✓ Lefthook binary restored');
    } catch (err) {
      console.warn('Lefthook install failed:', err.message);
      console.log(`  ⚠ ${status.message}`);
    }
    console.log('');
    return;
  }

  // Not in package.json at all — full install
  console.log('📦 Installing lefthook for git hooks...');
  try {
    // SECURITY: secureExecFileSync with PKG_MANAGER — cross-platform support
    const installArgs = getLefthookInstallArgs(PKG_MANAGER);
    secureExecFileSync(PKG_MANAGER, installArgs, { stdio: 'inherit', cwd: projectRoot });
    console.log('  ✓ Lefthook installed');
  } catch (err) {
    console.warn('Lefthook auto-install failed:', err.message);
    console.log('  ⚠ Could not install lefthook automatically');
    console.log(`  Run manually: ${getLefthookManualInstallCommand(PKG_MANAGER)}`);
  }
  console.log('');
}

// Helper: Verify a tool is callable after install - extracted to reduce cognitive complexity


// Helper: Verify a tool is callable after install - extracted to reduce cognitive complexity
function verifyToolInstall(command, args, toolName) {
  try {
    secureExecFileSync(command, args, { stdio: 'ignore' });
    return true;
  } catch (_err) { // NOSONAR - S2486: Intentionally ignored; verification failure is handled by caller
    console.log(`  ⚠ ${toolName} installed but not callable. Check your PATH.`);
    return false;
  }
}

// Helper: Auto-setup tools (Skills) in quick mode - extracted to reduce cognitive complexity


// Helper: Auto-setup tools (Skills) in quick mode - extracted to reduce cognitive complexity
function autoSetupToolsInQuickMode() {
  // Beads: auto-install or initialize
  autoSetupBeadsInQuickMode();

  // Post-install verification for Beads
  if (isBeadsInitialized()) {
    verifyToolInstall('bd', ['version'], 'Beads');
  }

  // Skills: only initialize if already installed (recommended tool)
  const skillsStatus = checkForSkills();
  if (skillsStatus && !isSkillsInitialized()) {
    console.log('📦 Initializing Skills...');
    initializeSkills(skillsStatus);
    console.log('');
  } else if (!skillsStatus) {
    const installCmd = PKG_MANAGER === 'bun' ? 'bun add -g' : 'npm install -g';
    console.log(`  ℹ Skills not found — install with: ${installCmd} @forge/skills`);
    console.log('');
  }
}

// Helper: Configure default external services in quick mode - extracted to reduce cognitive complexity


// Helper: Configure default external services in quick mode - extracted to reduce cognitive complexity
function configureDefaultExternalServices(skipExternal) {
  if (skipExternal) {
    console.log('');
    console.log('Skipping external services configuration...');
    return;
  }

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

// Quick setup with defaults


// Quick setup with defaults
async function quickSetup(selectedAgents, skipExternal) {
  showBanner('Quick Setup');
  console.log('');
  console.log('Quick mode: Using defaults...');
  console.log('');

  // Check prerequisites
  checkPrerequisites({
    requireBeadsCli: true,
    requireGithubCli: !skipExternal || SYNC_ENABLED,
    requireJq: true,
  });
  console.log('');

  // Copy AGENTS.md (actionLog tracks it via copyFile)
  const agentsSrc = path.join(packageDir, 'AGENTS.md');
  copyFile(agentsSrc, 'AGENTS.md');
  console.log('');

  // Setup core documentation
  setupCoreDocs();
  console.log('');

  ensureWorkflowShellPolicy(selectedAgents);

  // Auto-install lefthook if missing
  autoInstallLefthook();

  // Auto-setup project tools (Beads, Skills)
  autoSetupToolsInQuickMode();

  // Load canonical commands and setup agents (reuse existing helpers)
  const claudeCommands = await loadAndSetupCanonicalCommands(selectedAgents);
  await setupSelectedAgents(selectedAgents, claudeCommands);
  ensureWorkflowRuntimeAssets(selectedAgents);

  // Detect Husky and migrate before installing Lefthook hooks
  await handleHuskyMigration();

  // Install git hooks for TDD enforcement
  console.log('');
  installGitHooks();

  // Configure external services with defaults (unless skipped)
  configureDefaultExternalServices(skipExternal);

  // --sync flag: scaffold Beads GitHub sync workflows without prompting
  if (SYNC_ENABLED) {
    await handleSyncScaffold();
  }

  // Progressive setup summary
  console.log('');
  console.log(renderSetupSummary(actionLog, selectedAgents, VERBOSE_MODE));
  console.log('');
}

// Helper: Apply merge strategy to existing AGENTS.md - extracted to reduce cognitive complexity


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

// Helper: Handle user-provided flags override - extracted to reduce cognitive complexity


// Helper: Handle user-provided flags override - extracted to reduce cognitive complexity
function handleFlagsOverride(flags, projectStatus) {
  if (!flags.type && !flags.interview) {
    return;
  }

  console.log('User-provided flags:');
  if (flags.type) {
    console.log(`  --type=${flags.type} (workflow profile override)`);
    saveWorkflowTypeOverride(flags.type, projectStatus.autoDetected);
  }
  if (flags.interview) {
    console.log('  --interview (context interview mode)');
    console.log('  Note: Enhanced context gathering is a future feature');
  }
  console.log('');
}

// Helper: Save workflow type override to context - extracted to reduce cognitive complexity


// Helper: Save workflow type override to context - extracted to reduce cognitive complexity
function saveWorkflowTypeOverride(type, autoDetected) {
  if (!autoDetected) {
    return;
  }
  try {
    const contextPath = path.join(projectRoot, '.forge', 'context.json');
    if (fs.existsSync(contextPath)) {
      const contextData = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
      contextData.user_provided = contextData.user_provided || {};
      contextData.user_provided.workflowType = type;
      contextData.last_updated = new Date().toISOString();
      fs.writeFileSync(contextPath, JSON.stringify(contextData, null, 2), 'utf8');
    }
  } catch (error) {
    console.warn('  Warning: Could not save workflow type override:', error.message);
  }
}

// Helper: Display existing installation status - extracted to reduce cognitive complexity


// Helper: Display existing installation status - extracted to reduce cognitive complexity
function displayExistingInstallation(projectStatus) {
  if (projectStatus.type === 'fresh') {
    return;
  }

  console.log('==============================================');
  console.log('  Existing Installation Detected');
  console.log('==============================================');
  console.log('');

  console.log(projectStatus.type === 'upgrade'
    ? 'Found existing Forge installation:'
    : 'Found partial installation:');

  if (projectStatus.hasAgentsMd) console.log('  - AGENTS.md');
  if (projectStatus.hasClaudeCommands) console.log('  - .claude/commands/');
  if (projectStatus.hasEnvLocal) console.log('  - .env.local');
  console.log('');
}

// Helper: Prompt for overwrite decisions - extracted to reduce cognitive complexity


// Helper: Prompt for overwrite decisions - extracted to reduce cognitive complexity
async function promptForOverwriteDecisions(question, projectStatus, flags = {}) {
  const skipFiles = {
    agentsMd: false,
    claudeCommands: false
  };

  if (flags.keep) {
    if (projectStatus.hasAgentsMd) {
      skipFiles.agentsMd = true;
      console.log('  Keeping existing AGENTS.md (--keep)');
    }
    if (projectStatus.hasClaudeCommands) {
      skipFiles.claudeCommands = true;
      console.log('  Keeping existing .claude/commands/ (--keep)');
    }
    return skipFiles;
  }

  if (projectStatus.hasAgentsMd) {
    const overwriteAgents = await askYesNo(question, 'Found existing AGENTS.md. Overwrite?', true);
    skipFiles.agentsMd = !overwriteAgents;
    console.log(overwriteAgents ? '  Will overwrite AGENTS.md' : '  Keeping existing AGENTS.md');
  }

  if (projectStatus.hasClaudeCommands) {
    const overwriteCommands = await askYesNo(question, 'Found existing .claude/commands/. Overwrite?', true);
    skipFiles.claudeCommands = !overwriteCommands;
    console.log(overwriteCommands ? '  Will overwrite .claude/commands/' : '  Keeping existing .claude/commands/');
  }

  if (projectStatus.type !== 'fresh') {
    console.log('');
  }

  return skipFiles;
}

// Helper: Load and setup canonical commands - extracted to reduce cognitive complexity


// Helper: Load and setup canonical commands - extracted to reduce cognitive complexity
async function loadAndSetupCanonicalCommands(selectedAgents, skipFiles) {
  const claudeCommands = {};
  const needsClaudeCommands = selectedAgents.includes('claude') ||
    selectedAgents.some(a => AGENTS[a].needsConversion || AGENTS[a].copyCommands);

  if (!needsClaudeCommands) {
    return claudeCommands;
  }

  // First ensure Claude is set up
  if (selectedAgents.includes('claude')) {
    await setupAgent('claude', null, skipFiles);
  }

  // Then load the commands (from existing or newly created)
  getWorkflowCommands().forEach(cmd => {
    const cmdPath = path.join(projectRoot, `.claude/commands/${cmd}.md`);
    const content = readFile(cmdPath);
    if (content) {
      claudeCommands[`${cmd}.md`] = content;
    }
  });

  return claudeCommands;
}

// Helper: Setup all selected agents - extracted to reduce cognitive complexity


// Helper: Setup all selected agents - extracted to reduce cognitive complexity
async function setupSelectedAgents(selectedAgents, claudeCommands, skipFiles) {
  const totalAgents = selectedAgents.length;
  for (const [index, agentKey] of selectedAgents.entries()) {
    const agent = AGENTS[agentKey];
    console.log(`\n[${index + 1}/${totalAgents}] Setting up ${agent.name}...`);
    if (agentKey !== 'claude') { // Claude already done above
      await setupAgent(agentKey, claudeCommands, skipFiles);
    }
  }

  console.log('');
  console.log('Agent configuration complete!');
  console.log('');
  console.log('Installed for:');
  selectedAgents.forEach(key => {
    const agent = AGENTS[key];
    console.log(`  * ${agent.name}`);
  });
}

// Helper: Configure external services step - extracted to reduce cognitive complexity


// Helper: Configure external services step - extracted to reduce cognitive complexity
async function handleExternalServicesStep(flags, rl, question, selectedAgents, projectStatus) {
  if (flags.skipExternal) {
    console.log('');
    console.log('Skipping external services configuration...');
    return;
  }

  console.log('');
  console.log('STEP 2: External Services (Optional)');
  console.log('=====================================');
  await configureExternalServices(rl, question, selectedAgents, projectStatus);
}

// Interactive setup with flag support


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
  checkPrerequisites({
    requireBeadsCli: true,
    requireGithubCli: !flags.skipExternal || SYNC_ENABLED,
    requireJq: true,
  });
  console.log('');

  // PROJECT DETECTION
  const projectStatus = await detectProjectStatus();

  // Handle user-provided flags to override auto-detection
  handleFlagsOverride(flags, projectStatus);

  // Display existing installation status
  displayExistingInstallation(projectStatus);

  // Prompt for overwrite decisions
  const skipFiles = await promptForOverwriteDecisions(question, projectStatus, flags);

  // Agent auto-detection (suggests but does not force)
  const envDetection = detectEnvironment(projectRoot);
  if (envDetection.activeAgent && envDetection.confidence === 'high') {
    console.log(`  Detected: ${envDetection.activeAgent} (${envDetection.activeAgentSource})`);
  }
  if (envDetection.configuredAgents.length > 0) {
    console.log(`  Previously configured: ${envDetection.configuredAgents.join(', ')}`);
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

  // Load Claude commands if needed (delegated to helper)
  const claudeCommands = await loadAndSetupCanonicalCommands(selectedAgents, skipFiles);

  // Setup each selected agent with progress indication (delegated to helper)
  await setupSelectedAgents(selectedAgents, claudeCommands, skipFiles);
  ensureWorkflowRuntimeAssets(selectedAgents);

  // Handle external services step (delegated to helper)
  await handleExternalServicesStep(flags, rl, question, selectedAgents, projectStatus);

  setupCompleted = true;
  rl.close();

  // Display final summary (delegated to helper)
  displaySetupSummary(selectedAgents);
}

// Main
// Helper: Handle --path setup


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

// Shared setup executor — used by handleSetupCommand

// Dry-run setup — enumerate planned actions without writing files


// Shared setup executor — used by handleSetupCommand

// Dry-run setup — enumerate planned actions without writing files
function dryRunSetup(agents) { // NOSONAR — Extracted as-is from bin/forge.js; complexity reduction deferred
  const collector = new ActionCollector();

  // Helper: add create or skip based on whether file exists
  function addFileAction(relPath, description) {
    const absPath = path.join(projectRoot, relPath);
    if (fs.existsSync(absPath)) {
      collector.add('skip', relPath, 'Already exists');
    } else {
      collector.add('create', relPath, description);
    }
  }

  // AGENTS.md
  addFileAction('AGENTS.md', 'Copy workflow documentation');

  // Per-agent planned actions
  for (const agentKey of agents) {
    const agent = AGENTS[agentKey];
    if (!agent) continue;

    // Agent directories
    for (const dir of agent.dirs) {
      addFileAction(dir + '/', 'Create agent directory');
    }

    // Claude-specific files
    if (agentKey === 'claude') {
      const cmds = getWorkflowCommands();
      for (const cmd of cmds) {
        addFileAction(`.claude/commands/${cmd}.md`, 'Workflow command');
      }
      addFileAction('.claude/rules/workflow.md', 'Workflow rules');
      addFileAction('.claude/scripts/load-env.sh', 'Environment loader script');
      addFileAction('.claude/skills/forge-workflow/SKILL.md', 'Forge workflow skill');
      addFileAction('.mcp.json', 'MCP server configuration');
      addFileAction('CLAUDE.md', 'Claude root config (links to AGENTS.md)');
    }

    if (needsWorkflowRuntimeAssets([agentKey])) {
      for (const assetPath of getWorkflowRuntimeAssets()) {
        addFileAction(assetPath, 'Workflow runtime asset');
      }
    }

    // Cursor-specific files
    if (agent.customSetup === 'cursor') {
      addFileAction('.cursor/rules/forge-workflow.mdc', 'Cursor workflow rule');
      addFileAction('.cursor/rules/tdd-enforcement.mdc', 'Cursor TDD rule');
      addFileAction('.cursor/rules/security-scanning.mdc', 'Cursor security rule');
      addFileAction('.cursor/rules/documentation.mdc', 'Cursor documentation rule');
    }

    if (agentKey === 'kilocode') {
      addFileAction('.kilocode/workflows/forge-workflow.md', 'Kilo native workflow');
      addFileAction('.kilocode/rules/workflow.md', 'Kilo native rules');
      addFileAction('.kilocode/skills/forge-workflow/SKILL.md', 'Kilo native skill');
    }

    if (agent.customSetup === 'copilot') {
      addFileAction('.github/copilot-instructions.md', 'Copilot root instructions');
      addFileAction('.github/instructions/typescript.instructions.md', 'Copilot TypeScript instructions');
      addFileAction('.github/instructions/testing.instructions.md', 'Copilot testing instructions');
      addFileAction('.github/prompts/red.prompt.md', 'Copilot RED prompt');
      addFileAction('.github/prompts/green.prompt.md', 'Copilot GREEN prompt');
    }

    if (agent.customSetup === 'opencode') {
      addFileAction('opencode.json', 'OpenCode root config');
      addFileAction('.opencode/agents/plan-review.md', 'OpenCode plan-review agent');
      addFileAction('.opencode/agents/tdd-build.md', 'OpenCode tdd-build agent');
    }

    // Agent commands (converted from Claude format)
    if (agent.needsConversion || agent.copyCommands || agent.promptFormat) {
      const cmds = getWorkflowCommands();
      const targetDir = agent.dirs[0];
      for (const cmd of cmds) {
        const ext = agent.promptFormat ? '.prompt.md' : '.md';
        addFileAction(`${targetDir}/${cmd}${ext}`, 'Converted workflow command');
      }
    }

    // Agent rules (copied from Claude)
    if (agent.needsConversion) {
      const rulesDir = agent.dirs.find(d => d.includes('/rules'));
      if (rulesDir) {
        addFileAction(`${rulesDir}/workflow.md`, 'Workflow rules');
      }
    }

    // Agent skill
    if (agentKey === 'codex') {
      const skillEntries = listCodexSkillEntries(packageDir);
      for (const entry of skillEntries) {
        addFileAction(path.join(entry.dir, entry.filename), 'Codex stage skill');
      }
    } else if (agent.hasSkill) {
      const skillDir = agent.dirs.find(d => d.includes('/skills/'));
      if (skillDir) {
        addFileAction(`${skillDir}/SKILL.md`, 'Forge workflow skill');
      }
    }

    // Agent link file (symlink or copy of AGENTS.md)
    if (shouldLinkAgentsMd(agent)) {
      addFileAction(agent.linkFile, 'Link to AGENTS.md');
    }
  }

  // Git hooks
  addFileAction('lefthook.yml', 'Git hook configuration');
  addFileAction('.forge/hooks/check-tdd.js', 'TDD enforcement hook');

  // Print dry-run summary
  console.log('');
  console.log('Dry-run: the following actions would be performed:');
  console.log('');
  collector.print();
  console.log('');
  console.log(`Total: ${collector.list().length} planned actions`);
  console.log('No files were modified.');
}



async function executeSetup(config) {
  const { agents, skipExternal, keepExisting = false, commandRunner } = config;

  showBanner('Installing for specified agents...');
  console.log('');

  // Check prerequisites
  checkPrerequisites({
    requireBeadsCli: true,
    requireGithubCli: !skipExternal || SYNC_ENABLED,
    requireJq: true,
    commandRunner,
  });
  console.log('');

  // Copy AGENTS.md (only if not exists — preserve user customizations; actionLog tracks it)
  const agentsDest = path.join(projectRoot, 'AGENTS.md');
  if (fs.existsSync(agentsDest)) {
    actionLog.add('AGENTS.md', 'skipped', 'already exists');
  } else {
    const agentsSrc = path.join(packageDir, 'AGENTS.md');
    copyFile(agentsSrc, 'AGENTS.md');
  }
  console.log('');

  // Setup core documentation
  setupCoreDocs();
  console.log('');

  const skipFiles = {
    agentsMd: keepExisting && fs.existsSync(path.join(projectRoot, 'AGENTS.md')),
    claudeCommands: keepExisting && fs.existsSync(path.join(projectRoot, '.claude', 'commands'))
  };

  if (skipFiles.claudeCommands) {
    console.log('  Keeping existing .claude/commands/ (--keep)');
  }

  // Load canonical commands — use loadAndSetupCanonicalCommands when claude is selected
  // so that .claude/commands/ are seeded before reading them
  const claudeCommands = agents.includes('claude')
    ? await loadAndSetupCanonicalCommands(agents, skipFiles)
    : loadClaudeCommands(agents);

  // Setup agents with progress output (setupSelectedAgents skips claude internally
  // since loadAndSetupCanonicalCommands already handled it above)
  await setupSelectedAgents(agents, claudeCommands, skipFiles);
  ensureWorkflowRuntimeAssets(agents);
  ensureWorkflowShellPolicy(agents);
  repairDeclaredLefthookDependency(agents);

  // Detect Husky and migrate before installing Lefthook hooks
  await handleHuskyMigration();

  // Install git hooks for TDD enforcement
  console.log('');
  installGitHooks();

  // External services (unless skipped)
  await handleExternalServices(skipExternal, agents);

  // --sync flag: scaffold Beads GitHub sync workflows without prompting
  if (SYNC_ENABLED) {
    await handleSyncScaffold();
  }

  // Progressive setup summary
  console.log('');
  console.log(renderSetupSummary(actionLog, agents, VERBOSE_MODE));
  console.log('');
}

// Helper: Scaffold Beads GitHub sync when --sync flag is provided


// Helper: Scaffold Beads GitHub sync when --sync flag is provided
async function handleSyncScaffold() {
  console.log('');
  console.log('Scaffolding Beads GitHub sync workflows (--sync)...');
  try {
    // Scaffold sync files using the new lib module
    const result = scaffoldBeadsSync(projectRoot, packageDir);
    for (const f of (result.filesCreated || [])) {
      console.log(`  Created: ${f}`);
    }
    for (const f of (result.filesSkipped || [])) {
      console.log(`  Skipped: ${f} (already exists)`);
    }

    // Detect default branch and Beads version, then template workflows
    const branch = detectDefaultBranch(projectRoot);
    const beadsVersion = detectBeadsVersion();
    const workflowDir = path.join(projectRoot, '.github', 'workflows');
    templateWorkflows(workflowDir, branch, beadsVersion, result.filesCreated || []);
    console.log(`  Branch: ${branch}, Beads version: ${beadsVersion}`);

    // PAT setup: interactive when possible, reminder otherwise
    try {
      const patResult = setupPAT(projectRoot, { interactive: !NON_INTERACTIVE });
      if (patResult.success) {
        console.log('  PAT configured for Beads sync');
      } else if (patResult.reminder) {
        console.log(`  ${patResult.reminder}`);
      } else if (patResult.instructions) {
        console.log(`  ${patResult.instructions.split('\n')[0]}`);
      }
    } catch (_patErr) { // NOSONAR — best-effort PAT setup, non-fatal
      // PAT setup is best-effort — don't block sync scaffold
    }
  } catch (err) {
    console.error(`  Error scaffolding GitHub-Beads sync: ${err.message}`);
  }
}

// Helper: Handle setup command in non-quick mode


// Helper: Handle setup command in non-quick mode
async function handleSetupCommand(selectedAgents, flags) {
  if (!Array.isArray(selectedAgents) || selectedAgents.length === 0) {
    return interactiveSetupWithFlags(flags);
  }

  // Allow callers (e.g. reinstall) to override projectRoot without process.chdir()
  const savedRoot = projectRoot;
  if (flags.projectRoot) {
    projectRoot = flags.projectRoot;
  }
  try {
    await executeSetup({
      agents: selectedAgents,
      skipExternal: flags.skipExternal,
      keepExisting: flags.keep,
      commandRunner: flags.commandRunner,
    });
  } finally {
    projectRoot = savedRoot;
  }
}

// Helper: Handle external services configuration


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


/**
 * Detect which agents are already configured in a project directory.
 * Checks for the presence of each agent's configured directories/files.
 * Returns the external-facing setup IDs used by the setup UX, including
 * legacy aliases such as `claude-code`, `github-copilot`, and `roo-code`.
 * Callers that need raw plugin IDs for internal lookup must normalize first.
 *
 * @param {string} dir - Project directory to scan
 * @returns {string[]} External-facing setup agent IDs with configuration present
 */
function detectConfiguredAgents(dir) {
  const pluginManager = new PluginManager();
  const detected = [];
  const legacyAgentIds = {
    claude: 'claude-code',
    copilot: 'github-copilot',
    roo: 'roo-code',
  };

  pluginManager.getAllPlugins().forEach((plugin, id) => {
    const dirs = Object.values(plugin.directories || {});
    const files = Object.values(plugin.files || {});
    const markers = [...dirs, ...files].filter(Boolean);
    const isConfigured = markers.some((marker) => fs.existsSync(path.join(dir, marker)));

    if (isConfigured) {
      detected.push(legacyAgentIds[id] || id);
    }
  });

  return detected;
}

/**
 * Remove agent-specific files from a project directory.
 * Used during setup --clean or reset flows.
 *
 * @param {string} dir - Project directory
 * @param {string} agentName - Agent slug (e.g. 'cursor', 'cline')
 * @param {object} [manifest] - Optional sync manifest with file paths to remove
 * @returns {{ removed: string[], errors: string[] }}
 */
function removeAgentFiles(dir, agentName, manifest) {
  const removed = [];
  const errors = [];

  // Validate agent name (OWASP A03 — path traversal prevention)
  if (!/^[a-z0-9-]+$/.test(agentName)) {
    errors.push(`Invalid agent name: "${agentName}"`);
    return { removed, errors };
  }

  const agent = AGENTS[agentName];
  if (!agent) {
    errors.push(`Unknown agent: "${agentName}"`);
    return { removed, errors };
  }

  // Remove command files from manifest if provided
  if (manifest && Array.isArray(manifest.files)) {
    for (const relPath of manifest.files) {
      // Only remove files belonging to this agent
      const agentDirs = agent.dirs || [];
      const belongsToAgent = agentDirs.some(d => relPath.startsWith(d));
      if (!belongsToAgent) continue;

      const absPath = path.join(dir, relPath);
      try {
        if (fs.existsSync(absPath)) {
          fs.unlinkSync(absPath);
          removed.push(relPath);
        }
      } catch (err) {
        errors.push(`Failed to remove ${relPath}: ${err.message}`);
      }
    }
  }

  return { removed, errors };
}

/**
 * Parse setup-related CLI flags from argv.
 * Extracts --agents, --all, --detect, --keep, --yes, etc.
 *
 * @param {string[]} argv - Process argv (typically process.argv.slice(2))
 * @returns {object} Parsed flags object
 */
const SETUP_FLAG_DEFAULTS = Object.freeze({
  agents: null,
  all: false,
  detect: false,
  keep: false,
  yes: false,
  force: false,
  verbose: false,
  dryRun: false,
  quick: false,
  skipExternal: false,
  sync: false,
  symlink: false,
  nonInteractive: false,
});

const SIMPLE_SETUP_FLAG_UPDATES = Object.freeze({
  '--all': { all: true },
  '--detect': { detect: true },
  '--keep': { keep: true },
  '--force': { force: true },
  '--verbose': { verbose: true },
  '--dry-run': { dryRun: true },
  '--quick': { quick: true },
  '--skip-external': { skipExternal: true },
  '--sync': { sync: true },
  '--symlink': { symlink: true },
  '--yes': { yes: true, nonInteractive: true },
  '-y': { yes: true, nonInteractive: true },
});

function parseAgentFlag(argv, currentIndex, isFlagToken) {
  const arg = argv[currentIndex];
  if (arg === '--agents' && currentIndex + 1 < argv.length && !isFlagToken(argv[currentIndex + 1])) {
    const agentTokens = [];
    let nextIndex = currentIndex;
    while (nextIndex + 1 < argv.length && !isFlagToken(argv[nextIndex + 1])) {
      agentTokens.push(argv[++nextIndex]);
    }
    return { handled: true, nextIndex, agents: agentTokens.join(',') };
  }

  if (arg.startsWith('--agents=')) {
    return { handled: true, nextIndex: currentIndex, agents: arg.split('=')[1] };
  }

  return { handled: false, nextIndex: currentIndex, agents: null };
}

function applySimpleSetupFlag(flags, arg) {
  const updates = SIMPLE_SETUP_FLAG_UPDATES[arg];
  if (!updates) {
    return false;
  }

  Object.assign(flags, updates);
  return true;
}

function parseSetupFlags(argv) {
  const flags = { ...SETUP_FLAG_DEFAULTS };

  const isFlagToken = (token) => typeof token === 'string' && token.startsWith('-');

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const agentResult = parseAgentFlag(argv, i, isFlagToken);
    if (agentResult.handled) {
      flags.agents = agentResult.agents;
      i = agentResult.nextIndex;
      continue;
    }

    applySimpleSetupFlag(flags, arg);
  }

  return flags;
}

/**
 * Merge setup-specific runtime flags from raw argv into the global CLI flags.
 * This lets the extracted setup command own setup-only flags without relying
 * on bin/forge.js to keep a duplicate parser in sync.
 *
 * @param {Record<string, unknown>} flags
 * @param {string[]} argv
 * @returns {Record<string, unknown>}
 */
function mergeSetupFlags(flags, argv) {
  const setupFlags = parseSetupFlags(argv);
  return {
    ...flags,
    agents: flags.agents ?? setupFlags.agents,
    all: Boolean(flags.all || setupFlags.all),
    detect: Boolean(flags.detect || setupFlags.detect),
    keep: Boolean(flags.keep || setupFlags.keep),
    yes: Boolean(flags.yes || setupFlags.yes),
    force: Boolean(flags.force || setupFlags.force),
    verbose: Boolean(flags.verbose || setupFlags.verbose),
    dryRun: Boolean(flags.dryRun || setupFlags.dryRun),
    quick: Boolean(flags.quick || setupFlags.quick),
    skipExternal: Boolean(flags.skipExternal || setupFlags.skipExternal),
    sync: Boolean(flags.sync || setupFlags.sync),
    symlink: Boolean(flags.symlink || setupFlags.symlink),
    nonInteractive: Boolean(flags.nonInteractive || setupFlags.nonInteractive),
  };
}

function normalizeDetectedAgent(agentName) {
  const aliases = {
    'claude-code': 'claude',
    'github-copilot': 'copilot',
    'kilo-code': 'kilocode',
    'roo-code': 'roo',
  };
  return aliases[agentName] || agentName;
}

function detectAgentsFromRuntime() {
  const envDetection = detectEnvironment(projectRoot);
  const detected = new Set();

  for (const agentName of envDetection.configuredAgents || []) {
    const normalized = normalizeDetectedAgent(agentName);
    if (AGENTS[normalized]) {
      detected.add(normalized);
    }
  }

  if (detected.size === 0 && envDetection.activeAgent) {
    const normalized = normalizeDetectedAgent(envDetection.activeAgent);
    if (AGENTS[normalized]) {
      detected.add(normalized);
    }
  }

  return [...detected];
}

// --- Registry-compliant exports ---
module.exports = {
  name: 'setup',
  description: 'Initialize forge in a project',
  handler: async (args, flags, root) => { // NOSONAR — Extracted as-is from bin/forge.js; complexity reduction deferred
    flags = mergeSetupFlags(flags, args);

    // Sync module state from caller
    if (root) projectRoot = root;
    if (flags.force) FORCE_MODE = true;
    if (flags.verbose) VERBOSE_MODE = true;
    if (flags.nonInteractive || flags.yes) NON_INTERACTIVE = true;
    if (flags.symlink) SYMLINK_ONLY = true;
    if (flags.sync) SYNC_ENABLED = true;
    actionLog = new SetupActionLog();
    PKG_MANAGER = detectPackageManager();

    // Determine agents to install
    let selectedAgents = determineSelectedAgents(flags);

    if (flags.detect && selectedAgents.length === 0) {
      selectedAgents = detectAgentsFromRuntime();
      if (selectedAgents.length > 0) {
        console.log(`Auto-detected agents (--detect): ${selectedAgents.join(', ')}`);
      } else {
        console.log('No agents detected via --detect; falling back to interactive selection.');
      }
    }

    if (flags.yes && selectedAgents.length === 0) {
      selectedAgents = ['claude'];
    }
    if (flags.yes) {
      flags.skipExternal = true;
    }

    if (flags.dryRun) {
      if (selectedAgents.length === 0) selectedAgents = ['claude'];
      dryRunSetup(selectedAgents);
      return { success: true };
    }

    if (flags.quick) {
      flags.skipExternal = true;
      if (selectedAgents.length === 0 || (flags.yes && !flags.agents)) {
        selectedAgents = Object.keys(AGENTS);
      }
      await quickSetup(selectedAgents, flags.skipExternal);
      return { success: true };
    }

    if (selectedAgents.length > 0) {
      await handleSetupCommand(selectedAgents, flags);
      return { success: true };
    }

    await interactiveSetupWithFlags(flags);
    return { success: true };
  },

  // Expose internals for testing and cross-command use
  checkPrerequisites,
  setupCoreDocs,
  displaySetupSummary,
  setupAgent,
  quickSetup,
  interactiveSetupWithFlags,
  dryRunSetup,
  handleSetupCommand,
  executeSetup,
  handleExternalServices,
  _interactiveSetup,
  configureExternalServices,
  configureDefaultExternalServices,
  installBeadsWithMethod,
  installSkillsWithMethod,
  installViaBunx,
  autoInstallLefthook,
  autoSetupToolsInQuickMode,
  setupClaudeMcpConfig,
  displayMcpStatus,
  displayEnvTokenResults,
  minimalInstall,
  determineSelectedAgents,
  handlePathSetup,
  loadAndSetupCanonicalCommands,
  detectConfiguredAgents,
  removeAgentFiles,
  parseSetupFlags,
  mergeSetupFlags,
  getWorkflowCommands,
  getWorkflowRuntimeAssets,
  findMissingWorkflowRuntimeAssets,
  ensureWorkflowShellPolicy,
  repairWorkflowRuntimeAssets,
  repairRuntimeReadiness,
  _showBanner: showBanner,

  // State accessors for testing
  _getState: () => ({ projectRoot, FORCE_MODE, VERBOSE_MODE, NON_INTERACTIVE, SYMLINK_ONLY, SYNC_ENABLED, PKG_MANAGER }),
  _setState: (state) => {
    if (state.projectRoot !== undefined) projectRoot = state.projectRoot;
    if (state.FORCE_MODE !== undefined) FORCE_MODE = state.FORCE_MODE;
    if (state.VERBOSE_MODE !== undefined) VERBOSE_MODE = state.VERBOSE_MODE;
    if (state.NON_INTERACTIVE !== undefined) NON_INTERACTIVE = state.NON_INTERACTIVE;
    if (state.SYMLINK_ONLY !== undefined) SYMLINK_ONLY = state.SYMLINK_ONLY;
    if (state.SYNC_ENABLED !== undefined) SYNC_ENABLED = state.SYNC_ENABLED;
    if (state.PKG_MANAGER !== undefined) PKG_MANAGER = state.PKG_MANAGER;
  },
};
