'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

// This synchronous git spawn can hang on Windows/Node (same class of issue as
// ba388d01 / #356's Kernel broker fix). A bounded `timeout` makes each spawn
// fail fast (ETIMEDOUT) instead of hanging forever; git normally answers these
// in milliseconds, so 30s only guards against a pathological wedge.
const GIT_SPAWN_TIMEOUT_MS = 30000;

/**
 * Detect if the current directory is inside a git worktree.
 * Uses git rev-parse --git-dir vs --git-common-dir — they differ in worktrees.
 *
 * @param {string} [cwd=process.cwd()] - Directory to check
 * @param {object} [deps] - Injectable dependencies for testing (execFileSync, warn)
 * @returns {{ inWorktree: boolean, branch?: string, mainWorktree?: string, currentWorktree?: string }}
 */
function detectWorktree(cwd = process.cwd(), deps = {}) {
  const exec = deps.execFileSync || execFileSync;
  const warn = deps.warn || ((message) => console.warn(message));

  try {
    const gitDir = exec('git', ['rev-parse', '--git-dir'], {
      encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: GIT_SPAWN_TIMEOUT_MS
    }).trim();

    const gitCommonDir = exec('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: GIT_SPAWN_TIMEOUT_MS
    }).trim();

    // Empty output from either probe is not a valid git dir. Do NOT feed it to
    // path.resolve — an empty string resolves to `cwd`, which would make an
    // empty gitDir compare equal-or-unequal by accident (falsely reporting
    // inWorktree, or returning extra non-fallback fields). Degrade to the
    // documented { inWorktree: false } fallback with a warning instead.
    if (!gitDir || !gitCommonDir) {
      warn('[forge] git worktree detection got empty git dir output '
        + `(gitDir=${JSON.stringify(gitDir)}, gitCommonDir=${JSON.stringify(gitCommonDir)}); `
        + 'falling back to { inWorktree: false }');
      return { inWorktree: false };
    }

    // Resolve to absolute paths for reliable comparison
    const absGitDir = path.resolve(cwd, gitDir);
    const absCommonDir = path.resolve(cwd, gitCommonDir);

    const branch = exec('git', ['branch', '--show-current'], {
      encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: GIT_SPAWN_TIMEOUT_MS
    }).trim();
    const mainWorktree = path.resolve(absCommonDir, '..');
    const currentWorktree = path.resolve(cwd);

    // In a worktree, git-dir is like .git/worktrees/<name>
    // while git-common-dir is the main .git directory
    if (absGitDir !== absCommonDir) {
      return { inWorktree: true, branch, mainWorktree, currentWorktree };
    }

    return { inWorktree: false, branch, mainWorktree, currentWorktree };
  } catch (err) {
    // Not in a git repo, git not available, or a spawn that hung past the
    // bound (ETIMEDOUT) — none of these should crash the caller. Degrade
    // gracefully to the same shape callers already handle.
    warn(`[forge] git worktree detection failed (${err.code || err.message}); `
      + 'falling back to { inWorktree: false }');
    return { inWorktree: false };
  }
}

/**
 * Parse `git worktree list --porcelain -z` into `{ path, bare }` records, in git's
 * order (the first record is always the main worktree). Fields are NUL-terminated
 * (a record ends with an extra NUL), so a path containing a newline stays intact.
 * @param {string} output - NUL-delimited porcelain output
 * @returns {Array<{ path: string, bare: boolean }>}
 */
function parseWorktreePorcelain(output) {
  const records = [];
  let current = null;
  for (const field of String(output || '').split('\0')) {
    if (field.startsWith('worktree ')) {
      current = { path: path.resolve(field.slice('worktree '.length)), bare: false };
      records.push(current);
    } else if (field === 'bare' && current) {
      current.bare = true;
    }
  }
  return records;
}

function gitOut(runFile, projectRoot, args) {
  return String(runFile('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: GIT_SPAWN_TIMEOUT_MS,
  }) || '');
}

/**
 * Resolve the MAIN worktree so `.worktrees/` always lives under the main checkout,
 * even from inside a linked worktree. `git worktree list --porcelain` lists the main
 * worktree first but reports the COMMON DIR as its path whenever that is not
 * `<checkout>/.git` (submodule, --separate-git-dir), so the checkout comes from, in
 * order: core.worktree (submodules), this checkout's toplevel when it IS the main
 * worktree, else the porcelain main entry. A bare main worktree, or a main checkout
 * git has no record of, is reported (`bare` / `error`) — callers refuse, never guess.
 * Falls back to projectRoot (`worktrees: null`) only when git itself fails.
 * @param {string} projectRoot - Current worktree / project root
 * @param {Function} [runFile] - execFileSync-compatible function (for DI)
 * @returns {{ root: string, bare: boolean, error?: string, worktrees: Array<{ path: string, bare: boolean }>|null }}
 */
function resolveMainWorktree(projectRoot, runFile = execFileSync) {
  const fallback = { root: path.resolve(projectRoot), bare: false, worktrees: null };
  let worktrees;
  let gitDir;
  let commonDir;
  let topLevel;
  try {
    worktrees = parseWorktreePorcelain(gitOut(runFile, projectRoot, ['worktree', 'list', '--porcelain', '-z']));
    if (worktrees.length === 0) return fallback;
    if (worktrees[0].bare) return { root: worktrees[0].path, bare: true, worktrees };
    [gitDir, commonDir, topLevel] = gitOut(runFile, projectRoot, [
      'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel',
    ]).split(/\r?\n/).map((line) => line.trim());
  } catch (_error) {
    return fallback;
  }
  if (!gitDir || !commonDir || !topLevel) return fallback;

  let coreWorktree = '';
  try {
    coreWorktree = gitOut(runFile, projectRoot, ['config', '--get', 'core.worktree']).trim();
  } catch (_error) { /* unset: git exits 1 */ }
  if (coreWorktree) return { root: path.resolve(commonDir, coreWorktree), bare: false, worktrees };
  if (path.resolve(gitDir) === path.resolve(commonDir)) return { root: path.resolve(topLevel), bare: false, worktrees };
  if (path.relative(worktrees[0].path, path.resolve(commonDir)) === '') {
    return {
      root: path.resolve(projectRoot), bare: false, worktrees,
      error: `main worktree location unknown: git reports only its git dir (${commonDir}). Run this from the main checkout.`,
    };
  }
  return { root: worktrees[0].path, bare: false, worktrees };
}

module.exports = { detectWorktree, resolveMainWorktree, parseWorktreePorcelain };
