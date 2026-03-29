/**
 * Freshness Token — Validate/Ship stage freshness state
 *
 * Tracks whether `main` has moved forward since /validate ran,
 * so /ship can warn if validation results are stale.
 *
 * Token file: `<projectRoot>/.forge-freshness` (ephemeral, gitignored)
 *
 * @module freshness-token
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TOKEN_FILENAME = '.forge-freshness';

/**
 * Get the current git branch name.
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {string} Current branch name.
 */
function getCurrentBranch(projectRoot) {
  // Safe: execFileSync with array args prevents injection (OWASP A03). PATH is OS-controlled.
  return execFileSync('git', ['-C', projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf8'
  }).trim();
}

/**
 * Detect the default branch (main, master, develop, trunk).
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {string} Default branch name.
 */
function getDefaultBranch(projectRoot) {
  try {
    // Safe: execFileSync with array args prevents injection (OWASP A03). PATH is OS-controlled.
    return execFileSync('git', ['-C', projectRoot, 'rev-parse', '--abbrev-ref', 'origin/HEAD'], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']
    }).trim().replace('origin/', '');
  } catch (_e) { /* intentional: origin/HEAD not set, probe common branch names */ // NOSONAR S2486
    for (const name of ['main', 'master', 'develop', 'trunk']) {
      try {
        // Safe: execFileSync with array args prevents injection (OWASP A03). PATH is OS-controlled.
        execFileSync('git', ['-C', projectRoot, 'rev-parse', '--verify', name], { stdio: 'pipe' });
        return name;
      } catch (_e2) { /* intentional: branch doesn't exist, try next name */ } // NOSONAR S2486
    }
    return 'main';
  }
}

/**
 * Get the merge-base commit between HEAD and the default branch.
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {string} The merge-base commit SHA.
 * @throws {Error} If git merge-base fails (no common ancestor, detached HEAD, etc.)
 */
function getMergeBase(projectRoot) {
  const base = getDefaultBranch(projectRoot);
  try {
    // Safe: execFileSync with array args prevents injection (OWASP A03). PATH is OS-controlled.
    return execFileSync('git', ['-C', projectRoot, 'merge-base', 'HEAD', base], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch (err) {
    throw new Error(
      `Failed to compute merge-base for HEAD and ${base} in "${projectRoot}": ${err.message}`
    );
  }
}

/**
 * Write a freshness token to `<projectRoot>/.forge-freshness`.
 *
 * Records the current branch, base commit (merge-base HEAD main),
 * and a timestamp so /ship can detect if validation is stale.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {{ timestamp: number, branch: string, baseCommit: string }} The written token.
 * @throws {Error} If git merge-base fails (no common ancestor, detached HEAD, etc.)
 */
function writeFreshnessToken(projectRoot) {
  const branch = getCurrentBranch(projectRoot);
  const baseCommit = getMergeBase(projectRoot);

  const token = {
    timestamp: Date.now(),
    branch,
    baseCommit
  };

  const tokenPath = path.join(projectRoot, TOKEN_FILENAME);
  fs.writeFileSync(tokenPath, JSON.stringify(token, null, 2), 'utf8');

  return token;
}

/**
 * Read and parse the freshness token from `<projectRoot>/.forge-freshness`.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {{ timestamp: number, branch: string, baseCommit: string } | null}
 *   The token object, or null if the file is missing or corrupted.
 */
function readFreshnessToken(projectRoot) {
  const tokenPath = path.join(projectRoot, TOKEN_FILENAME);

  try {
    const content = fs.readFileSync(tokenPath, 'utf8');
    return JSON.parse(content);
  } catch (_err) { /* intentional: missing file (ENOENT), corrupted JSON, or empty file — return null */ // NOSONAR S2486
    return null;
  }
}

/**
 * Check if a freshness token is stale.
 *
 * A token is stale when:
 * - It is null (missing or corrupted)
 * - The current merge-base differs from the token's baseCommit
 *   (meaning main has moved forward since validation)
 * - git merge-base fails (can't verify freshness)
 *
 * @param {{ timestamp: number, branch: string, baseCommit: string } | null} token
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {boolean} True if validation results are stale and should be re-run.
 */
function isStale(token, projectRoot) {
  if (token === null) {
    return true;
  }

  try {
    const currentBase = getMergeBase(projectRoot);
    return currentBase !== token.baseCommit;
  } catch (_err) { /* intentional: merge-base failed, treat as stale since freshness can't be verified */ // NOSONAR S2486
    return true;
  }
}

module.exports = {
  writeFreshnessToken,
  readFreshnessToken,
  isStale
};
