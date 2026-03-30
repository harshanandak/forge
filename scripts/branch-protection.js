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

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// ANSI color codes
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

/** Test-only: run mock-git.js via `node` so Windows does not need shell:true or git.exe shims */
const GIT_MOCK_JS = process.env.NODE_ENV === 'test'
  ? process.env.FORGE_GIT_MOCK_JS
  : undefined;

const EXEC_OPTS = { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };

function fileExistsSync(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a real git binary (git.exe on Windows). Never uses shell — avoids injection via argv joining.
 */
function resolveGitBinary() {
  const raw = (process.platform === 'win32'
    ? (process.env.Path || process.env.PATH || '')
    : (process.env.PATH || ''));
  const dirs = raw.split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    for (const d of dirs) {
      const exe = path.join(d, 'git.exe');
      if (fileExistsSync(exe)) return exe;
    }
    return 'git.exe';
  }
  for (const d of dirs) {
    const g = path.join(d, 'git');
    if (fileExistsSync(g)) return g;
  }
  return 'git';
}

/** Narrow ref shape for env-provided branch names (used in diff ref ranges). */
function isSafeGitRefComponent(s) {
  if (!s || s.length > 256) return false;
  return /^[a-zA-Z0-9/._-]+$/.test(s);
}

function execGit(args) {
  if (GIT_MOCK_JS) {
    return execFileSync(process.execPath, [GIT_MOCK_JS, ...args], EXEC_OPTS);
  }
  return execFileSync(resolveGitBinary(), args, EXEC_OPTS);
}

// Protected branches
const PROTECTED_BRANCHES = new Set(['main', 'master']);

/**
 * Get the current branch name
 * @returns {string} Current git branch name
 */
function getCurrentBranch() {
  if (process.env.LEFTHOOK_GIT_BRANCH) {
    const b = process.env.LEFTHOOK_GIT_BRANCH.trim();
    if (!isSafeGitRefComponent(b)) {
      console.error(`${RED}✗ Error: Invalid LEFTHOOK_GIT_BRANCH value${RESET}`);
      return { error: true, code: 1 };
    }
    return { error: false, branch: b };
  }

  try {
    const branch = execGit(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (!isSafeGitRefComponent(branch)) {
      console.error(`${RED}✗ Error: Invalid branch name from git${RESET}`);
      return { error: true, code: 1 };
    }
    return { error: false, branch };
  } catch (error) {
    console.error(`${RED}✗ Error: Could not determine current branch${RESET}`);
    console.error(`  ${error.message}`);
    return { error: true, code: 1 };
  }
}

/**
 * Check if branch is protected
 * @param {string} branch - Branch name to check
 * @returns {boolean} True if branch is protected
 */
function isProtectedBranch(branch) {
  return PROTECTED_BRANCHES.has(branch);
}

/**
 * Check branch protection and return an exit code.
 * @returns {number} 0 if push is allowed, 1 if push is blocked
 */
function checkBranchProtection() {
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
    return 0;
  }

  const result = getCurrentBranch();
  if (result.error) return result.code;
  const currentBranch = result.branch;

  if (isProtectedBranch(currentBranch)) {
    // Allow beads-only commits (issue tracking metadata) to push directly
    try {
      let upstream;
      try {
        upstream = execGit(['rev-parse', '--abbrev-ref', '@{u}']).trim();
      } catch (_e) {
        upstream = `origin/${currentBranch}`;
      }

      if (!isSafeGitRefComponent(upstream)) {
        throw new Error('unsafe upstream ref');
      }

      const output = execGit(['diff', '--name-only', `${upstream}..HEAD`]).trim();
      const changedFiles = output.split('\n').filter(Boolean);

      if (changedFiles.length === 0) {
        console.error(`${YELLOW}Note: no changed files detected — nothing to bypass${RESET}`);
      } else if (changedFiles.every(f => f.startsWith('.beads/'))) {
        console.error(`${YELLOW}Beads-only push to '${currentBranch}' — allowed${RESET}`);
        return 0;
      }
    } catch (_e) {
      console.error(`${YELLOW}Note: could not detect beads-only push (upstream ref missing?) — blocking by default${RESET}`);
    }

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
    console.error(`${YELLOW}Emergency hook bypass is human-only and must not appear in agent logs.${RESET}`);
    console.error(`  See ${YELLOW}CLAUDE.md${RESET} (Git Workflow) — AI agents must fix failing hooks, not bypass them.`);
    console.error('');
    return 1;
  }

  // Push allowed
  return 0;
}

module.exports = { checkBranchProtection };

if (require.main === module) {
  process.exit(checkBranchProtection());
}
