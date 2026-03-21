'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

/**
 * Detect if the current directory is inside a git worktree.
 * Uses git rev-parse --git-dir vs --git-common-dir — they differ in worktrees.
 *
 * @param {string} [cwd=process.cwd()] - Directory to check
 * @returns {{ inWorktree: boolean, branch?: string, mainWorktree?: string }}
 */
function detectWorktree(cwd = process.cwd()) {
  try {
    const gitDir = execFileSync('git', ['rev-parse', '--git-dir'], {
      encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    // Resolve to absolute paths for reliable comparison
    const absGitDir = path.resolve(cwd, gitDir);
    const absCommonDir = path.resolve(cwd, gitCommonDir);

    // In a worktree, git-dir is like .git/worktrees/<name>
    // while git-common-dir is the main .git directory
    if (absGitDir !== absCommonDir) {
      const branch = execFileSync('git', ['branch', '--show-current'], {
        encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe']
      }).trim();

      // Main worktree is one level above the common .git dir
      const mainWorktree = path.resolve(absCommonDir, '..');

      return { inWorktree: true, branch, mainWorktree };
    }

    return { inWorktree: false };
  } catch (_err) {
    // Not in a git repo or git not available
    return { inWorktree: false };
  }
}

module.exports = { detectWorktree };
