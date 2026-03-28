'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { stopDolt } = require('./worktree');

/**
 * Forge Clean Command
 * Remove worktrees for merged branches, stopping Dolt servers first.
 * Uses execFileSync (not execSync) to prevent command injection (OWASP A03).
 *
 * @module commands/clean
 */

/**
 * Detect the default branch (main, master, develop, trunk).
 * Tries origin/HEAD first, then probes common names.
 * @param {Function} runFile - execFileSync-compatible function
 * @returns {string} Default branch name
 */
function getDefaultBranch(runFile) {
  try {
    return runFile('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { stdio: 'pipe' })
      .toString().trim().replace('origin/', '');
  } catch (_e) { /* intentional: origin/HEAD not set, probe common names */ // NOSONAR S2486
    for (const name of ['main', 'master', 'develop', 'trunk']) {
      try {
        runFile('git', ['rev-parse', '--verify', name], { stdio: 'pipe' });
        return name;
      } catch (_e2) { /* intentional: try next branch name */ } // NOSONAR S2486
    }
    return 'main';
  }
}

/**
 * Parse `git worktree list --porcelain` output into a map of path -> branch.
 * @param {string} output - Raw porcelain output
 * @returns {Map<string, string>} Map of worktree path -> branch name
 */
function parseWorktreeList(output) {
  const map = new Map();
  const blocks = output.split('\n\n');
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    let wtPath = null;
    let branch = null;
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length);
      }
      if (line.startsWith('branch ')) {
        // branch refs/heads/feat/foo -> feat/foo
        branch = line.slice('branch refs/heads/'.length);
      }
    }
    if (wtPath && branch) {
      map.set(wtPath, branch);
    }
  }
  return map;
}

/**
 * Clean a single worktree directory if its branch is merged.
 * @param {string} dir - Directory name within .worktrees/
 * @param {Map<string, string>} worktreeMap - Path-to-branch mapping
 * @param {string[]} mergedBranches - List of merged branch names
 * @param {string} worktreesDir - Absolute path to .worktrees/
 * @param {boolean} dryRun - If true, skip actual removal
 * @param {Function} runFile - execFileSync-compatible function
 * @param {object} fsApi - fs module (for DI)
 * @returns {Promise<boolean>} True if the worktree was cleaned (or would be in dry-run)
 */
async function cleanWorktree(dir, worktreeMap, mergedBranches, worktreesDir, dryRun, runFile, fsApi) {
  const wtPath = path.resolve(worktreesDir, dir);
  const branch = worktreeMap.get(wtPath);

  if (branch && mergedBranches.includes(branch)) {
    if (!dryRun) {
      const stopResult = stopDolt(wtPath, { _exec: runFile, _fs: fsApi });
      if (stopResult.stopped) {
        await new Promise(r => setTimeout(r, 500));
      }
      runFile('git', ['worktree', 'remove', wtPath], { stdio: 'pipe' });
    }
    return true;
  }
  return false;
}

/**
 * Main handler for the clean command.
 * @param {string[]} _args - Positional arguments (unused)
 * @param {object} flags - CLI flags
 * @param {string} projectRoot - Project root path
 * @param {object} [opts] - Options for dependency injection
 * @param {Function} [opts._exec] - Override for execFileSync (testing)
 * @param {object} [opts._fs] - Override for fs module (testing)
 * @returns {Promise<{ success: boolean, cleaned: number, active: number, dryRun: boolean }>}
 */
async function handler(_args, flags, projectRoot, opts = {}) {
  const runFile = opts._exec || execFileSync;
  const fsApi = opts._fs || fs;
  const dryRun = !!(flags['--dry-run'] || flags.dryRun);

  const worktreesDir = path.resolve(projectRoot, '.worktrees');

  // If .worktrees/ doesn't exist, nothing to clean
  if (!fsApi.existsSync(worktreesDir)) {
    return { success: true, cleaned: 0, active: 0, dryRun };
  }

  // 1. List dirs in .worktrees/
  const entries = fsApi.readdirSync(worktreesDir, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);

  if (dirs.length === 0) {
    return { success: true, cleaned: 0, active: 0, dryRun };
  }

  // 2. Detect default branch, then get merged branches
  const defaultBranch = getDefaultBranch(runFile);
  let mergedBranches;
  try {
    const mergedOutput = runFile('git', ['branch', '--merged', defaultBranch], { stdio: 'pipe' });
    mergedBranches = mergedOutput
      .toString()
      .split('\n')
      .map(b => b.trim().replace(/^\*\s*/, ''))
      .filter(b => b.length > 0);
  } catch (_e) { /* intentional: fallback to empty list */ // NOSONAR S2486
    mergedBranches = [];
  }

  // 3. Get worktree -> branch mapping from git
  let worktreeMap;
  try {
    const listOutput = runFile('git', ['worktree', 'list', '--porcelain'], { stdio: 'pipe' });
    worktreeMap = parseWorktreeList(listOutput.toString());
  } catch (_e) { /* intentional: fallback to empty map */ // NOSONAR S2486
    worktreeMap = new Map();
  }

  // 4. For each worktree dir, check if its branch is merged
  let cleaned = 0;
  let active = 0;

  for (const dir of dirs) {
    const wasCleaned = await cleanWorktree(dir, worktreeMap, mergedBranches, worktreesDir, dryRun, runFile, fsApi);
    if (wasCleaned) {
      cleaned++;
    } else {
      active++;
    }
  }

  return { success: true, cleaned, active, dryRun };
}

module.exports = {
  name: 'clean',
  description: 'Remove worktrees for merged branches (stops Dolt servers)',
  usage: 'forge clean [--dry-run]',
  flags: {
    '--dry-run': 'Show what would be cleaned without removing',
  },
  handler,
};
