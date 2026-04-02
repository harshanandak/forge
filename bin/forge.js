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
 *   bunx forge setup --agents claude,cursor
 *
 * CLI Flags:
 *   --path, -p <dir>     Target project directory (creates if needed)
 *   --quick, -q          Use all defaults, minimal prompts
 *   --skip-external      Skip external services configuration
 *   --agents <list>      Specify agents (--agents claude cursor OR --agents=claude,cursor)
 *   --all                Install for all available agents
 *   --detect             Auto-detect configured agents for setup
 *   --keep               Keep existing setup-managed files when possible
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
// child_process no longer needed — setup functions extracted to lib/commands/setup.js

// Get version from package.json (single source of truth)
const packageDir = path.dirname(__dirname);
const packageJson = require(path.join(packageDir, 'package.json'));
const VERSION = packageJson.version;

// Load PluginManager for discoverable agent architecture
const PluginManager = require('../lib/plugin-manager');
// docs-command and reset logic extracted to lib/commands/docs.js, reset.js, reinstall.js
const { loadCommands } = require('../lib/commands/_registry');
const { validateUserInput } = require('../lib/validation-utils');

// Load incremental setup modules
const { isNonInteractive } = require('../lib/setup-utils');
const setupCommand = require('../lib/commands/setup');

// Get the project root (let allows reassignment after --path flag handling)
let projectRoot = process.env.INIT_CWD || process.cwd();
const args = process.argv.slice(2);

// Non-interactive mode flag (used for CLI messaging in main())
let NON_INTERACTIVE = false;

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
      promptFormat: plugin.setup?.promptFormat || false
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
 * Reads workflow command names from the canonical commands directory, falling back
 * to the legacy .claude/commands path when needed.
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


// Parse CLI flags
function parseFlags() {
  const flags = {
    quick: false,
    skipExternal: false,
    agents: null,
    all: false,
    help: false,
    version: false,
    path: null,
    merge: null,     // 'smart'|'preserve'|'replace'
    type: null,      // 'critical'|'standard'|'simple'|'hotfix'|'docs'|'refactor'
    interview: false, // Force context interview
    budget: null,     // Budget mode for recommend command
    yes: false,       // Non-interactive mode (skip prompts, use defaults)
    nonInteractive: false, // --non-interactive flag (or CI auto-detection)
    force: false,     // Force overwrite even if content is identical
    verbose: false,   // Show file-by-file detail in setup summary
    dryRun: false,    // Preview planned actions without writing files
    symlink: false,   // Create CLAUDE.md as symlink to AGENTS.md (--symlink)
    sync: false,      // Scaffold Beads GitHub sync workflows (--sync)
  };

  for (let i = 0; i < args.length;) {
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
    } else if (arg === '--version' || arg === '-V') {
      flags.version = true;
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
    } else if (arg === '--yes' || arg === '-y') {
      flags.yes = true;
      i++;
    } else if (arg === '--non-interactive') {
      flags.nonInteractive = true;
      i++;
    } else if (arg === '--force') {
      flags.force = true;
      i++;
    } else if (arg === '--verbose') {
      flags.verbose = true;
      i++;
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
      i++;
    } else if (arg === '--symlink') {
      flags.symlink = true;
      i++;
    } else if (arg === '--sync') {
      flags.sync = true;
      i++;
    } else if (arg === '--interview') {
      flags.interview = true;
      i++;
    } else if (arg === '--budget' || arg.startsWith('--budget=')) {
      if (arg.startsWith('--budget=')) {
        flags.budget = arg.split('=')[1];
      } else if (i + 1 < args.length) {
        flags.budget = args[i + 1];
        i++;
      }
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

// Show help text
function showHelp() {
  setupCommand._showBanner();
  console.log('');
  console.log('Usage:');
  console.log('  npx forge setup [options]     Interactive agent configuration');
  console.log('  npx forge recommend           Show recommended tools for your project');
  console.log('  npx forge --version              Show version');
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
  console.log('  --detect             Auto-detect configured agents for setup');
  console.log('  --keep               Keep existing setup-managed files when possible');
  console.log('  --merge <mode>       Merge strategy for existing AGENTS.md files');
  console.log('                       Options: smart (intelligent merge), preserve (keep existing),');
  console.log('                                replace (overwrite with new)');
  console.log('  --type <type>        Set workflow profile type manually');
  console.log('                       Options: critical, standard, simple, hotfix, docs, refactor');
  console.log('  --dry-run            Preview planned actions without writing any files');
  console.log('  --interview          Force context interview (gather project information)');
  console.log('  --budget <mode>      Budget mode for recommend (free, open-source, startup, professional, custom)');
  console.log('  --yes, -y            Non-interactive setup with sensible defaults');
  console.log('                       Defaults to claude agent, skips prompts');
  console.log('  --version, -V        Show version');
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
  console.log('  npx forge setup --detect                 # Auto-select detected agents');
  console.log('  npx forge setup --agents claude --keep   # Preserve existing managed files');
  console.log('  npx forge setup --skip-external          # No service configuration');
  console.log('  npx forge setup --agents claude --quick  # Quick + specific agent');
  console.log('  npx forge setup --yes                    # Non-interactive, defaults to claude');
  console.log('  npx forge setup --yes --agents cursor   # Non-interactive, specific agent');
  console.log('  npx forge setup --all --skip-external    # All agents, no services');
  console.log('  npx forge setup --merge=smart            # Use intelligent merge for existing files');
  console.log('  npx forge setup --type=critical          # Set workflow profile manually');
  console.log('  npx forge setup --interview              # Force context interview');
  console.log('');
  console.log('Also works with bun:');
  console.log('  bunx forge setup --quick');
  console.log('');

  // Append auto-discovered registry commands
  const helpRegistry = loadCommands(path.join(__dirname, '..', 'lib', 'commands'));
  const registryHelp = helpRegistry.getHelp();
  if (registryHelp) {
    console.log('Additional commands:');
    console.log(registryHelp);
    console.log('');
  }
}


async function main() {
  const command = args[0];
  const flags = parseFlags();

  // Detect non-interactive mode for CLI messaging
  NON_INTERACTIVE = flags.nonInteractive || flags.yes || isNonInteractive();

  if (NON_INTERACTIVE) {
    const agentFlag = flags.agents;
    if (agentFlag && agentFlag.length > 0) {
      // flags.agents is a comma-separated string (e.g. "claude,cursor")
      const agentDisplay = agentFlag.replace(/,/g, ', ');
      console.log(`Non-interactive mode: using provided agent selection (${agentDisplay})`);
    } else {
      console.log('Non-interactive mode: using default agent selection (all)');
    }
  }

  // Show help
  if (flags.help) {
    showHelp();
    return;
  }

  // Show version
  if (flags.version) {
    console.log(`Forge v${VERSION}`);
    return;
  }

  // Handle --path option: change to target directory
  if (flags.path) {
    // Update projectRoot after changing directory to maintain state consistency
    projectRoot = setupCommand.handlePathSetup(flags.path);
  }

  // Load command registry (auto-discovered commands from lib/commands/)
  const registry = loadCommands(path.join(__dirname, '..', 'lib', 'commands'));

  // First-run detection: check if Forge is configured in this project
  // Skip for: setup (needs to run), recommend (read-only), docs (read-only),
  //           postinstall (fresh install), registry commands (handle own requirements)
  // Note: help and version already returned above, so no need to check here
  // docs, reset, reinstall now go through registry — no need for individual exemptions
  if (command !== 'setup' && command !== 'recommend'
      && !registry.commands.has(command)
      && process.env.npm_lifecycle_event !== 'postinstall') {
    const agentsMdPath = path.join(projectRoot, 'AGENTS.md');
    if (!fs.existsSync(agentsMdPath)) {
      console.error('[FORGE_SETUP_REQUIRED] Forge is not configured in this project.\n');
      console.error('  Run:  npx forge setup');
      console.error('  Or:   npx forge setup --yes  (non-interactive)\n');
      process.exit(1);
    }
  }

  // Registry command dispatch — auto-discovered commands take priority
  if (registry.commands.has(command)) {
    const cmd = registry.commands.get(command);
    try {
      const result = await cmd.handler(args.slice(1), flags, projectRoot);
      if (result && !result.success) {
        console.error(result.error || result.message || 'Command failed');
        process.exit(1);
      }
    } catch (err) {
      console.error(`Error running '${command}':`, err.message);
      process.exit(1);
    }
    return;
  }

  if (process.env.npm_lifecycle_event === 'postinstall') {
    // Postinstall: show success message only, no file changes
    // Surprising file modifications during npm/bun install break user expectations
    // Detect package manager from lock files for accurate setup instruction
    let runCmd = 'npx';
    if (fs.existsSync(path.join(projectRoot, 'bun.lockb')) || fs.existsSync(path.join(projectRoot, 'bun.lock'))) runCmd = 'bunx';
    else if (fs.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) runCmd = 'pnpm dlx';
    else if (fs.existsSync(path.join(projectRoot, 'yarn.lock'))) runCmd = 'yarn dlx';
    console.log('');
    console.log('  \u2705 Forge installed successfully!');
    console.log('');
    console.log('  To set up in your project:');
    console.log(`    ${runCmd} forge setup`);
    console.log('');
  } else {
    // Explicit invocation with no command: run minimal install
    setupCommand.minimalInstall();
  }
}

// Rollback system extracted to lib/commands/rollback.js (auto-discovered via registry)

// Only execute main() when run directly, not when imported
if (require.main === module) {
  (async () => { // NOSONAR - S7785: Top-level await requires ESM; this file uses CommonJS
    try {
      await main();
    } catch (error) {
      console.error(error);
    }
  })();
}

module.exports = { getWorkflowCommands, ensureDirWithNote: require('../lib/file-utils').ensureDirWithNote };
