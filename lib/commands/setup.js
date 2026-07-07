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
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execSync, execFileSync } = require('node:child_process');

// Compute packageDir relative to this file (lib/commands/setup.js -> project root)
const packageDir = path.resolve(__dirname, '..', '..');
const packageJson = require(path.join(packageDir, 'package.json'));
const VERSION = packageJson.version;

// Load PluginManager for discoverable agent architecture
const PluginManager = require('../plugin-manager');
const { populateAgentSkills, listCanonicalSkills, listFilesRecursive } = require('../skills-sync');
const { renderMcpConfig } = require('../mcp-config-renderer');
const { renderClaudePermissions, renderCursorIgnore } = require('../safety-config-renderer');
const { renderHookConfig } = require('../hook-renderer');
const { copyEssentialDocs } = require('../docs-copy');

// Baseline MCP server Forge ships. Uses the generic descriptor contract consumed
// by lib/mcp-config-renderer.js (envRefs are '${VAR}' references, never secrets).
const CONTEXT7_MCP_DESCRIPTOR = {
  name: 'context7',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@upstash/context7-mcp@latest'],
  envRefs: {},
};
const { secureExecFileSync } = require('../shell-utils');
const { askYesNo: _askYesNoBase } = require('../ui-utils');

// Load enhanced onboarding modules
const contextMerge = require(path.join(packageDir, 'lib', 'context-merge'));
const projectDiscovery = require(path.join(packageDir, 'lib', 'project-discovery'));

// Load lib modules for symlink, beads, and PAT setup
const { createSymlinkOrCopy: libCreateSymlinkOrCopy } = require(path.join(packageDir, 'lib', 'symlink-utils'));
const { scaffoldBeadsSync } = require(path.join(packageDir, 'lib', 'beads-sync-scaffold'));
const { resolveSyncBackend } = require(path.join(packageDir, 'lib', 'sync-backend'));
const { buildMigratedKernelIssueDeps } = require(path.join(packageDir, 'lib', 'kernel', 'cli-broker-factory'));

// Load incremental setup modules
const { detectEnvironment } = require('../detect-agent');
const { fileMatchesContent } = require('../file-hash');
const { SetupActionLog } = require('../setup-action-log');
const { ActionCollector } = require('../setup-utils');
const { renderSetupSummary } = require('../setup-summary-renderer');
const { smartMergeAgentsMd } = require('../smart-merge');
const { checkLefthookStatus } = require('../lefthook-check');
const { resolveShellRuntime } = require('../runtime-health');
const {
  buildCodexSkillInstallPlan,
  formatCodexSkillsInstallDir,
  listCodexSkillEntries,
  populateCodexRepoSkills,
  CODEX_REPO_SKILLS_DIR,
} = require('../codex-skills');
const {
  generateCursorConfig,
} = require('../agents-config');
const initCommand = require('./init');
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
let SETUP_NOTES = [];
let CODEX_SETUP_REPORT = null;
// Tracks whether the last ensureKernelIssueStore() run provisioned the store.
// The setup summary reads this so a provisioning failure isn't masked by a
// hardcoded "✓ Kernel issue store" line. Defaults true: when the ensure step
// never ran, the kernel still auto-provisions on first use.
let KERNEL_STORE_READY = true;

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
      dirs: getRepoRelativePluginDirectories(plugin),
      hasCommands: plugin.capabilities?.commands || plugin.setup?.copyCommands || false,
      hasSkill: plugin.capabilities?.skills || plugin.setup?.createSkill || false,
      linkFile: plugin.files?.rootConfig || '',
      customSetup: plugin.setup?.customSetup || '',
      supportStatus: plugin.support?.status || 'supported',
      needsConversion: plugin.setup?.needsConversion || false,
      copyCommands: plugin.setup?.copyCommands || false,
      promptFormat: plugin.setup?.promptFormat || false,
      skillsDir: plugin.directories?.skills || null
    };
  });
  return agents;
}

function isRepoRelativePluginPath(candidate) {
  return typeof candidate === 'string'
    && candidate.length > 0
    && !path.isAbsolute(candidate)
    && !/^[~$%]/.test(candidate);
}

function getRepoRelativePluginDirectories(plugin) {
  return Object.values(plugin.directories || {}).filter(isRepoRelativePluginPath);
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
  '.claude/scripts/review-resolve.sh'
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

  if (requireBeadsCli) {
    // Issue tracking runs on the local Forge Kernel store, which auto-provisions
    // on first use — there is no external CLI to install. Surface only whether
    // team sync is wired up yet.
    if (resolveSyncBackend({ projectRoot, env: options.env }) === 'local-noop') {
      console.log('  ✓ Kernel issue store (local-noop sync: single-machine until a sync server is configured)');
    } else {
      console.log('  ✓ Kernel issue store');
    }
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
    // jq is optional at setup time. Some workflow helper scripts shell out to jq,
    // but they degrade or defer when it is absent — a clean box (esp. Windows)
    // must not abort setup just because jq is not installed yet. Surface a
    // warning instead of a fatal error (kernel issue 01468e44).
    warnings.push('jq not found - some workflow helper scripts will be skipped until you install it (https://jqlang.org/download/)');
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

  // Return a structured result so embedding agents can inspect prerequisite
  // state instead of only observing a process exit. Genuinely-fatal prereqs
  // (git, node version, required gh) still hard-exit above; soft prereqs like
  // jq surface via `warnings` while `ok` stays true.
  return { errors, warnings, ok: errors.length === 0 };
}

function requiresGithubCliForSetup(selectedAgents) {
  return needsWorkflowRuntimeAssets(selectedAgents);
}

/**
 * After agent setup, `.forge/config.yaml` may not exist yet — only the
 * --minimal/--standard/--full routes run `forge init`. Point the user at
 * `forge init` so first-run always ends with a clear next step that creates
 * the workflow config (gates + change classification). No-op when the config
 * already exists (kernel issue 5bdc91d3).
 */
function printForgeInitNextStep() {
  const configPath = path.join(projectRoot, '.forge', 'config.yaml');
  if (fs.existsSync(configPath)) {
    return;
  }
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('▶  NEXT: run `forge init` to configure your workflow');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');
  console.log('  forge init   # creates .forge/config.yaml');
  console.log('');
  console.log('  Sets up workflow gates and change classification.');
  console.log('  Safe to re-run (existing config is preserved).');
  console.log('');
}

/**
 * Guard against silent data loss when a non-interactive setup path overwrites
 * an existing AGENTS.md that predates Forge's USER/FORGE merge markers. Old
 * hand-edited files have no markers, so a plain copy would clobber them with no
 * way to recover. Before that happens, snapshot the file to AGENTS.md.bak and
 * warn (kernel issue a5399f3d). Returns true when a backup was written.
 */
function backupMarkerlessAgentsMd() {
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  if (!fs.existsSync(agentsPath)) {
    return false;
  }
  const existingContent = fs.readFileSync(agentsPath, 'utf8');
  const hasUserMarkers = existingContent.includes('<!-- USER:START');
  const hasForgeMarkers = existingContent.includes('<!-- FORGE:START');
  if (hasUserMarkers || hasForgeMarkers) {
    return false;
  }
  // Never clobber an earlier snapshot: keep the original AGENTS.md.bak stable
  // and fall back to numbered AGENTS.md.bak.1, .2, ... so a repeated markerless
  // overwrite (e.g. re-running --quick after markers were stripped) preserves
  // every prior backup instead of losing it (CodeRabbit review on PR #300).
  let backupPath = path.join(projectRoot, 'AGENTS.md.bak');
  if (fs.existsSync(backupPath)) {
    let suffix = 1;
    while (fs.existsSync(path.join(projectRoot, `AGENTS.md.bak.${suffix}`))) {
      suffix += 1;
    }
    backupPath = path.join(projectRoot, `AGENTS.md.bak.${suffix}`);
  }
  fs.writeFileSync(backupPath, existingContent, 'utf8');
  console.log(`  ⚠ Existing AGENTS.md has no Forge markers - backed up to ${path.basename(backupPath)} before overwrite`);
  return true;
}


// Helper functions



// Helper functions

function ensureDir(dir) {
  return fileUtils.ensureDir(dir, projectRoot);
}



function writeManagedAbsoluteFile(absolutePath, content, displayPath) {
  try {
    if (!FORCE_MODE && fileMatchesContent(absolutePath, content)) {
      actionLog.add(displayPath, 'skipped', 'identical content');
      return true;
    }

    const dir = path.dirname(absolutePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const existed = fs.existsSync(absolutePath);
    fs.writeFileSync(absolutePath, content, { mode: 0o644 });
    actionLog.add(displayPath, FORCE_MODE ? 'force-created' : (existed ? 'updated' : 'created'));
    return true;
  } catch (err) {
    console.error(`  × Failed to write ${displayPath}: ${err.message}`);
    return false;
  }
}



function resetSetupNotes() {
  SETUP_NOTES = [];
  CODEX_SETUP_REPORT = null;
  KERNEL_STORE_READY = true;
}

function addSetupNote(message) {
  if (!message || SETUP_NOTES.includes(message)) {
    return;
  }
  SETUP_NOTES.push(message);
}

function getSetupSummaryStatus() {
  return SETUP_NOTES.length > 0 ? 'partial' : 'complete';
}

function printSetupNotes() {
  if (SETUP_NOTES.length === 0) {
    return;
  }

  for (const note of SETUP_NOTES) {
    console.log(`  Warning: ${note}`);
  }
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
    return Boolean(agent && (agent.hasCommands || agent.hasSkill || agent.needsConversion || agent.copyCommands || agent.promptFormat));
  });
}

function getWorkflowRuntimeAssets() {
  return [...WORKFLOW_RUNTIME_ASSETS];
}

function resolveWorkflowRuntimeAgents(targetRoot = projectRoot, selectedAgents = null) {
  if (Array.isArray(selectedAgents)) {
    return selectedAgents.filter((agentKey) => AGENTS[agentKey]);
  }

  return resolveConfiguredWorkflowAgents(targetRoot);
}

function findMissingWorkflowRuntimeAssets(targetRoot = projectRoot, selectedAgents = null) {
  const agents = resolveWorkflowRuntimeAgents(targetRoot, selectedAgents);
  if (!needsWorkflowRuntimeAssets(agents)) {
    return [];
  }

  return WORKFLOW_RUNTIME_ASSETS.filter((relativePath) => !fs.existsSync(path.join(targetRoot, relativePath)));
}

function resolveConfiguredWorkflowAgents(targetRoot = projectRoot) {
  const configuredAgents = detectConfiguredAgents(targetRoot)
    .map(normalizeDetectedAgent)
    .filter((agentName) => AGENTS[agentName]);

  return configuredAgents;
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
  const agents = resolveWorkflowRuntimeAgents(targetRoot, selectedAgents);

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
  return Boolean(agent?.linkFile);
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
    hasEnvLocal: fs.existsSync(path.join(projectRoot, '.env.local')),
    existingEnvVars: {},
    agentsMdSize: 0,
    claudeMdSize: 0,
    agentsMdLines: 0,
    claudeMdLines: 0,
    // Project tools status — the Kernel issue store is always present (it
    // auto-provisions on first use), so issue tracking needs no install probe.
    hasBeads: true,
    hasSkills: isSkillsInitialized(),
    beadsInstallType: 'kernel',
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
  if (status.hasAgentsMd) {
    status.type = 'upgrade'; // Full forge installation exists
  } else if (status.hasEnvLocal) {
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

  // Show what was/will be auto-installed. Both Claude and Cursor read a
  // project-local MCP config, so Forge auto-wires both (no manual step needed).
  if (selectedAgents.includes('claude')) {
    console.log('  ✓ Auto-installed for Claude Code (.mcp.json)');
  }
  if (selectedAgents.includes('cursor')) {
    console.log('  ✓ Auto-installed for Cursor (.cursor/mcp.json)');
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
function setupClaudeAgent(_skipFiles) {
  // _skipFiles is accepted for call-site arity parity only; it is unused because
  // this skills-only surface writes scripts unconditionally (no skip prompts).
  // Skills-only surface: per-skill SKILL.md dirs are populated by createAgentSkill.
  //
  // Claude receives workflow/TDD/security/documentation policy through the
  // CLAUDE.md → AGENTS.md instruction projection, NOT always-on `.claude/rules/*`
  // files — those would triple-deliver the same policy into every session as
  // token bloat. See lib/rules-sync.js and lib/harness-capability-matrix.js.
  // Only Cursor has a first-class native rule surface (rendered by setupCursorAgent).

  // Copy scripts
  const scriptSrc = path.join(packageDir, '.claude/scripts/load-env.sh');
  copyFile(scriptSrc, '.claude/scripts/load-env.sh');
}

// Helper: Setup Cursor agent


// Helper: Setup Cursor agent
async function setupCursorAgent() {
  // Drop the deprecated root config, but NEVER destroy a user's hand-authored
  // `.cursorrules` — it predates AGENTS.md, so real users have curated ones.
  const { removed, backupPath } = backupAndRemoveLegacyCursorRules(projectRoot);
  if (removed) {
    console.log(
      `  Removed: .cursorrules (deprecated — Cursor reads AGENTS.md + .cursor/rules/*.mdc); ` +
      `backed up to ${path.basename(backupPath)}`,
    );
  }
  await generateCursorConfig(projectRoot, { overwrite: false });
  console.log('  Created: Cursor native rules');
}

// Helper: back up + remove a deprecated `.cursorrules` without data loss.
// Copies to `.cursorrules.bak` (then numbered `.bak.1`, `.2`, … so a repeat never
// clobbers an earlier snapshot) before deleting. Mirrors the markerless AGENTS.md
// backup above. Exported for direct testing.
function backupAndRemoveLegacyCursorRules(root) {
  const legacy = path.join(root, '.cursorrules');
  if (!fs.existsSync(legacy)) return { removed: false };

  let backupPath = path.join(root, '.cursorrules.bak');
  if (fs.existsSync(backupPath)) {
    let suffix = 1;
    while (fs.existsSync(path.join(root, `.cursorrules.bak.${suffix}`))) {
      suffix += 1;
    }
    backupPath = path.join(root, `.cursorrules.bak.${suffix}`);
  }
  fs.copyFileSync(legacy, backupPath);
  fs.rmSync(legacy, { force: true });
  return { removed: true, backupPath };
}

// Helper: Create skill file for agent


// Helper: Create skill file for agent
function createAgentSkill(agent, agentKey) {
  if (agentKey === 'codex') {
    createCodexSkills();
    return;
  }

  if (!agent.hasSkill || !agent.skillsDir) return;

  // Skills-only surface: populate every canonical skill into the agent skills dir
  // (.claude/skills, .cursor/skills) from the packaged canonical `skills/` source.
  // clean:false so a rerun/upgrade overwrites Forge's skills without deleting
  // user-authored or third-party skills that share these shared agent dirs.
  const { written } = populateAgentSkills({
    sourceRoot: packageDir,
    targetSkillsDir: path.join(projectRoot, agent.skillsDir),
    clean: false,
  });
  console.log(`  Created: ${written.length} skills in ${agent.skillsDir}/`);
}

// Helper: Create Codex per-stage skills from canonical commands
function createCodexSkills() {
  const installPlan = buildCodexSkillInstallPlan(packageDir, { env: process.env, homeDir: os.homedir() });
  const installRoot = formatCodexSkillsInstallDir({ env: process.env, homeDir: os.homedir() });

  CODEX_SETUP_REPORT = {
    installRoot,
    skillCount: installPlan.length,
    repoSkillsDir: CODEX_REPO_SKILLS_DIR,
    repoSkillCount: 0,
    status: 'complete',
    message: '',
  };

  // Repo-local discovery mirror: generate `.agents/skills/<name>/SKILL.md` from
  // the canonical skills/ source. This is Codex's documented repo-scope discovery
  // path (scanned cwd → repo root) and is committed, so a teammate who clones the
  // repo WITHOUT running `forge setup` still gets Forge skills/stages discovered.
  // Independent of the GLOBAL $CODEX_HOME install below (which needs canonical
  // packaging templates) — so it runs before the install-plan early return.
  try {
    const { written } = populateCodexRepoSkills({ sourceRoot: packageDir, projectRoot });
    CODEX_SETUP_REPORT.repoSkillCount = written.length;
    console.log(`  Created: ${written.length} repo-local Codex skills in ${CODEX_REPO_SKILLS_DIR}/ (commit for teammate discovery)`);
  } catch (error) {
    addSetupNote(`Codex repo-local skill generation failed for ${CODEX_REPO_SKILLS_DIR}: ${error.message}`);
    console.log(`  Warning: could not generate repo-local Codex skills in ${CODEX_REPO_SKILLS_DIR} (${error.message})`);
  }

  if (installPlan.length === 0) {
    CODEX_SETUP_REPORT.status = 'partial';
    CODEX_SETUP_REPORT.message = 'Codex setup could not find the packaged stage skill templates.';
    addSetupNote(CODEX_SETUP_REPORT.message);
    console.log('  Warning: Codex stage skill templates were not found in the Forge package');
    return CODEX_SETUP_REPORT;
  }

  let failed = 0;
  for (const entry of installPlan) {
    if (!writeManagedAbsoluteFile(entry.absolutePath, entry.content, entry.displayPath)) {
      failed += 1;
    }
  }

  if (failed > 0) {
    CODEX_SETUP_REPORT.status = 'partial';
    CODEX_SETUP_REPORT.message = `Codex repo instructions installed, but skills are not discoverable in this environment. Forge could not install ${failed}/${installPlan.length} Codex skills into ${installRoot}. Use \`bunx forge status\`, \`bunx forge plan\`, and the other Forge CLI stages until global Codex skills can be installed.`;
    addSetupNote(CODEX_SETUP_REPORT.message);
    console.log(`  Warning: Codex skill install incomplete (${installPlan.length - failed}/${installPlan.length}) -> ${installRoot}`);
    return CODEX_SETUP_REPORT;
  }

  CODEX_SETUP_REPORT.message = `Codex setup complete — installed ${installPlan.length} stage skills to ${installRoot}`;
  console.log(`  Installed: Codex stage skills (${installPlan.length}) -> ${installRoot}`);
  return CODEX_SETUP_REPORT;
}

// Helper: Setup MCP config for Claude


// Helper: Setup MCP config for Claude
//
// Read → merge → write (idempotent). A pre-existing `.mcp.json` is MERGED, not
// skipped: the old skip-if-exists behavior silently refused to add the Context7
// server whenever any config already existed. User/other servers are preserved.
function setupClaudeMcpConfig() {
  const { existed, skipped, backup } = renderMcpConfig({
    harness: 'claude',
    targetRoot: projectRoot,
    descriptors: [CONTEXT7_MCP_DESCRIPTOR],
  });
  if (skipped) {
    // Existing .mcp.json was unparseable (JSONC/trailing comma): renderMcpConfig
    // left it untouched and backed it up rather than clobber the user's servers.
    // Report that honestly instead of a false "merged" success.
    console.log(
      `  Skipped: .mcp.json is not valid JSON — left untouched to avoid data loss`
      + `${backup ? ` (backed up to ${backup})` : ''}. Add the Context7 MCP server manually.`,
    );
    return;
  }
  console.log(
    existed
      ? '  Updated: .mcp.json (merged Context7 MCP, preserved existing servers)'
      : '  Created: .mcp.json with Context7 MCP',
  );
}

// Helper: Setup MCP config for Cursor (project-local .cursor/mcp.json).
// Cursor reads a project-local MCP config, so this is a real native delivery
// (mirrors setupClaudeMcpConfig). Read → merge → write, preserving user servers.
function setupCursorMcpConfig() {
  const { existed, skipped, backup } = renderMcpConfig({
    harness: 'cursor',
    targetRoot: projectRoot,
    descriptors: [CONTEXT7_MCP_DESCRIPTOR],
  });
  if (skipped) {
    console.log(
      `  Skipped: .cursor/mcp.json is not valid JSON — left untouched to avoid data loss`
      + `${backup ? ` (backed up to ${backup})` : ''}. Add the Context7 MCP server manually.`,
    );
    return;
  }
  console.log(
    existed
      ? '  Updated: .cursor/mcp.json (merged Context7 MCP, preserved existing servers)'
      : '  Created: .cursor/mcp.json with Context7 MCP',
  );
}

// Safe SAFETY defaults are ON by default (non-surprising) but fully opt-out-able.
// Set FORGE_SKIP_SAFETY_DEFAULTS=1 (or `true`) to skip rendering the permission /
// ignore defaults — Forge then leaves those surfaces entirely to the user.
function safetyDefaultsEnabled() {
  const flag = String(process.env.FORGE_SKIP_SAFETY_DEFAULTS || '').trim().toLowerCase();
  return !(flag === '1' || flag === 'true' || flag === 'yes');
}

// Helper: Render safe Claude tool-permission defaults into .claude/settings.json.
// Read -> merge -> write (idempotent). Preserves the user's existing settings and
// allow/deny/ask entries; an unparseable file is backed up and left untouched.
function setupClaudePermissions() {
  if (!safetyDefaultsEnabled()) {
    console.log('  Skipped: .claude/settings.json permissions (FORGE_SKIP_SAFETY_DEFAULTS set)');
    return;
  }
  const { existed, skipped, backup } = renderClaudePermissions({ targetRoot: projectRoot });
  if (skipped) {
    console.log(
      '  Skipped: .claude/settings.json is not valid JSON — left untouched to avoid data loss'
      + `${backup ? ` (backed up to ${backup})` : ''}. Add safe permissions manually.`,
    );
    return;
  }
  console.log(
    existed
      ? '  Updated: .claude/settings.json (merged safe permission defaults, preserved your entries)'
      : '  Created: .claude/settings.json with safe permission defaults',
  );
}

// Helper: Render safe .cursorignore defaults (AI read/index boundary).
// Read -> merge -> write (idempotent). Preserves user lines; only appends missing
// default patterns (secrets/.env/node_modules/build artifacts).
function setupCursorIgnore() {
  if (!safetyDefaultsEnabled()) {
    console.log('  Skipped: .cursorignore defaults (FORGE_SKIP_SAFETY_DEFAULTS set)');
    return;
  }
  const { existed } = renderCursorIgnore({ targetRoot: projectRoot });
  console.log(
    existed
      ? '  Updated: .cursorignore (appended safe defaults, preserved your entries)'
      : '  Created: .cursorignore with safe defaults',
  );
}

// Helper: Setup native HOOK config for Claude (project-local .claude/settings.json).
// Projects Forge's TDD-gate + protected-path enforcement onto Claude's native hook
// surface (a `hooks` block). Read → merge → write, preserving user hooks; an
// unparseable settings.json is backed up and left untouched (data-loss safe).
function setupClaudeHooksConfig() {
  const { existed, skipped, backup, wrote } = renderHookConfig({
    harness: 'claude',
    targetRoot: projectRoot,
  });
  if (skipped) {
    console.log(
      `  Skipped: .claude/settings.json is not valid JSON — left untouched to avoid data loss`
      + `${backup ? ` (backed up to ${backup})` : ''}. Add the Forge hooks block manually.`,
    );
    return;
  }
  if (wrote) {
    console.log(
      existed
        ? '  Updated: .claude/settings.json (merged Forge hooks, preserved existing hooks)'
        : '  Created: .claude/settings.json with Forge hooks',
    );
  }
}

// Helper: Setup native HOOK config for Cursor (project-local .cursor/hooks.json,
// Cursor 1.7+). Mirrors setupClaudeHooksConfig. Read → merge → write, preserving
// user hooks; unparseable config is backed up and left untouched.
function setupCursorHooksConfig() {
  const { existed, skipped, backup, wrote } = renderHookConfig({
    harness: 'cursor',
    targetRoot: projectRoot,
  });
  if (skipped) {
    console.log(
      `  Skipped: .cursor/hooks.json is not valid JSON — left untouched to avoid data loss`
      + `${backup ? ` (backed up to ${backup})` : ''}. Add the Forge hooks manually.`,
    );
    return;
  }
  if (wrote) {
    console.log(
      existed
        ? '  Updated: .cursor/hooks.json (merged Forge hooks, preserved existing hooks)'
        : '  Created: .cursor/hooks.json with Forge hooks',
    );
  }
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
async function setupAgent(agentKey, skipFiles = {}) {
  const agent = AGENTS[agentKey];
  if (!agent) return;

  console.log(`\nSetting up ${agent.name}...`);
  if (agent.supportStatus === 'deprecated') {
    console.log(`  Warning: ${agent.name} is in deprecated compatibility mode; Forge will scaffold skill files only.`);
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

  // Create SKILL.md or Codex stage skills
  createAgentSkill(agent, agentKey);

  // Setup MCP configs (project-local, native for both harnesses)
  if (agentKey === 'claude') {
    setupClaudeMcpConfig();
    // Native safety surface: declarative tool-permission allowlist.
    setupClaudePermissions();
  }
  if (agent.customSetup === 'cursor') {
    setupCursorMcpConfig();
    // Native safety surface: AI read/index ignore boundary.
    setupCursorIgnore();
  }

  // Setup native HOOK configs (project-local, native for both harnesses).
  // Projects Forge's TDD-gate + protected-path enforcement onto each harness's
  // native hook surface. Codex hooks are GLOBAL-config scope and intentionally
  // not written at project setup (see lib/hook-renderer.js).
  if (agentKey === 'claude') {
    setupClaudeHooksConfig();
  }
  if (agent.customSetup === 'cursor') {
    setupCursorHooksConfig();
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

  // Default behavior: Binary y/n for files with markers
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
 * Setup agents with progress indication
 * Delegates to setupSelectedAgents to avoid duplicate implementations (S4144)
 */


/**
 * Setup agents with progress indication
 * Delegates to setupSelectedAgents to avoid duplicate implementations (S4144)
 */
async function setupAgentsWithProgress(selectedAgents, skipFiles) {
  await setupSelectedAgents(selectedAgents, skipFiles);
}

/**
 * Display final setup summary
 */


/**
 * Display final setup summary
 */
function displaySetupSummary(selectedAgents) {
  const partial = getSetupSummaryStatus() === 'partial';
  console.log('');
  console.log('==============================================');
  console.log(`  Forge v${VERSION} Setup ${partial ? 'Partially Complete' : 'Complete'}!`);
  console.log('==============================================');
  console.log('');
  console.log('What\'s installed:');
  console.log('  - AGENTS.md (universal instructions)');

  selectedAgents.forEach(key => {
    const agent = AGENTS[key];
    if (agent.linkFile) {
      console.log(`  - ${agent.linkFile} (${agent.name})`);
    }
    if (key === 'codex') {
      const skillCount = CODEX_SETUP_REPORT?.skillCount ?? listCodexSkillEntries(packageDir).length;
      const codexRoot = CODEX_SETUP_REPORT?.installRoot || formatCodexSkillsInstallDir({ env: process.env, homeDir: os.homedir() });
      console.log(`  - ${codexRoot}/<stage>/SKILL.md (${skillCount} stage skills)`);
      const repoSkillCount = CODEX_SETUP_REPORT?.repoSkillCount ?? 0;
      console.log(`  - ${CODEX_REPO_SKILLS_DIR}/<skill>/SKILL.md (${repoSkillCount} repo-local skills — commit for teammate discovery)`);
    } else if (agent.hasSkill && agent.skillsDir) {
      console.log(`  - ${agent.skillsDir}/<skill>/SKILL.md`);
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
  printSetupNotes();

  // Issue store status — the Kernel store is always present (auto-provisioned)
  if (KERNEL_STORE_READY) {
    console.log('  ✓ Kernel issue store - Track work: forge ready');
  } else {
    console.log('  ⚠ Kernel issue store - not provisioned; run: forge doctor');
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
  };

  // Ask about overwriting existing files
  await promptForFileOverwrite(question, 'agentsMd', projectStatus.hasAgentsMd, skipFiles);

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

  // Setup Claude first if selected, then setup remaining agents
  if (selectedAgents.includes('claude')) {
    await setupAgent('claude', skipFiles);
  }

  // Setup each selected agent with progress indication
  await setupAgentsWithProgress(selectedAgents, skipFiles);

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

  // First-run completeness: point at `forge init` when config is still absent (5bdc91d3).
  printForgeInitNextStep();
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
// Copy the Forge hook scripts (check-tdd.js + the native-hook adapter) into the
// project's .forge/hooks/. Runs UNCONDITIONALLY — independent of the lefthook binary.
// The native harness hooks rendered by lib/hook-renderer.js invoke forge-native-hook.js,
// which delegates the TDD gate to check-tdd.js, so BOTH must always be installed; if we
// only copied them on the lefthook path, a machine without lefthook would get native
// hooks pointing at an adapter that was never installed.
function installForgeHookScripts() {
  const targetHooks = path.join(projectRoot, '.forge/hooks');
  for (const name of ['check-tdd.js', 'forge-native-hook.js']) {
    const src = path.join(packageDir, '.forge/hooks', name);
    if (!fs.existsSync(src)) continue;
    if (!fs.existsSync(targetHooks)) fs.mkdirSync(targetHooks, { recursive: true });
    const dest = path.join(targetHooks, name);
    if (copyFile(src, dest)) {
      console.log(`  ✓ Created .forge/hooks/${name}`);
      try {
        fs.chmodSync(dest, 0o755); // NOSONAR — 755 is intentional: hook scripts must be executable
      } catch (err) {
        console.warn('chmod not available (Windows):', err.message);
      }
    }
  }
}

function installGitHooks() { // NOSONAR — Extracted as-is from bin/forge.js; complexity reduction deferred
  console.log('Installing git hooks (TDD enforcement)...');

  // Install the Forge hook SCRIPTS first, unconditionally: they back BOTH the lefthook
  // pre-commit gate AND the native harness hooks that forge setup renders regardless of
  // whether the lefthook binary is present.
  installForgeHookScripts();

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

  try {
    // Copy lefthook.yml to project root
    const lefthookTarget = path.join(projectRoot, 'lefthook.yml');
    if (!fs.existsSync(lefthookTarget)) {
      if (copyFile(lefthookConfig, 'lefthook.yml')) {
        console.log('  ✓ Created lefthook.yml');
      }
    }

    // (The Forge hook scripts — check-tdd.js + forge-native-hook.js — are installed
    // unconditionally by installForgeHookScripts() above, before this lefthook path.)

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
    console.warn('  ⚠ Lefthook hooks were not installed; raw git push remains unsafe in this worktree.');
    console.log('  ℹ Lefthook not found. Install it:');
    console.log('    bun add -d lefthook  (recommended)');
    console.log('    OR: bun add -g lefthook  (global)');
    console.log('    Then run: bunx lefthook install');
    console.log(`  Run ${PKG_MANAGER} install in this worktree, then rerun setup.`);
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
    console.warn('  ⚠ Lefthook repair failed; raw git push remains unsafe in this worktree.');
    console.log(`  ⚠ ${status.message}`);
    console.log(`  Run ${PKG_MANAGER} install in this worktree, then rerun setup.`);
    console.log('');
    return { attempted: true, repaired: false, error: err };
  }
}

// Ensure the local Forge Kernel issue store exists and is migrated.
//
// The Kernel is a single-machine SQLite store in the git common dir; building
// the migrated deps runs broker.initialize() (idempotent), so the DB + schema
// exist before first use. There is no external CLI to install — issue tracking
// ships with Forge. Best-effort: never throws, so setup proceeds even if the
// SQLite runtime is unavailable (the first kernel command would migrate it
// later anyway).
async function ensureKernelIssueStore() {
  try {
    const deps = await buildMigratedKernelIssueDeps({ projectRoot });
    const handle = deps.kernelBroker || deps.kernelDriver;
    if (handle && typeof handle.close === 'function') {
      try {
        await handle.close();
      } catch (_closeErr) { // NOSONAR — best-effort cleanup of the migration handle
        // Closing the migration handle is best-effort; the process is short-lived.
      }
    }
    KERNEL_STORE_READY = true;
    return true;
  } catch (err) {
    KERNEL_STORE_READY = false;
    console.log(`  ⚠ Could not provision the Kernel issue store: ${err.message}`);
    addSetupNote(`Kernel issue store not provisioned: ${err.message}. Run \`forge doctor\` to inspect.`);
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

// Ensure the issue store during interactive setup. No prompt: the Forge Kernel
// ships with Forge and auto-provisions, so there is nothing to install or pick.
async function promptBeadsSetup(_question) {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Issue Store (Forge Kernel)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('');

  const ready = await ensureKernelIssueStore();
  if (ready) {
    console.log('✓ Kernel issue store ready (single-machine; team sync not configured)');
  }
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
  console.log('• Issue tracking (Forge Kernel) - zero-install, git-backed');
  console.log('  Persists tasks across sessions, tracks dependencies.');
  console.log('  Command: forge ready, forge create, forge close');
  console.log('');
  console.log('• Skills - Universal SKILL.md management');
  console.log('  Manage AI agent skills across all agents.');
  console.log('  Command: skills create, skills list, skills sync');
  console.log('');

  // Use helper functions to reduce complexity
  await promptBeadsSetup(question);
  await promptSkillsSetup(question);
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
      console.warn('  ⚠ Lefthook repair failed; raw git push remains unsafe in this worktree.');
      console.log(`  ⚠ ${status.message}`);
      console.log(`  Run ${PKG_MANAGER} install in this worktree, then rerun setup.`);
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

// Helper: Auto-setup tools (Skills) in quick mode - extracted to reduce cognitive complexity


// Helper: Auto-setup tools (Skills) in quick mode - extracted to reduce cognitive complexity
async function autoSetupToolsInQuickMode() {
  // Issue store: ensure the Forge Kernel store exists (auto-provisioned, no CLI)
  await ensureKernelIssueStore();

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

// Auto-import an existing Beads store into the Kernel during setup.
// Idempotent and CLI-free: reuses the `forge migrate --from beads` spine, which
// reads the committed Beads jsonl sidecars directly (no external issue-tracker
// binary), so it works even when the legacy SQL backend is offline. Failures
// degrade to a setup note rather than aborting setup. Returns the migrate
// outcome for callers/tests.
async function autoMigrateBeadsToKernel(opts = {}) {
  const migrateModule = require('./migrate');
  let outcome;
  try {
    outcome = await migrateModule.autoMigrateBeadsIfPresent(projectRoot, opts);
  } catch (err) {
    addSetupNote(`Beads → Kernel auto-migration failed: ${err.message}`);
    return { migrated: false };
  }

  if (!outcome.migrated) {
    if (outcome.result && outcome.result.success === false) {
      addSetupNote(`Beads → Kernel auto-migration skipped: ${outcome.result.error}`);
    }
    return outcome;
  }

  const { imported, gaps } = outcome.result;
  const inserted = imported.issues.inserted;
  const skipped = imported.issues.skipped;
  if (inserted > 0) {
    let line = `  ✓ Migrated ${inserted} issue(s) from Beads to the Kernel`;
    if (gaps && gaps.count > 0) {
      line += ` (${gaps.count} field gap(s): ${gaps.items.map(g => g.field).join(', ')})`;
    }
    console.log(line);
  } else {
    console.log(`  ✓ Beads store already present in the Kernel (${skipped} issue(s))`);
  }
  return outcome;
}

// Install git hooks for a target project root without a full setup run.
// Reuses the same lefthook install path setup performs so `forge init` can
// reach a hook-active state (closing the init → HOOKS_NOT_ACTIVE catch-22).
// Skips silently when there is no package.json to attach hooks to — keeps
// `forge init` lightweight for bare/non-node repos and avoids surprise installs.
// Restores mutated module state afterward.
async function ensureGitHooksInstalled(targetRoot = projectRoot) {
  if (!fs.existsSync(path.join(targetRoot, 'package.json'))) {
    return { installed: false, reason: 'no-package-json' };
  }

  const previousRoot = projectRoot;
  const previousInteractive = NON_INTERACTIVE;
  const previousPkgManager = PKG_MANAGER;
  projectRoot = targetRoot;
  NON_INTERACTIVE = true;
  PKG_MANAGER = detectPackageManager();
  try {
    autoInstallLefthook();
    await handleHuskyMigration();
    installGitHooks();
    return { installed: true };
  } finally {
    projectRoot = previousRoot;
    NON_INTERACTIVE = previousInteractive;
    PKG_MANAGER = previousPkgManager;
  }
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
    requireGithubCli: true,
    requireJq: true,
  });
  console.log('');

  // Copy AGENTS.md (actionLog tracks it via copyFile). Quick mode is
  // non-interactive and overwrites unconditionally, so back up a markerless
  // (pre-Forge) AGENTS.md first to avoid silent data loss (kernel issue a5399f3d).
  const agentsSrc = path.join(packageDir, 'AGENTS.md');
  backupMarkerlessAgentsMd();
  copyFile(agentsSrc, 'AGENTS.md');
  console.log('');

  // Setup core documentation
  setupCoreDocs();
  console.log('');

  ensureWorkflowShellPolicy(selectedAgents);

  // Auto-install lefthook if missing
  autoInstallLefthook();

  // Auto-setup project tools (Kernel issue store, Skills)
  await autoSetupToolsInQuickMode();

  // Auto-import an existing Beads store into the Kernel (idempotent, CLI-free)
  await autoMigrateBeadsToKernel();

  // Setup Claude first if selected, then setup remaining agents
  if (selectedAgents.includes('claude')) {
    await setupAgent('claude');
  }
  await setupSelectedAgents(selectedAgents);
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
  console.log(renderSetupSummary(actionLog, selectedAgents, VERBOSE_MODE, { status: getSetupSummaryStatus() }));
  printSetupNotes();
  // First-run completeness: point at `forge init` when config is still absent (5bdc91d3).
  printForgeInitNextStep();
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
  if (projectStatus.hasEnvLocal) console.log('  - .env.local');
  console.log('');
}

// Helper: Prompt for overwrite decisions - extracted to reduce cognitive complexity


// Helper: Prompt for overwrite decisions - extracted to reduce cognitive complexity
async function promptForOverwriteDecisions(question, projectStatus, flags = {}) {
  const skipFiles = {
    agentsMd: false,
  };

  if (flags.keep) {
    if (projectStatus.hasAgentsMd) {
      skipFiles.agentsMd = true;
      console.log('  Keeping existing AGENTS.md (--keep)');
    }
    return skipFiles;
  }

  if (projectStatus.hasAgentsMd) {
    const overwriteAgents = await askYesNo(question, 'Found existing AGENTS.md. Overwrite?', true);
    skipFiles.agentsMd = !overwriteAgents;
    console.log(overwriteAgents ? '  Will overwrite AGENTS.md' : '  Keeping existing AGENTS.md');
  }

  if (projectStatus.type !== 'fresh') {
    console.log('');
  }

  return skipFiles;
}

// Helper: Setup all selected agents - extracted to reduce cognitive complexity


// Helper: Setup all selected agents - extracted to reduce cognitive complexity
async function setupSelectedAgents(selectedAgents, skipFiles) {
  const totalAgents = selectedAgents.length;
  for (const [index, agentKey] of selectedAgents.entries()) {
    const agent = AGENTS[agentKey];
    console.log(`\n[${index + 1}/${totalAgents}] Setting up ${agent.name}...`);
    if (agentKey !== 'claude') { // Claude already done above
      await setupAgent(agentKey, skipFiles);
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

  // Check agent-independent prerequisites first
  checkPrerequisites({
    requireBeadsCli: true,
    requireGithubCli: false,
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

  // Check GitHub CLI prerequisite now that selectedAgents is known
  if (requiresGithubCliForSetup(selectedAgents)) {
    checkPrerequisites({ requireGithubCli: true });
  }

  console.log('');
  console.log('Installing Forge workflow...');

  // Setup AGENTS.md (delegated to helper)
  setupAgentsMdFile(flags, skipFiles);
  console.log('');

  // Setup core documentation
  setupCoreDocs();
  console.log('');

  // Setup Claude first if selected (delegated to helper), then remaining agents
  if (selectedAgents.includes('claude')) {
    await setupAgent('claude', skipFiles);
  }

  // Setup each selected agent with progress indication (delegated to helper)
  await setupSelectedAgents(selectedAgents, skipFiles);
  ensureWorkflowRuntimeAssets(selectedAgents);

  // Handle external services step (delegated to helper)
  await handleExternalServicesStep(flags, rl, question, selectedAgents, projectStatus);

  setupCompleted = true;
  rl.close();

  // Display final summary (delegated to helper)
  displaySetupSummary(selectedAgents);

  // First-run is only complete once workflow config exists — nudge `forge init`
  // when it does not (this path never writes .forge/config.yaml). (5bdc91d3)
  printForgeInitNextStep();
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

    // Claude-specific files (skills are listed by the per-skill block below).
    // Claude gets policy via CLAUDE.md → AGENTS.md, not always-on .claude/rules/* files.
    if (agentKey === 'claude') {
      addFileAction('.claude/scripts/load-env.sh', 'Environment loader script');
      addFileAction('.mcp.json', 'MCP server configuration');
      addFileAction('CLAUDE.md', 'Claude root config (links to AGENTS.md)');
    }

    if (needsWorkflowRuntimeAssets([agentKey])) {
      for (const assetPath of getWorkflowRuntimeAssets()) {
        addFileAction(assetPath, 'Workflow runtime asset');
      }
    }

    // Cursor-specific files (rendered from the canonical rules/ source)
    if (agent.customSetup === 'cursor') {
      addFileAction('.cursor/rules/forge-workflow.mdc', 'Cursor workflow rule');
      addFileAction('.cursor/rules/tdd-enforcement.mdc', 'Cursor TDD rule');
      addFileAction('.cursor/rules/security-scanning.mdc', 'Cursor security rule');
      addFileAction('.cursor/rules/documentation.mdc', 'Cursor documentation rule');
    }

    // Agent skill
    if (agentKey === 'codex') {
      const skillEntries = buildCodexSkillInstallPlan(packageDir, { env: process.env, homeDir: os.homedir() });
      for (const entry of skillEntries) {
        addFileAction(entry.displayPath, 'Codex stage skill');
      }
    } else if (agent.hasSkill && agent.skillsDir) {
      // Skills ship whole directories (SKILL.md + any nested assets); list every
      // file so --dry-run reflects the real filesystem changes, not just SKILL.md.
      for (const skill of listCanonicalSkills(packageDir)) {
        for (const rel of listFilesRecursive(skill.sourcePath)) {
          addFileAction(`${agent.skillsDir}/${skill.name}/${rel}`, 'Forge skill');
        }
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
  addFileAction('.forge/hooks/forge-native-hook.js', 'Native-hook enforcement adapter (Claude/Cursor)');

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
    requireGithubCli: requiresGithubCliForSetup(agents),
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
  };

  // Setup Claude first if selected, then remaining agents
  if (agents.includes('claude')) {
    await setupAgent('claude', skipFiles);
  }
  await setupSelectedAgents(agents, skipFiles);
  ensureWorkflowRuntimeAssets(agents);
  ensureWorkflowShellPolicy(agents);
  repairDeclaredLefthookDependency(agents);

  // Detect Husky and migrate before installing Lefthook hooks
  await handleHuskyMigration();

  // Install git hooks for TDD enforcement
  console.log('');
  installGitHooks();

  // Auto-import an existing Beads store into the Kernel (idempotent, CLI-free)
  await autoMigrateBeadsToKernel();

  // External services (unless skipped)
  await handleExternalServices(skipExternal, agents);

  // --sync flag: scaffold Beads GitHub sync workflows without prompting
  if (SYNC_ENABLED) {
    await handleSyncScaffold();
  }

  // Progressive setup summary
  console.log('');
  console.log(renderSetupSummary(actionLog, agents, VERBOSE_MODE, { status: getSetupSummaryStatus() }));
  printSetupNotes();
  // First-run completeness: point at `forge init` when config is still absent (5bdc91d3).
  printForgeInitNextStep();
  console.log('');
}

// Helper: Scaffold Beads GitHub sync when --sync flag is provided


// Helper: Scaffold Beads GitHub sync when --sync flag is provided
async function handleSyncScaffold() {
  console.log('');
  console.log('Beads GitHub sync scaffolding is deprecated (--sync).');
  try {
    const result = scaffoldBeadsSync(projectRoot, packageDir);
    console.log(`  ${result.message}`);
    for (const f of result.filesRemoved || []) {
      console.log(`  Removed deprecated sync file: ${f}`);
    }
  } catch (err) {
    console.error(`  Error scaffolding GitHub-Beads sync: ${err.message}`);
  }
}

// Helper: Handle setup command in non-quick mode


// Helper: Handle setup command in non-quick mode
async function handleSetupCommand(selectedAgents, flags) {
  if (!Array.isArray(selectedAgents) || selectedAgents.length === 0) {
    return runInteractiveSetupFallback(flags);
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

async function runInteractiveSetupFallback(flags, interactiveSetup = interactiveSetupWithFlags) {
  return interactiveSetup(flags);
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
 * legacy aliases such as `claude-code`.
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
  };

  pluginManager.getAllPlugins().forEach((plugin, id) => {
    const dirs = getRepoRelativePluginDirectories(plugin);
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
 * @param {string} agentName - Agent slug (e.g. 'cursor', 'codex')
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
  minimal: false,
  standard: false,
  full: false,
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
  '--minimal': { minimal: true },
  '--standard': { standard: true },
  '--full': { full: true },
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
    minimal: Boolean(flags.minimal || setupFlags.minimal),
    standard: Boolean(flags.standard || setupFlags.standard),
    full: Boolean(flags.full || setupFlags.full),
    skipExternal: Boolean(flags.skipExternal || setupFlags.skipExternal),
    sync: Boolean(flags.sync || setupFlags.sync),
    symlink: Boolean(flags.symlink || setupFlags.symlink),
    nonInteractive: Boolean(flags.nonInteractive || setupFlags.nonInteractive),
  };
}

function normalizeDetectedAgent(agentName) {
  const aliases = {
    'claude-code': 'claude',
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
    resetSetupNotes();
    PKG_MANAGER = detectPackageManager();

    if (flags.minimal || flags.standard || flags.full) {
      const selectedProfiles = [];
      if (flags.minimal) selectedProfiles.push('minimal');
      if (flags.standard) selectedProfiles.push('standard');
      if (flags.full) selectedProfiles.push('full');
      if (selectedProfiles.length > 1) {
        return {
          success: false,
          error: `Conflicting profile flags: ${selectedProfiles.join(', ')}. Choose exactly one of --minimal, --standard, or --full.`,
        };
      }

      const [profile] = selectedProfiles;
      return initCommand.handler([`--profile=${profile}`, '--yes', ...(flags.force ? ['--force'] : [])], flags, projectRoot);
    }

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

    if (flags.sync && selectedAgents.length === 0) {
      await handleSyncScaffold();
      return { success: true };
    }

    if (selectedAgents.length > 0) {
      await handleSetupCommand(selectedAgents, flags);
      return { success: true };
    }

    await runInteractiveSetupFallback(flags);
    return { success: true };
  },

  // Expose internals for testing and cross-command use
  checkPrerequisites,
  setupCoreDocs,
  displaySetupSummary,
  printForgeInitNextStep,
  backupMarkerlessAgentsMd,
  setupAgent,
  quickSetup,
  interactiveSetupWithFlags,
  _runInteractiveSetupFallback: runInteractiveSetupFallback,
  dryRunSetup,
  handleSetupCommand,
  executeSetup,
  handleExternalServices,
  _interactiveSetup,
  configureExternalServices,
  configureDefaultExternalServices,
  installSkillsWithMethod,
  installViaBunx,
  autoInstallLefthook,
  autoSetupToolsInQuickMode,
  autoMigrateBeadsToKernel,
  ensureGitHooksInstalled,
  setupClaudeMcpConfig,
  setupCursorMcpConfig,
  setupClaudePermissions,
  setupCursorIgnore,
  setupClaudeHooksConfig,
  setupCursorHooksConfig,
  displayMcpStatus,
  displayEnvTokenResults,
  minimalInstall,
  determineSelectedAgents,
  handlePathSetup,
  detectConfiguredAgents,
  removeAgentFiles,
  parseSetupFlags,
  mergeSetupFlags,
  getWorkflowRuntimeAssets,
  findMissingWorkflowRuntimeAssets,
  ensureWorkflowShellPolicy,
  repairWorkflowRuntimeAssets,
  repairRuntimeReadiness,
  _showBanner: showBanner,
  backupAndRemoveLegacyCursorRules,

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
