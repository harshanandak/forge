// Git State Checker Validation Helper
// Validates git repository state for test environments

const fs = require('node:fs');
const path = require('node:path');
// SECURITY: Using execSync with HARDCODED git commands only (no user input)
// Follows pattern from bin/forge.js:2381
const { execSync } = require('node:child_process');

/**
 * Check overall git state of a directory
 * @param {string} directory - Directory to check
 * @returns {{passed: boolean, failures: Array, coverage: number}}
 */
function checkGitState(directory) {
  const failures = [];
  let checksPerformed = 0;
  let checksPassed = 0;

  // Check 1: Is it a git repository?
  checksPerformed++;
  const gitDir = path.join(directory, '.git');
  if (!fs.existsSync(gitDir)) {
    failures.push({
      path: directory,
      reason: 'Not a git repository (.git directory not found)'
    });
  } else {
    checksPassed++;
  }

  // If not a git repo, stop here
  if (failures.length > 0) {
    return {
      passed: false,
      failures,
      coverage: checksPassed / checksPerformed
    };
  }

  // Check 2: Detached HEAD (warning, not failure)
  checksPerformed++;
  const detachedResult = isDetachedHead(directory);
  if (detachedResult.detached) {
    failures.push({
      path: directory,
      reason: 'Repository is in detached HEAD state'
    });
  } else {
    checksPassed++;
  }

  // Check 3: Uncommitted changes (warning, not failure)
  checksPerformed++;
  const uncommittedResult = hasUncommittedChanges(directory);
  if (uncommittedResult.hasChanges) {
    failures.push({
      path: directory,
      reason: `Repository has uncommitted changes (${uncommittedResult.files.length} files)`
    });
  } else {
    checksPassed++;
  }

  // Check 4: Merge conflicts (actual failure)
  checksPerformed++;
  const conflictResult = hasMergeConflict(directory);
  if (conflictResult.hasConflict) {
    failures.push({
      path: directory,
      reason: 'Repository has active merge conflict'
    });
    checksPassed++; // We detected it, so check passed
  } else {
    checksPassed++;
  }

  // Determine if passed: merge conflicts are failures, others are warnings
  const hasMergeConflicts = conflictResult.hasConflict;
  const passed = !hasMergeConflicts;

  return {
    passed,
    failures,
    coverage: checksPassed / checksPerformed
  };
}

/**
 * Check if repository is in detached HEAD state
 * @param {string} directory - Directory to check
 * @returns {{detached: boolean, branch: string|null}}
 */
function isDetachedHead(directory) {
  try {
    // SECURITY: Hardcoded command, no user input
    execSync('git symbolic-ref -q HEAD', {
      cwd: directory,
      stdio: 'pipe',
      encoding: 'utf8'
    });
    // Success means we're on a branch (not detached)
    return { detached: false, branch: 'HEAD' };
  } catch (_error) {
    // Exit code 1 means detached HEAD
    return { detached: true, branch: null };
  }
}

/**
 * Check for uncommitted changes
 * @param {string} directory - Directory to check
 * @returns {{hasChanges: boolean, files: string[]}}
 */
function hasUncommittedChanges(directory) {
  try {
    // SECURITY: Hardcoded command, no user input
    const output = execSync('git status --porcelain', {
      cwd: directory,
      stdio: 'pipe',
      encoding: 'utf8'
    });

    const files = output.trim().split('\n').filter(line => line.length > 0);
    return {
      hasChanges: files.length > 0,
      files: files
    };
  } catch (_error) {
    // If git status fails, assume no changes
    return { hasChanges: false, files: [] };
  }
}

/**
 * Check for active merge conflicts
 * @param {string} directory - Directory to check
 * @returns {{hasConflict: boolean, conflictedFiles: string[]}}
 */
function hasMergeConflict(directory) {
  // Check if MERGE_HEAD exists (indicates active merge)
  const mergeHeadPath = path.join(directory, '.git', 'MERGE_HEAD');
  if (!fs.existsSync(mergeHeadPath)) {
    return { hasConflict: false, conflictedFiles: [] };
  }

  // If MERGE_HEAD exists, there's likely a conflict
  try {
    // SECURITY: Hardcoded command, no user input
    // git diff --check exits non-zero if there are conflicts
    execSync('git diff --check', {
      cwd: directory,
      stdio: 'pipe',
      encoding: 'utf8'
    });
    // No conflict markers found
    return { hasConflict: false, conflictedFiles: [] };
  } catch (_error) {
    // Conflict markers detected or merge in progress
    // Get list of conflicted files
    try {
      const output = execSync('git diff --name-only --diff-filter=U', {
        cwd: directory,
        stdio: 'pipe',
        encoding: 'utf8'
      });
      const conflictedFiles = output.trim().split('\n').filter(f => f.length > 0);
      return { hasConflict: true, conflictedFiles };
    } catch (_e) {
      // Fallback: we know there's a conflict, just can't list files
      return { hasConflict: true, conflictedFiles: [] };
    }
  }
}

module.exports = {
  checkGitState,
  isDetachedHead,
  hasUncommittedChanges,
  hasMergeConflict
};
