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
const { execSync } = require('node:child_process');

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

  // Extract branch name from the worktree directory name
  const dirName = path.basename(worktreePath);

  // Remove the worktree (--force handles dirty state)
  execSync(`git worktree remove --force "${worktreePath}"`, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Prune to clean up references
  execSync('git worktree prune', {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Delete the temporary branch (force in case it's not fully merged)
  try {
    execSync(`git branch -D "${dirName}"`, {
      cwd: repoRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (_err) {
    // Branch may already be gone — ignore
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

  // Remove untracked files and directories
  execSync('git clean -fd', {
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
