'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Forge Worktree Command
 * Manage isolated worktrees.
 * Uses execFileSync (not execSync) to prevent command injection (OWASP A03).
 *
 * The Kernel issue store lives in the git common dir, which every worktree of a
 * repo shares, so no per-worktree issue-store bootstrap is needed — a new
 * worktree already sees the same kernel.
 *
 * Subcommands:
 *   create <slug> - Create worktree at .worktrees/<slug> with branch + install
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

  const branchName = flags['--branch'] || flags.branch || `feat/${slug}`;
  const worktreesDir = path.resolve(projectRoot, '.worktrees');

  // Guard: Detect bare repo state - worktrees created from bare repos produce broken branches
  // git rev-parse --show-toplevel throws in a bare repo (no working tree)
  try {
    runFile('git', ['-C', projectRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    /* intentional: show-toplevel fails in bare repos */
    const errMsg = String(error?.stderr || error?.message || '').trim();
    if (/must be run in a work tree|this operation must be run in a work tree/i.test(errMsg)) {
      return { success: false, error: 'bare repo detected' };
    }
    return { success: false, error: errMsg || 'git rev-parse --show-toplevel failed' };
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

  // Step 3: Run package install
  // No per-worktree issue-store bootstrap is needed — the Kernel DB lives in the
  // shared git common dir, so the new worktree already sees the same kernel.
  runInstall(worktreePath, projectRoot, runSpawn, fsApi);

  return {
    success: true,
    worktreePath,
    branch: branchName,
  };
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
  const worktreePath = path.resolve(projectRoot, '.worktrees', slug);

  // No issue-store server to stop: the Kernel SQLite DB lives in the shared git
  // common dir, so removing a worktree directory never touches it.
  runFile('git', ['worktree', 'remove', worktreePath], { stdio: 'pipe' });

  return { success: true, removed: worktreePath };
}

function parseWorktreeArgs(args, flags) {
  const positional = [];
  const parsedFlags = { ...flags };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === '--branch') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        return { error: 'Missing value for --branch. Usage: forge worktree create <slug> --branch <branch-name>' };
      }
      parsedFlags['--branch'] = value;
      parsedFlags.branch = value;
      i++;
      continue;
    }

    if (arg.startsWith('--branch=')) {
      const value = arg.slice('--branch='.length);
      if (!value) {
        return { error: 'Missing value for --branch. Usage: forge worktree create <slug> --branch <branch-name>' };
      }
      parsedFlags['--branch'] = value;
      parsedFlags.branch = value;
      continue;
    }

    positional.push(arg);
  }

  return { args: positional, flags: parsedFlags };
}

module.exports = {
  name: 'worktree',
  description: 'Manage isolated worktrees',
  usage: 'forge worktree <create|remove> <slug>',
  flags: {
    '--branch': 'Custom branch name (default: feat/<slug>)',
  },

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
    const parsed = parseWorktreeArgs(args, flags);
    if (parsed.error) {
      return { success: false, error: parsed.error };
    }

    const subcommand = parsed.args[0];
    const slug = parsed.args[1];

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
      return handleCreate(slug, parsed.flags, projectRoot, opts);
    }

    return handleRemove(slug, projectRoot, opts);
  },
};
