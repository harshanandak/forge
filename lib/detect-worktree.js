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

module.exports = { detectWorktree };
