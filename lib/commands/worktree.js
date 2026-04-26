'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { bootstrapBeads } = require('../beads-bootstrap');

/**
 * Forge Worktree Command
 * Manage isolated worktrees with Beads integration.
 * Uses execFileSync (not execSync) to prevent command injection (OWASP A03).
 *
 * Subcommands:
 *   create <slug> - Create worktree at .worktrees/<slug> with branch + beads + install
 *   remove <slug> - Remove worktree via git worktree remove
 *
 * @module commands/worktree
 */

/**
 * Detect the package manager for a project root.
 * @param {string} projectRoot - Path to check for lock files
 * @param {object} fsApi - fs module (for DI)
 * @returns {string|null} Package manager command or null
 */
function detectPackageManager(projectRoot, fsApi) {
  if (fsApi.existsSync(path.join(projectRoot, 'bun.lockb'))) return 'bun';
  if (fsApi.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fsApi.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  if (fsApi.existsSync(path.join(projectRoot, 'package-lock.json'))) return 'npm';
  if (fsApi.existsSync(path.join(projectRoot, 'package.json'))) return 'npm';
  return null;
}

/**
 * Stop a Dolt server running in a worktree to release file locks.
 * Tries graceful `bd dolt stop` first, then falls back to PID-based kill
 * from lock files. Never kills ALL Dolt processes - only the specific PID.
 *
 * @param {string} worktreePath - Absolute path to the worktree
 * @param {object} [opts] - Options for dependency injection
 * @param {Function} [opts._exec] - Override for execFileSync (testing)
 * @param {object} [opts._fs] - Override for fs module (testing)
 * @param {string} [opts._platform] - Override for process.platform (testing)
 * @returns {{ stopped: boolean, method: string, pid?: number }}
 */
function stopDolt(worktreePath, opts = {}) {
  const exec = opts._exec || execFileSync;
  const _fs = opts._fs || fs;
  const platform = opts._platform || process.platform;

  // 1. Try graceful: bd dolt stop
  try {
    exec('bd', ['dolt', 'stop'], { cwd: worktreePath, timeout: 5000, stdio: 'pipe' });
    return { stopped: true, method: 'bd-dolt-stop' };
  } catch (_e) { /* intentional: bd not available, try PID-based kill */ } // NOSONAR S2486

  // 2. Try PID-based kill from lock file
  const lockPaths = [
    path.join(worktreePath, '.beads', 'dolt-server.lock'),
    path.join(worktreePath, '.beads', 'daemon.lock'),
  ];
  for (const lockPath of lockPaths) {
    try {
      const pid = Number.parseInt(_fs.readFileSync(lockPath, 'utf-8').trim(), 10);
      if (!Number.isNaN(pid)) {
        if (platform === 'win32') {
          exec('taskkill', ['/F', '/PID', String(pid)], { stdio: 'pipe' });
        } else {
          process.kill(pid, 'SIGTERM');
        }
        return { stopped: true, method: 'pid-kill', pid };
      }
    } catch (_e) { /* intentional: try next lock file */ } // NOSONAR S2486
  }

  return { stopped: false, method: 'none' };
}

/**
 * Check if a git branch already exists.
 * @param {string} branchName - Branch name to check
 * @param {Function} runFile - execFileSync function (for DI)
 * @returns {boolean}
 */
function branchExists(branchName, runFile) {
  try {
    const output = runFile('git', ['branch', '--list', branchName], { stdio: 'pipe' });
    return output.toString().trim().length > 0;
  } catch (_err) { /* intentional: branch doesn't exist */ // NOSONAR S2486
    return false;
  }
}

function setupBeadsWithBootstrap(worktreePath, projectRoot, platform, fsApi, exec, options = {}) {
  if (!fsApi.existsSync(path.resolve(projectRoot, '.beads'))) {
    return 'Beads not installed - skipping .beads setup';
  }

  const bootstrapResult = bootstrapBeads(worktreePath, {
    _exec: exec,
    _fs: fsApi,
    _platform: platform,
    mainProjectRoot: projectRoot,
    _safeBeadsInit: options._safeBeadsInit,
  });

  try {
    exec('bd', ['--version'], { cwd: worktreePath, timeout: 5000, stdio: 'pipe' });
  } catch (_bdErr) { /* intentional: bd may not be on PATH */ // NOSONAR S2486
    if (bootstrapResult.success === false && bootstrapResult.warning) {
      return bootstrapResult.warning;
    }
    return 'Beads verification failed - .beads linked but bd may not work';
  }

  return bootstrapResult.warning;
}

/**
 * Run package install in the new worktree if a package manager is detected.
 * @param {string} worktreePath - Absolute path to the new worktree
 * @param {string} projectRoot - Absolute path to the project root
 * @param {Function} spawnFn - spawnSync-compatible function
 * @param {object} fsApi - fs module (for DI)
 */
function runInstall(worktreePath, projectRoot, spawnFn, fsApi) {
  const pkgManager = detectPackageManager(projectRoot, fsApi);
  if (pkgManager) {
    spawnFn(pkgManager, ['install'], { cwd: worktreePath, stdio: 'pipe' });
  }
}

/**
 * Handle the "create" subcommand.
 * @param {string} slug - Worktree slug
 * @param {object} flags - CLI flags
 * @param {string} projectRoot - Project root path
 * @param {object} opts - DI options
 * @returns {Promise<object>} Result object
 */
async function handleCreate(slug, flags, projectRoot, opts) {
  const runFile = opts._exec || execFileSync;
  const runSpawn = opts._spawn || spawnSync;
  const fsApi = opts._fs || fs;
  const platform = opts._platform || process.platform;

  const branchName = flags['--branch'] || flags.branch || `feat/${slug}`;
  const worktreesDir = path.resolve(projectRoot, '.worktrees');

  // Guard: Detect bare repo state - worktrees created from bare repos produce broken branches
  // git rev-parse --show-toplevel throws in a bare repo (no working tree)
  try {
    runFile('git', ['-C', projectRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (_e) { // NOSONAR S2486
    /* intentional: show-toplevel fails in bare repos */
    return { success: false, error: 'bare repo detected' };
  }

  // Security: Validate slug doesn't contain path traversal (OWASP A01/A03)
  if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
    return { success: false, error: String.raw`Invalid slug: must not contain "..", "/", or "\"` };
  }

  const worktreePath = path.resolve(worktreesDir, slug);

  // Step 0: Check if worktree already exists
  if (fsApi.existsSync(worktreePath)) {
    return {
      success: true,
      reused: true,
      message: `Worktree already exists at ${worktreePath}`,
      worktreePath,
    };
  }

  // Step 1: Ensure .worktrees/ dir exists
  fsApi.mkdirSync(worktreesDir, { recursive: true });

  // Step 2: Create git worktree
  const hasBranch = branchExists(branchName, runFile);
  if (hasBranch) {
    runFile('git', ['worktree', 'add', worktreePath, branchName], { stdio: 'pipe' });
  } else {
    runFile('git', ['worktree', 'add', worktreePath, '-b', branchName], { stdio: 'pipe' });
  }

  // Step 3: Beads integration
  const beadsWarning = setupBeadsWithBootstrap(worktreePath, projectRoot, platform, fsApi, runFile, opts);

  // Step 4: Run package install
  runInstall(worktreePath, projectRoot, runSpawn, fsApi);

  const result = {
    success: true,
    worktreePath,
    branch: branchName,
  };
  if (beadsWarning) {
    result.beadsWarning = beadsWarning;
  }
  return result;
}

/**
 * Handle the "remove" subcommand.
 * @param {string} slug - Worktree slug
 * @param {string} projectRoot - Project root path
 * @param {object} opts - DI options
 * @returns {Promise<object>} Result object
 */
async function handleRemove(slug, projectRoot, opts) {
  // Security: Validate slug doesn't contain path traversal (OWASP A01/A03)
  if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
    return { success: false, error: String.raw`Invalid slug: must not contain "..", "/", or "\"` };
  }

  const runFile = opts._exec || execFileSync;
  const fsModule = opts._fs || fs;
  const worktreePath = path.resolve(projectRoot, '.worktrees', slug);

  // Stop Dolt server to release file locks
  const stopResult = stopDolt(worktreePath, { _exec: runFile, _fs: fsModule, _platform: opts._platform });
  if (stopResult.stopped) {
    // Brief wait for file locks to release (Windows needs this)
    await new Promise(r => setTimeout(r, 500));
  }

  runFile('git', ['worktree', 'remove', worktreePath], { stdio: 'pipe' });

  return { success: true, removed: worktreePath };
}

module.exports = {
  name: 'worktree',
  description: 'Manage isolated worktrees with Beads integration',
  usage: 'forge worktree <create|remove> <slug>',
  flags: {
    '--branch': 'Custom branch name (default: feat/<slug>)',
  },
  stopDolt,

  /**
   * Main handler for the worktree command.
   * @param {string[]} args - Positional arguments: [subcommand, slug]
   * @param {object} flags - CLI flags
   * @param {string} projectRoot - Project root path
   * @param {object} [opts] - Options for dependency injection
   * @param {Function} [opts._exec] - Override for execFileSync (testing)
   * @param {Function} [opts._spawn] - Override for spawnSync (testing)
   * @param {object} [opts._fs] - Override for fs module (testing)
   * @param {string} [opts._platform] - Override for process.platform (testing)
   * @returns {Promise<object>}
   */
  handler: async (args, flags, projectRoot, opts = {}) => {
    const subcommand = args[0];
    const slug = args[1];

    if (!subcommand || !['create', 'remove'].includes(subcommand)) {
      return {
        success: false,
        error: 'Missing or invalid subcommand. Usage: forge worktree <create|remove> <slug>',
      };
    }

    if (!slug) {
      return {
        success: false,
        error: 'Missing slug. Usage: forge worktree <create|remove> <slug>',
      };
    }

    if (subcommand === 'create') {
      return handleCreate(slug, flags, projectRoot, opts);
    }

    return handleRemove(slug, projectRoot, opts);
  },
};
