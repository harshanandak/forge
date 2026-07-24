'use strict';

const { execFileSync } = require('node:child_process');

/**
 * Detect the default branch of the repository.
 *
 * Strategy (in order):
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` -> parse branch name
 *   2. `git remote show origin` -> parse "HEAD branch:" line
 *   3. Fall back to `'main'`
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @param {object} [options] - Options object.
 * @param {Function} [options._exec] - Injected execFileSync for testing.
 * @returns {string} The default branch name.
 */
function detectDefaultBranch(projectRoot, options = {}) {
  const exec = options._exec || execFileSync;

  // Strategy 1: symbolic-ref
  try {
    const out = exec('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const ref = out.toString().trim();
    // refs/remotes/origin/main -> main
    const parts = ref.split('/');
    if (parts.length > 0) {
      return parts[parts.length - 1];
    }
  } catch (_e) {
    // Expected: symbolic-ref fails when origin/HEAD is not set — fall through to strategy 2
  }

  // Strategy 2: remote show origin
  try {
    const out = exec('git', ['remote', 'show', 'origin'], {
      cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const text = out.toString();
    const match = text.match(/HEAD branch:\s*(.+)/);
    if (match) {
      return match[1].trim();
    }
  } catch (_e) {
    // Expected: 'git remote show origin' fails when no remote is configured — fall through to fallback
  }

  // Strategy 3: fallback
  return 'main';
}

module.exports = {
  detectDefaultBranch,
};
