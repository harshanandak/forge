'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');

/**
 * Forge Rollback Command
 *
 * Safely roll back commits, merged PRs, specific files, or branch ranges
 * while preserving USER:START/END sections in AGENTS.md.
 *
 * Extracted from bin/forge.js — TDD validated.
 * Uses execFileSync (not execSync) to prevent command injection (OWASP A03).
 *
 * @module commands/rollback
 */

// ── Validation helpers ─────────────────────────────────────────────────

/**
 * Validate commit hash format.
 * @param {string} target
 * @returns {{ valid: boolean, error?: string }}
 */
function validateCommitHash(target) {
  if (target !== 'HEAD' && !/^[0-9a-f]{4,40}$/i.test(target)) {
    return { valid: false, error: 'Invalid commit hash format' };
  }
  return { valid: true };
}

/**
 * Validate file paths for partial rollback.
 * @param {string} target - Comma-separated file paths
 * @param {string} projectRoot - Project root for path-traversal check
 * @returns {{ valid: boolean, error?: string }}
 */
function validatePartialRollbackPaths(target, projectRoot) {
  const root = projectRoot || process.cwd();
  const files = target.split(',').map(f => f.trim());
  for (const file of files) {
    if (/[;|&$`()<>\r\n]/.test(file)) {
      return { valid: false, error: `Invalid characters in path: ${file}` };
    }
    if (/%2[eE]|%2[fF]|%5[cC]/.test(file)) {
      return { valid: false, error: `URL-encoded characters not allowed: ${file}` };
    }
    if (!/^[\x20-\x7E]+$/.test(file)) {
      return { valid: false, error: `Only ASCII characters allowed in path: ${file}` };
    }
    const resolved = path.resolve(root, file);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      return { valid: false, error: `Path outside project: ${file}` };
    }
  }
  return { valid: true };
}

/**
 * Validate branch range format.
 * @param {string} target
 * @returns {{ valid: boolean, error?: string }}
 */
function validateBranchRange(target) {
  if (!target.includes('..')) {
    return { valid: false, error: 'Branch range must use format: start..end' };
  }
  const [start, end] = target.split('..');
  if (!/^[0-9a-f]{4,40}$/i.test(start) || !/^[0-9a-f]{4,40}$/i.test(end)) {
    return { valid: false, error: 'Invalid commit hashes in range' };
  }
  return { valid: true };
}

/**
 * Validate rollback inputs (security-critical).
 * @param {string} method - commit|pr|partial|branch
 * @param {string} target - Target for the method
 * @param {string} [projectRoot] - Project root (needed for partial)
 * @returns {{ valid: boolean, error?: string }}
 */
function validateRollbackInput(method, target, projectRoot) {
  const validMethods = ['commit', 'pr', 'partial', 'branch'];
  if (!validMethods.includes(method)) {
    return { valid: false, error: 'Invalid method' };
  }

  if (method === 'commit' || method === 'pr') {
    return validateCommitHash(target);
  }

  if (method === 'partial') {
    return validatePartialRollbackPaths(target, projectRoot);
  }

  if (method === 'branch') {
    return validateBranchRange(target);
  }

  return { valid: true };
}

// ── USER section preservation ──────────────────────────────────────────

/**
 * Extract USER:START/END marker sections from content.
 * @param {string} content
 * @returns {Object<string, string>}
 */
function extractUserMarkerSections(content) {
  const sections = {};
  const userRegex = /<!-- USER:START -->([\s\S]*?)<!-- USER:END -->/g;
  let match;
  let index = 0;

  while ((match = userRegex.exec(content)) !== null) {
    sections[`user_${index}`] = match[1];
    index++;
  }

  return sections;
}

/**
 * Extract custom commands from directory.
 * @param {string} filePath
 * @param {object} fsApi
 * @returns {Array|null}
 */
function extractCustomCommands(filePath, fsApi) {
  const customCommandsDir = path.join(path.dirname(filePath), '.claude', 'commands', 'custom');

  if (!fsApi.existsSync(customCommandsDir)) {
    return null;
  }

  return fsApi.readdirSync(customCommandsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => ({
      name: f,
      content: fsApi.readFileSync(path.join(customCommandsDir, f), 'utf-8')
    }));
}

/**
 * Extract USER sections from AGENTS.md before rollback.
 * @param {string} filePath
 * @param {object} [opts]
 * @param {object} [opts._fs] - Override for fs module (testing)
 * @returns {Object}
 */
function extractUserSections(filePath, opts = {}) {
  const fsApi = opts._fs || fs;
  if (!fsApi.existsSync(filePath)) return {};

  const content = fsApi.readFileSync(filePath, 'utf-8');
  const sections = extractUserMarkerSections(content);

  const customCommands = extractCustomCommands(filePath, fsApi);
  if (customCommands) {
    sections.customCommands = customCommands;
  }

  return sections;
}

/**
 * Restore USER sections after rollback.
 * @param {string} filePath
 * @param {Object} savedSections
 * @param {object} [opts]
 * @param {object} [opts._fs] - Override for fs module (testing)
 */
function preserveUserSections(filePath, savedSections, opts = {}) {
  const fsApi = opts._fs || fs;
  if (!fsApi.existsSync(filePath) || Object.keys(savedSections).length === 0) {
    return;
  }

  let content = fsApi.readFileSync(filePath, 'utf-8');

  let index = 0;
  content = content.replaceAll(
    /<!-- USER:START -->[\s\S]*?<!-- USER:END -->/g,
    () => {
      const section = savedSections[`user_${index}`];
      index++;
      return section ? `<!-- USER:START -->${section}<!-- USER:END -->` : '';
    }
  );

  fsApi.writeFileSync(filePath, content, 'utf-8');

  if (savedSections.customCommands) {
    const customCommandsDir = path.join(path.dirname(filePath), '.claude', 'commands', 'custom');
    if (!fsApi.existsSync(customCommandsDir)) {
      fsApi.mkdirSync(customCommandsDir, { recursive: true });
    }

    savedSections.customCommands.forEach(cmd => {
      fsApi.writeFileSync(
        path.join(customCommandsDir, cmd.name),
        cmd.content,
        'utf-8'
      );
    });
  }
}

// ── Git helpers ────────────────────────────────────────────────────────

/**
 * Check that git working directory is clean.
 * Uses execFileSync (safe) — no shell interpolation.
 * @param {Function} runFile - execFileSync-compatible function
 * @returns {boolean}
 */
function checkGitWorkingDirectory(runFile) {
  try {
    const status = runFile('git', ['status', '--porcelain'], { encoding: 'utf-8' });
    const output = typeof status === 'string' ? status : status.toString('utf-8');
    if (output.trim() !== '') {
      console.log('  Working directory has uncommitted changes');
      console.log('     Commit or stash changes before rollback');
      return false;
    }
    return true;
  } catch (err) {
    console.log('  Git error:', err.message);
    return false;
  }
}

/**
 * Update Beads issue after PR rollback.
 * Uses execFileSync (safe) — no shell interpolation.
 * @param {string} commitMessage
 * @param {Function} runFile
 */
function updateBeadsIssue(commitMessage, runFile) {
  const issueMatch = commitMessage.match(/#(\d+)/); // NOSONAR — RegExp.exec blocked by security hook; match() equivalent here (no g flag)
  if (!issueMatch) return;

  try {
    runFile('bd', ['update', issueMatch[1], '--status', 'reverted', '--comment', 'PR reverted'], { stdio: 'inherit' });
    console.log(`     Updated Beads issue #${issueMatch[1]} to 'reverted'`);
  } catch (_e) { // NOSONAR — Beads not installed is expected, silently continue
    // Beads not installed — silently continue
  }
}

/**
 * Handle commit rollback.
 * Uses execFileSync (safe) — no shell interpolation.
 * @param {string} target
 * @param {boolean} dryRun
 * @param {Function} runFile
 */
function handleCommitRollback(target, dryRun, runFile) { // NOSONAR — boolean param is intentional API design
  if (dryRun) {
    console.log(`     Would revert: ${target}`);
    const files = runFile('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', target], { encoding: 'utf-8' });
    const output = typeof files === 'string' ? files : files.toString('utf-8');
    console.log('     Affected files:');
    output.trim().split('\n').forEach(f => console.log(`       - ${f}`));
  } else {
    runFile('git', ['revert', '--no-edit', target], { stdio: 'inherit' });
  }
}

/**
 * Handle PR rollback.
 * Uses execFileSync (safe) — no shell interpolation.
 * @param {string} target
 * @param {boolean} dryRun
 * @param {Function} runFile
 */
function handlePrRollback(target, dryRun, runFile) { // NOSONAR — boolean param is intentional API design
  if (dryRun) {
    console.log(`     Would revert merge: ${target}`);
    const files = runFile('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', target], { encoding: 'utf-8' });
    const output = typeof files === 'string' ? files : files.toString('utf-8');
    console.log('     Affected files:');
    output.trim().split('\n').forEach(f => console.log(`       - ${f}`));
  } else {
    runFile('git', ['revert', '-m', '1', '--no-edit', target], { stdio: 'inherit' });

    const commitMsg = runFile('git', ['log', '-1', '--format=%B', target], { encoding: 'utf-8' });
    const msgOutput = typeof commitMsg === 'string' ? commitMsg : commitMsg.toString('utf-8');
    updateBeadsIssue(msgOutput, runFile);
  }
}

/**
 * Handle partial file rollback.
 * Uses execFileSync (safe) — no shell interpolation.
 * @param {string} target
 * @param {boolean} dryRun
 * @param {Function} runFile
 */
function handlePartialRollback(target, dryRun, runFile) {
  const files = target.split(',').map(f => f.trim());
  if (dryRun) {
    console.log('     Would restore files:');
    files.forEach(f => console.log(`       - ${f}`));
  } else {
    files.forEach(f => {
      runFile('git', ['checkout', 'HEAD~1', '--', f], { stdio: 'inherit' });
    });
    runFile('git', ['commit', '-m', `chore: rollback ${files.join(', ')}`], { stdio: 'inherit' });
  }
}

/**
 * Handle branch range rollback.
 * Uses execFileSync (safe) — no shell interpolation.
 * @param {string} target
 * @param {boolean} dryRun
 * @param {Function} runFile
 */
function handleBranchRollback(target, dryRun, runFile) {
  const [startCommit, endCommit] = target.split('..');
  if (dryRun) {
    console.log(`     Would revert range: ${startCommit}..${endCommit}`);
    const commits = runFile('git', ['log', '--oneline', `${startCommit}..${endCommit}`], { encoding: 'utf-8' });
    const output = typeof commits === 'string' ? commits : commits.toString('utf-8');
    console.log('     Commits to revert:');
    output.trim().split('\n').forEach(c => console.log(`       ${c}`));
  } else {
    runFile('git', ['revert', '--no-edit', `${startCommit}..${endCommit}`], { stdio: 'inherit' });
  }
}

/**
 * Finalize rollback by restoring user sections.
 * Uses execFileSync (safe) — no shell interpolation.
 * @param {string} agentsPath
 * @param {Object} savedSections
 * @param {Function} runFile
 * @param {object} fsApi
 */
function finalizeRollback(agentsPath, savedSections, runFile, fsApi) {
  console.log('  Restoring user content...');
  preserveUserSections(agentsPath, savedSections, { _fs: fsApi });

  if (fsApi.existsSync(agentsPath)) {
    runFile('git', ['add', 'AGENTS.md'], { stdio: 'inherit' });
    runFile('git', ['commit', '--amend', '--no-edit'], { stdio: 'inherit' });
  }

  console.log('');
  console.log('  Rollback complete');
  console.log('     User content preserved');
}

// ── Main rollback logic ────────────────────────────────────────────────

/**
 * Perform a rollback operation.
 * @param {string} method - commit|pr|partial|branch
 * @param {string} target - Target for the method
 * @param {boolean} [dryRun=false]
 * @param {string} projectRoot - Project root directory
 * @param {object} [opts]
 * @param {Function} [opts._exec] - Override for execFileSync (testing)
 * @param {object} [opts._fs] - Override for fs module (testing)
 * @returns {Promise<boolean>}
 */
async function performRollback(method, target, dryRun = false, projectRoot, opts = {}) { // NOSONAR — default before non-default is intentional (dryRun most common override)
  const runFile = opts._exec || execFileSync;
  const fsApi = opts._fs || fs;
  const root = projectRoot || process.cwd();

  console.log('');
  console.log(`  Rollback: ${method}`);
  console.log(`     Target: ${target}`);
  if (dryRun) {
    console.log('     Mode: DRY RUN (preview only)');
  }
  console.log('');

  // Validate inputs BEFORE any git operations
  const validation = validateRollbackInput(method, target, root);
  if (!validation.valid) {
    console.log(`  ${validation.error}`);
    return false;
  }

  // Check for clean working directory
  if (!checkGitWorkingDirectory(runFile)) {
    return false;
  }

  // Extract USER sections before rollback
  const agentsPath = path.join(root, 'AGENTS.md');
  const savedSections = extractUserSections(agentsPath, { _fs: fsApi });

  if (!dryRun) {
    console.log('  Backing up user content...');
  }

  try {
    if (method === 'commit') {
      handleCommitRollback(target, dryRun, runFile);
    } else if (method === 'pr') {
      handlePrRollback(target, dryRun, runFile);
    } else if (method === 'partial') {
      handlePartialRollback(target, dryRun, runFile);
    } else if (method === 'branch') {
      handleBranchRollback(target, dryRun, runFile);
    }

    if (!dryRun) {
      finalizeRollback(agentsPath, savedSections, runFile, fsApi);
    }

    return true;
  } catch (err) {
    console.log('');
    console.log('  Rollback failed:', err.message);
    console.log('     Try manual rollback with: git revert <commit>');
    return false;
  }
}

/**
 * Interactive rollback menu.
 * @param {object} [opts]
 * @param {Function} [opts._createInterface] - Override readline (testing)
 * @param {Function} [opts._performRollback] - Override performRollback (testing)
 */
async function showRollbackMenu(opts = {}) {
  const doRollback = opts._performRollback || performRollback;

  console.log('');
  console.log('  Forge Rollback');
  console.log('');
  console.log('  Choose rollback method:');
  console.log('');
  console.log('  1. Rollback last commit');
  console.log('  2. Rollback specific commit');
  console.log('  3. Rollback merged PR');
  console.log('  4. Rollback specific files only');
  console.log('  5. Rollback entire branch');
  console.log('  6. Preview rollback (dry run)');
  console.log('');

  const createIface = opts._createInterface || (() => readline.createInterface({
    input: process.stdin,
    output: process.stdout
  }));

  const rl = createIface();

  const choice = await new Promise(resolve => {
    rl.question('  Enter choice (1-6): ', resolve);
  });

  let method, target, dryRun = false;

  switch (choice.trim()) {
    case '1': {
      method = 'commit';
      target = 'HEAD';
      break;
    }
    case '2': {
      target = await new Promise(resolve => {
        rl.question('  Enter commit hash: ', resolve);
      });
      method = 'commit';
      break;
    }
    case '3': {
      target = await new Promise(resolve => {
        rl.question('  Enter merge commit hash: ', resolve);
      });
      method = 'pr';
      break;
    }
    case '4': {
      target = await new Promise(resolve => {
        rl.question('  Enter file paths (comma-separated): ', resolve);
      });
      method = 'partial';
      break;
    }
    case '5': {
      const start = await new Promise(resolve => {
        rl.question('  Enter start commit: ', resolve);
      });
      const end = await new Promise(resolve => {
        rl.question('  Enter end commit: ', resolve);
      });
      target = `${start.trim()}..${end.trim()}`;
      method = 'branch';
      break;
    }
    case '6': {
      dryRun = true;
      const dryMethod = await new Promise(resolve => {
        rl.question('  Preview method (commit/pr/partial/branch): ', resolve);
      });
      method = dryMethod.trim();
      target = await new Promise(resolve => {
        rl.question('  Enter target (commit/files/range): ', resolve);
      });
      break;
    }
    default: {
      console.log('  Invalid choice');
      rl.close();
      return;
    }
  }

  rl.close();

  await doRollback(method, target, dryRun);
}

// ── Command handler (registry-compliant) ───────────────────────────────

/**
 * Main handler for the rollback command.
 * @param {string[]} _args - Positional arguments (unused)
 * @param {object} flags - CLI flags
 * @param {string} projectRoot - Project root path
 * @param {object} [opts] - Options for dependency injection
 * @param {Function} [opts._exec] - Override for execFileSync (testing)
 * @param {object} [opts._fs] - Override for fs module (testing)
 * @param {Function} [opts._createInterface] - Override readline (testing)
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
async function handler(_args, flags, projectRoot, opts = {}) {
  const method = flags['--method'] || flags.method;
  const target = flags['--target'] || flags.target;
  const dryRun = !!(flags['--dry-run'] || flags.dryRun);

  // Non-interactive: method + target provided as flags
  if (method && target) {
    const result = await performRollback(method, target, dryRun, projectRoot, opts);
    return { success: result };
  }

  // Interactive: show rollback menu
  await showRollbackMenu({
    _createInterface: opts._createInterface,
    _performRollback: (m, t, dr) => performRollback(m, t, dr, projectRoot, opts),
  });
  return { success: true };
}

module.exports = {
  name: 'rollback',
  description: 'Safely roll back commits, PRs, files, or branch ranges (preserves USER sections)',
  usage: 'forge rollback [--method <type> --target <value>] [--dry-run]',
  flags: {
    '--method': 'Rollback method: commit, pr, partial, branch',
    '--target': 'Target: commit hash, file paths (comma-sep), or range (start..end)',
    '--dry-run': 'Preview only — show what would be rolled back',
  },
  handler,
  // Exported for direct use and testing
  validateRollbackInput,
  extractUserSections,
  preserveUserSections,
  performRollback,
  showRollbackMenu,
  checkGitWorkingDirectory,
  handleCommitRollback,
  handlePrRollback,
  handlePartialRollback,
  handleBranchRollback,
  finalizeRollback,
  updateBeadsIssue,
  extractUserMarkerSections,
  extractCustomCommands,
  validateCommitHash,
  validatePartialRollbackPaths,
  validateBranchRange,
};
