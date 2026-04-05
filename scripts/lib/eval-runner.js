/**
 * Eval runner core — worktree isolation + command execution.
 *
 * Provides building blocks for the eval pipeline:
 *   - createEvalWorktree()   — spin up an isolated worktree
 *   - destroyEvalWorktree()  — tear it down (force, even if dirty)
 *   - resetWorktree()        — reset between eval queries
 *   - executeCommand()       — run a claude CLI command in a worktree
 */

const path = require('path');
const fs = require('fs');
const { execSync } = require('node:child_process');

// ── active worktree tracking (cleanup on crash) ─────────────────────
// Tracks active eval worktrees so we can clean up on process exit/crash.
// Prevents orphaned eval-* branches when interrupted.
// Note: execSync is safe here — all paths are internally generated, never user input.
const activeEvalWorktrees = new Map(); // path -> branch

/**
 * Force-remove a directory that git worktree remove may leave behind (Windows).
 */
function forceRemoveDir(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
    }
  } catch (_err) { /* best-effort */ }
}

function cleanupActiveWorktrees() {
  if (activeEvalWorktrees.size === 0) return;
  let repoRoot;
  try { repoRoot = getRepoRoot(); } catch (_err) { return; }
  for (const [wtPath, branch] of activeEvalWorktrees) {
    try {
      execSync(`git worktree remove --force "${wtPath}"`, { cwd: repoRoot, stdio: 'pipe' });
    } catch (_err) { /* already removed */ }
    forceRemoveDir(wtPath);
    if (branch && branch.startsWith('eval-')) {
      try {
        execSync(`git branch -D "${branch}"`, { cwd: repoRoot, stdio: 'pipe' });
      } catch (_err) { /* already deleted */ }
    }
  }
  try { execSync('git worktree prune', { cwd: repoRoot, stdio: 'pipe' }); } catch (_err) { /* ignore */ }
  activeEvalWorktrees.clear();
}

/**
 * Remove stale eval-* directories left behind by crashed runs.
 * Git has already forgotten them (worktree prune), but the directories persist on Windows.
 */
function cleanupStaleEvalWorktrees() {
  try {
    const worktreesDir = getWorktreesDir();
    if (!fs.existsSync(worktreesDir)) return;

    // Get the list of paths git still knows about
    const repoRoot = getRepoRoot();
    const knownRaw = execSync('git worktree list --porcelain', {
      cwd: repoRoot, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const knownPaths = new Set(
      knownRaw.split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.slice('worktree '.length).replace(/\\/g, '/'))
    );

    const entries = fs.readdirSync(worktreesDir);
    for (const entry of entries) {
      if (!entry.startsWith('eval-')) continue;
      const fullPath = path.join(worktreesDir, entry).replace(/\\/g, '/');
      if (!knownPaths.has(fullPath)) {
        forceRemoveDir(path.join(worktreesDir, entry));
      }
    }
  } catch (_err) { /* best-effort — don't block eval creation */ }
}

process.on('exit', cleanupActiveWorktrees);
process.on('SIGINT', () => {
  const hadWork = activeEvalWorktrees.size > 0;
  cleanupActiveWorktrees();
  if (hadWork) process.exit(130);
});
process.on('SIGTERM', () => {
  const hadWork = activeEvalWorktrees.size > 0;
  cleanupActiveWorktrees();
  if (hadWork) process.exit(143);
});

// ── helpers ──────────────────────────────────────────────────────────

/**
 * Detect the repo root by walking up from cwd.
 * Works from both the main repo and from within worktrees.
 */
function getRepoRoot() {
  const root = execSync('git rev-parse --show-toplevel', {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
  return root;
}

/**
 * Get the .worktrees directory path for eval worktrees.
 * Eval worktrees live under <repo-root>/.worktrees/
 */
function getWorktreesDir() {
  const root = getRepoRoot();
  return path.join(root, '.worktrees');
}

// ── createEvalWorktree ───────────────────────────────────────────────

/**
 * Create a git worktree with a unique name for eval isolation.
 *
 * @returns {Promise<{ path: string, branch: string }>}
 */
async function createEvalWorktree() {
  // Self-heal: remove stale eval dirs from previous crashed runs
  cleanupStaleEvalWorktrees();

  const timestamp = Date.now();
  const pid = process.pid;
  const name = `eval-${timestamp}-${pid}`;
  const branch = `eval-${timestamp}-${pid}`;
  const worktreesDir = getWorktreesDir();
  const wtPath = path.join(worktreesDir, name);

  // Create the worktree with a detached HEAD first, then create branch
  execSync(`git worktree add -b "${branch}" "${wtPath}" HEAD`, {
    cwd: getRepoRoot(),
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  activeEvalWorktrees.set(wtPath, branch);
  return { path: wtPath, branch };
}

// ── destroyEvalWorktree ──────────────────────────────────────────────

/**
 * Remove a worktree and its temporary branch.
 * Succeeds even if the worktree is dirty.
 *
 * @param {string} worktreePath — absolute path to the worktree
 * @returns {Promise<void>}
 */
async function destroyEvalWorktree(worktreePath) {
  const repoRoot = getRepoRoot();

  // Query actual branch for this worktree (more reliable than inferring from dir name)
  let branch;
  try {
    branch = execSync('git branch --show-current', {
      cwd: worktreePath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (_err) {
    // Worktree may be corrupted — fall back to directory name
    branch = path.basename(worktreePath);
  }

  // Remove the worktree (--force handles dirty state)
  execSync(`git worktree remove --force "${worktreePath}"`, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Windows: git worktree remove often leaves the directory behind
  forceRemoveDir(worktreePath);

  // Prune to clean up references
  execSync('git worktree prune', {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  activeEvalWorktrees.delete(worktreePath);

  // Delete the temporary branch (force in case it's not fully merged)
  if (branch && branch.startsWith('eval-')) {
    try {
      execSync(`git branch -D "${branch}"`, {
        cwd: repoRoot,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (_err) {
      // Branch may already be gone — ignore
    }
  }
}

// ── resetWorktree ────────────────────────────────────────────────────

/**
 * Reset a worktree to a clean state (tracked files restored, untracked removed).
 *
 * @param {string} worktreePath — absolute path to the worktree
 * @returns {Promise<void>}
 */
async function resetWorktree(worktreePath) {
  // Restore tracked files
  execSync('git checkout -- .', {
    cwd: worktreePath,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Remove untracked files, directories, and ignored files (full reset between runs)
  execSync('git clean -fdx', {
    cwd: worktreePath,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

// ── executeCommand ───────────────────────────────────────────────────

/**
 * Execute a command in an eval worktree.
 *
 * In production, runs `claude -p "<prompt>" --output-format stream-json --verbose --no-session-persistence`.
 * Accepts an optional `cmdOverride` array for testing (avoids invoking real LLM).
 *
 * @param {string} _command — label only (e.g., "/status")
 * @param {string} prompt — the prompt to send
 * @param {string} worktreePath — absolute path to the worktree (used as cwd)
 * @param {number} [timeout=120000] — timeout in milliseconds
 * @param {string[]} [cmdOverride] — optional command array for testing
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number, timedOut: boolean }>}
 */
async function executeCommand(_command, prompt, worktreePath, timeout = 120000, cmdOverride) {
  // Build the command to run
  const cmd = cmdOverride || [
    'claude',
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--no-session-persistence',
  ];

  // Build environment: inherit current env, strip CLAUDECODE, set FORGE_EVAL
  const env = { ...process.env };
  delete env.CLAUDECODE;
  env.FORGE_EVAL = '1';

  // Spawn with Bun.spawn (array form, no shell interpolation)
  const proc = Bun.spawn(cmd, { // eslint-disable-line no-undef -- Bun global provided by runtime
    cwd: worktreePath,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  let timeoutId;

  // Set up timeout
  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill();
      resolve();
    }, timeout);
  });

  // Wait for process to exit (or timeout)
  const exitPromise = proc.exited.then(() => {
    clearTimeout(timeoutId);
  });

  await Promise.race([exitPromise, timeoutPromise]);

  // Read stdout and stderr
  let stdout = '';
  let stderr = '';

  try {
    stdout = await new Response(proc.stdout).text();
  } catch (_err) {
    // stream may be closed on kill — ignore
  }

  try {
    stderr = await new Response(proc.stderr).text();
  } catch (_err) {
    // stream may be closed on kill — ignore
  }

  const exitCode = timedOut ? (proc.exitCode ?? 1) : proc.exitCode;

  return {
    stdout,
    stderr,
    exitCode,
    timedOut,
  };
}

module.exports = {
  createEvalWorktree,
  destroyEvalWorktree,
  resetWorktree,
  executeCommand,
};
