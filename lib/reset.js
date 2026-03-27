const fs = require('node:fs');
const path = require('node:path');

/**
 * Known forge-created file patterns.
 * Used to distinguish forge files from user-created files.
 */
const FORGE_COMMANDS = [
  '.claude/commands/plan.md',
  '.claude/commands/dev.md',
  '.claude/commands/validate.md',
  '.claude/commands/ship.md',
  '.claude/commands/review.md',
  '.claude/commands/premerge.md',
  '.claude/commands/verify.md',
  '.claude/commands/status.md',
  '.claude/commands/preflight.md',
];

const FORGE_RULES = [
  '.claude/rules/workflow.md',
  '.claude/rules/greptile-review-process.md',
];

const FORGE_SCRIPTS = [
  '.claude/scripts/greptile-resolve.sh',
  '.claude/scripts/validate.sh',
];

const FORGE_WORKFLOWS = [
  '.github/workflows/beads-to-github.yml',
  '.github/workflows/github-to-beads.yml',
];

const FORGE_AGENT_DIRS = [
  '.cursor',
  '.cline',
  '.roo',
  '.codex',
  '.kilocode',
  '.opencode',
];

const FORGE_SYNC_SCRIPTS_DIR = 'scripts/github-beads-sync';

/**
 * Get categorized lists of forge-managed files in a project.
 * Only returns files that actually exist on disk and are known forge templates.
 * User-created files are excluded.
 *
 * @param {string} projectRoot - Project root directory
 * @returns {{
 *   config: string[],
 *   commands: string[],
 *   rules: string[],
 *   scripts: string[],
 *   agentDirs: string[],
 *   workflows: string[],
 *   syncScripts: string[]
 * }}
 */
function getForgeFiles(projectRoot) {
  const result = {
    config: [],
    commands: [],
    rules: [],
    scripts: [],
    agentDirs: [],
    workflows: [],
    syncScripts: [],
  };

  // .forge/ directory
  if (fs.existsSync(path.join(projectRoot, '.forge'))) {
    result.config.push('.forge');
  }

  // Known forge commands (static list)
  for (const f of FORGE_COMMANDS) {
    if (fs.existsSync(path.join(projectRoot, f))) {
      result.commands.push(f);
    }
  }

  // Dynamic discovery: scan the package's .claude/commands/ directory to find
  // any commands that setup may have copied but aren't in the static list.
  // Only files that exist in both the package source AND the project are included.
  const packageCommandsDir = path.join(__dirname, '..', '.claude', 'commands');
  try {
    const packageEntries = fs.readdirSync(packageCommandsDir);
    for (const entry of packageEntries) {
      if (entry.endsWith('.md')) {
        const relPath = `.claude/commands/${entry}`;
        if (!result.commands.includes(relPath) &&
            fs.existsSync(path.join(projectRoot, relPath))) {
          result.commands.push(relPath);
        }
      }
    }
  } catch (_error) {
    // Package commands directory read failed, skip
  }

  // Known forge rules
  for (const f of FORGE_RULES) {
    if (fs.existsSync(path.join(projectRoot, f))) {
      result.rules.push(f);
    }
  }

  // Known forge scripts
  for (const f of FORGE_SCRIPTS) {
    if (fs.existsSync(path.join(projectRoot, f))) {
      result.scripts.push(f);
    }
  }

  // Agent directories (only if they exist)
  for (const dir of FORGE_AGENT_DIRS) {
    if (fs.existsSync(path.join(projectRoot, dir))) {
      result.agentDirs.push(dir);
    }
  }

  // Beads workflow files
  for (const f of FORGE_WORKFLOWS) {
    if (fs.existsSync(path.join(projectRoot, f))) {
      result.workflows.push(f);
    }
  }

  // Sync scripts directory
  const syncDir = path.join(projectRoot, FORGE_SYNC_SCRIPTS_DIR);
  if (fs.existsSync(syncDir)) {
    try {
      const entries = fs.readdirSync(syncDir);
      for (const entry of entries) {
        const relPath = [FORGE_SYNC_SCRIPTS_DIR, entry].join('/');
        result.syncScripts.push(relPath);
      }
    } catch (_error) {
      // Directory read failed, skip
    }
  }

  return result;
}

/**
 * Remove .forge/ directory only (soft reset).
 * Requires force=true to proceed.
 *
 * @param {string} projectRoot - Project root directory
 * @param {{ force?: boolean }} options
 * @returns {{ removed: string[], preserved: string[] }}
 */
function resetSoft(projectRoot, { force = false } = {}) {
  if (!force) {
    throw new Error('Soft reset requires --force flag. This will remove .forge/ directory.');
  }

  const removed = [];
  const preserved = [];

  const forgePath = path.join(projectRoot, '.forge');
  if (fs.existsSync(forgePath)) {
    fs.rmSync(forgePath, { recursive: true, force: true });
    removed.push('.forge');
  }

  // Record what was preserved
  const inventory = getForgeFiles(projectRoot);
  for (const f of [...inventory.commands, ...inventory.rules, ...inventory.scripts]) {
    preserved.push(f);
  }
  for (const dir of inventory.agentDirs) {
    preserved.push(dir);
  }

  return { removed, preserved };
}

/**
 * Remove ALL forge-managed files (hard reset).
 * Preserves user-created files not in forge template list.
 * Requires force=true to proceed.
 *
 * @param {string} projectRoot - Project root directory
 * @param {{ force?: boolean }} options
 * @returns {{ removed: string[], preserved: string[] }}
 */
function resetHard(projectRoot, { force = false } = {}) {
  if (!force) {
    throw new Error('Hard reset requires --force flag. This will remove ALL forge files.');
  }

  const removed = [];
  const preserved = [];
  const inventory = getForgeFiles(projectRoot);

  // Remove .forge/ directory
  for (const dir of inventory.config) {
    const fullPath = path.join(projectRoot, dir);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed.push(dir);
    }
  }

  // Remove individual forge files
  const allFiles = [
    ...inventory.commands,
    ...inventory.rules,
    ...inventory.scripts,
    ...inventory.workflows,
    ...inventory.syncScripts,
  ];

  for (const f of allFiles) {
    const fullPath = path.join(projectRoot, f);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed.push(f);
    }
  }

  // Remove sync scripts directory if it still exists (empty after file removal)
  const syncDir = path.join(projectRoot, FORGE_SYNC_SCRIPTS_DIR);
  if (fs.existsSync(syncDir)) {
    fs.rmSync(syncDir, { recursive: true, force: true });
    removed.push(FORGE_SYNC_SCRIPTS_DIR);
  }

  // Remove agent directories
  for (const dir of inventory.agentDirs) {
    const fullPath = path.join(projectRoot, dir);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed.push(dir);
    }
  }

  return { removed, preserved };
}

/**
 * Remove all forge files and re-run setup (reinstall).
 * Accepts a setupFn parameter for testability.
 *
 * @param {string} projectRoot - Project root directory
 * @param {{ force?: boolean, setupFn?: Function }} options
 * @returns {Promise<{ resetResult: object, setupResult: any }>}
 */
async function reinstall(projectRoot, { force = false, setupFn } = {}) {
  if (!force) {
    throw new Error('Reinstall requires --force flag.');
  }

  const resetResult = resetHard(projectRoot, { force: true });

  let setupResult = null;
  if (setupFn) {
    setupResult = await setupFn(projectRoot);
  }

  return { resetResult, setupResult };
}

module.exports = {
  getForgeFiles,
  resetSoft,
  resetHard,
  reinstall,
  FORGE_COMMANDS,
  FORGE_RULES,
  FORGE_SCRIPTS,
  FORGE_WORKFLOWS,
  FORGE_AGENT_DIRS,
};
