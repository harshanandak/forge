#!/usr/bin/env node
/**
 * Branch Protection Script (Cross-Platform)
 *
 * Prevents direct pushes to main/master branches.
 * Uses Node.js for Windows compatibility (no shell-specific syntax).
 *
 * Exit codes:
 *   0 - Push allowed
 *   1 - Push blocked (protected branch)
 */

const { execSync } = require('child_process');

// ANSI color codes
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

// Protected branches
const PROTECTED_BRANCHES = ['main', 'master'];

/**
 * Get the current branch name
 * @returns {string} Current git branch name
 */
function getCurrentBranch() {
  try {
    // Try to get branch from Lefthook environment variable first
    if (process.env.LEFTHOOK_GIT_BRANCH) {
      return process.env.LEFTHOOK_GIT_BRANCH.trim();
    }

    // Fallback to git command
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();

    return branch;
  } catch (error) {
    console.error(`${RED}✗ Error: Could not determine current branch${RESET}`);
    console.error(`  ${error.message}`);
    process.exit(1);
  }
}

/**
 * Check if branch is protected
 * @param {string} branch - Branch name to check
 * @returns {boolean} True if branch is protected
 */
function isProtectedBranch(branch) {
  return PROTECTED_BRANCHES.includes(branch);
}

/**
 * Main function
 */
function main() {
  // Handle --help flag
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('Branch Protection Script');
    console.log('');
    console.log('Prevents direct pushes to protected branches (main/master).');
    console.log('');
    console.log('Usage:');
    console.log('  node scripts/branch-protection.js');
    console.log('');
    console.log('Exit codes:');
    console.log('  0 - Push allowed');
    console.log('  1 - Push blocked (protected branch)');
    process.exit(0);
  }

  const currentBranch = getCurrentBranch();

  if (isProtectedBranch(currentBranch)) {
    console.error('');
    console.error(`${RED}╔═══════════════════════════════════════════════════════════════╗${RESET}`);
    console.error(`${RED}║                 ⚠  PUSH BLOCKED                              ║${RESET}`);
    console.error(`${RED}╚═══════════════════════════════════════════════════════════════╝${RESET}`);
    console.error('');
    console.error(`${RED}✗ Direct pushes to '${currentBranch}' are forbidden.${RESET}`);
    console.error('');
    console.error(`${YELLOW}To push your changes:${RESET}`);
    console.error(`  1. Create a feature branch: ${YELLOW}git checkout -b feat/my-feature${RESET}`);
    console.error(`  2. Push to the feature branch: ${YELLOW}git push -u origin feat/my-feature${RESET}`);
    console.error(`  3. Create a pull request for review`);
    console.error('');
    console.error(`${YELLOW}Emergency bypass (use with caution):${RESET}`);
    console.error(`  ${YELLOW}LEFTHOOK=0 git push${RESET}`);
    console.error('');
    process.exit(1);
  }

  // Push allowed
  process.exit(0);
}

// Run main function
main();
