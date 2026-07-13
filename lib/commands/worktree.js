'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Forge Worktree Command
 * Manage isolated worktrees.
 * Uses execFileSync (not execSync) to prevent command injection (OWASP A03).
 *
 * The Kernel issue store lives in the git common dir, which every worktree of a
 * repo shares, so no per-worktree issue-store bootstrap is needed — a new
 * worktree already sees the same kernel.
 *
 * Subcommands:
 *   create <slug> - Create worktree at .worktrees/<slug> with branch + install
 *   remove <slug> - Remove worktree via git worktree remove
 *
 * @module commands/worktree
 */

/**
 * Detect the package manager for a project root.
 * @param {string} projectRoot - Path to check for lock files
 * @param {object} fsApi - fs module (for DI)
 * @returns {string|null} Package manager command or null
 */
function detectPackageManager(projectRoot, fsApi) {
  // Bun ships two lockfile formats: the legacy binary `bun.lockb` and the current
  // text `bun.lock`. Recognize both so a Bun repo isn't mis-detected as npm.
  if (fsApi.existsSync(path.join(projectRoot, 'bun.lockb'))) return 'bun';
  if (fsApi.existsSync(path.join(projectRoot, 'bun.lock'))) return 'bun';
  if (fsApi.existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fsApi.existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  if (fsApi.existsSync(path.join(projectRoot, 'package-lock.json'))) return 'npm';
  if (fsApi.existsSync(path.join(projectRoot, 'package.json'))) return 'npm';
  return null;
}

/**
 * Check if a git branch already exists.
 * @param {string} branchName - Branch name to check
 * @param {Function} runFile - execFileSync function (for DI)
 * @returns {boolean}
 */
function branchExists(branchName, runFile) {
  try {
    const output = runFile('git', ['branch', '--list', branchName], { stdio: 'pipe' });
    return output.toString().trim().length > 0;
  } catch (_err) { /* intentional: branch doesn't exist */ // NOSONAR S2486
    return false;
  }
}

/**
 * True when a link failure is a privilege/support problem (Windows without the
 * symlink privilege, restricted FS) rather than a real error. In that case we
 * degrade to a package install instead of hard-failing.
 * @param {Error} error
 * @returns {boolean}
 */
function isLinkPermissionError(error) {
  return ['EPERM', 'EACCES', 'ENOSYS', 'UV_EPERM'].includes(error && error.code);
}

/**
 * Run package install in the new worktree if a package manager is detected, and
 * SURFACE failures (spawn error or non-zero exit) instead of swallowing them.
 * @param {string} worktreePath - Absolute path to the new worktree
 * @param {string} projectRoot - Absolute path to the project root
 * @param {Function} spawnFn - spawnSync-compatible function
 * @param {object} fsApi - fs module (for DI)
 * @returns {{ linked: boolean, installed: boolean }}
 * @throws {Error} when the install cannot be spawned or exits non-zero.
 */
function runInstall(worktreePath, projectRoot, spawnFn, fsApi) {
  const pkgManager = detectPackageManager(projectRoot, fsApi);
  if (!pkgManager) return { linked: false, installed: false };

  // shell:true on Windows: npm/pnpm/yarn are .cmd shims that cannot be spawned
  // directly (ENOENT / EINVAL). pkgManager comes from lockfile detection (fixed
  // set) and args are hardcoded, so no user input reaches the shell.
  const result = spawnFn(pkgManager, ['install'], {
    cwd: worktreePath,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  if (result && result.error) {
    throw new Error(`Dependency install failed: could not run '${pkgManager} install' in ${worktreePath}: ${result.error.message}`);
  }
  if (result && typeof result.status === 'number' && result.status !== 0) {
    throw new Error(`Dependency install failed: '${pkgManager} install' exited with code ${result.status} in ${worktreePath}`);
  }
  return { linked: false, installed: true };
}

/**
 * Populate the new worktree's node_modules. Fast path: link to the main repo's
 * shared install (a junction on Windows, a directory symlink on POSIX) so a fresh
 * worktree is immediately usable without a full reinstall — this repo's own
 * worktrees follow that pattern. Fallback: run the detected package manager's
 * install when there is no shared install to link. Both paths surface failures.
 * @param {string} worktreePath - Absolute path to the new worktree
 * @param {string} projectRoot - Absolute path to the project root
 * @param {object} deps
 * @param {Function} deps.spawnFn - spawnSync-compatible function
 * @param {object} deps.fsApi - fs module (for DI)
 * @param {string} deps.platform - process.platform value
 * @returns {{ linked: boolean, installed: boolean }}
 * @throws {Error} when linking fails for a non-privilege reason or install fails.
 */
function setupWorktreeDeps(worktreePath, projectRoot, { spawnFn, fsApi, platform }) {
  const srcModules = path.join(projectRoot, 'node_modules');
  const destModules = path.join(worktreePath, 'node_modules');

  // Already populated (e.g. git checkout carried it) — nothing to do.
  if (fsApi.existsSync(destModules)) return { linked: false, installed: false };

  // Fast path: link to the shared install when the main repo has one.
  if (fsApi.existsSync(srcModules)) {
    const linkType = platform === 'win32' ? 'junction' : 'dir';
    try {
      fsApi.symlinkSync(srcModules, destModules, linkType);
      return { linked: true, installed: false };
    } catch (error) {
      // Degrade to a real install only when the link was refused for lack of
      // privilege/support; any other failure is surfaced to the caller.
      if (!isLinkPermissionError(error)) throw error;
    }
  }

  return runInstall(worktreePath, projectRoot, spawnFn, fsApi);
}

/**
 * Best-effort: record the issue → worktree → work-folder linkage in the Kernel so
 * `forge worktree list` and orientation READ it instead of guessing the work-folder by
 * a filesystem heuristic. Writes a `kernel_worktrees` row keyed by the absolute worktree
 * path (idempotent upsert) and, when an issue + work-folder are given, drops a
 * machine-readable `.forge-issue` marker so a folder resolves to its issue deterministically.
 *
 * Never throws: a repo without a reachable Kernel (or without the 007 linkage columns)
 * must still get a usable worktree — orientation falls back to the folder heuristic.
 *
 * @param {object} params
 * @param {string} params.projectRoot
 * @param {string} params.worktreePath - Absolute worktree path (the row key).
 * @param {string} params.branch
 * @param {string|null} params.issueId
 * @param {string|null} params.workFolder - Repo-relative work-folder path.
 * @param {object} params.opts - DI options (may inject `_kernelDriver`, `_exec`, `_fs`).
 * @returns {Promise<{registered: boolean, issueId: string|null, workFolder: string|null, reason?: string}>}
 */
async function registerWorktreeLinkage({ projectRoot, worktreePath, branch, issueId, workFolder, opts }) {
  const runFile = opts._exec || execFileSync;
  const fsApi = opts._fs || fs;
  try {
    // Drop the folder → issue marker first — deterministic even if the DB write fails.
    if (workFolder && issueId) {
      const folderAbs = path.resolve(projectRoot, workFolder);
      fsApi.mkdirSync(folderAbs, { recursive: true });
      fsApi.writeFileSync(path.join(folderAbs, '.forge-issue'), `${issueId}\n`, 'utf8');
    }

    let driver = opts._kernelDriver;
    if (!driver) {
      // No reachable git repo → no shared Kernel; skip quietly (orientation still works
      // off the folder heuristic). Avoids spawning `git` in a non-repo directory.
      if (!fsApi.existsSync(path.join(projectRoot, '.git'))) {
        return { registered: false, issueId: issueId || null, workFolder: workFolder || null, reason: 'no git repository' };
      }
      // Lazy require: keep the worktree command light and avoid paying kernel setup
      // when linkage is not needed. Migrated deps guarantee the 007 columns exist.
      const { buildMigratedKernelIssueDeps } = require('../kernel/cli-broker-factory');
      driver = (await buildMigratedKernelIssueDeps({ projectRoot })).kernelDriver;
    }

    const { resolveGitCommonDir } = require('../kernel/broker');
    const gitCommonDir = resolveGitCommonDir(projectRoot, { execFileSync: runFile });

    driver.registerWorktree({
      git_common_dir: gitCommonDir,
      path: worktreePath,
      branch,
      actor: process.env.FORGE_ACTOR || null,
      issue_id: issueId || null,
      work_folder: workFolder || null,
      registered_at: new Date().toISOString(),
      state: 'active',
    });

    return { registered: true, issueId: issueId || null, workFolder: workFolder || null };
  } catch (error) {
    // Non-fatal: keep the worktree usable. Only warn when the caller explicitly asked
    // for linkage (--issue/--work-folder); a plain `worktree create` stays quiet.
    if (issueId || workFolder) {
      process.stderr.write(`forge worktree: kernel linkage not recorded (${error.message})\n`);
    }
    return { registered: false, issueId: issueId || null, workFolder: workFolder || null, reason: error.message };
  }
}

/**
 * Auto-file rail: guarantee the new worktree's branch has a backing Kernel issue,
 * WITHOUT anyone remembering `forge issue create` (kernel issue a4b8f56f). Best-effort
 * and NON-BLOCKING — the worktree must stay usable even if tracking fails, so any error
 * degrades to a stderr warning and null. Skipped when `--issue` already links a real
 * issue. Idempotent via ensureBackingIssue (deduped by branch), so re-creating a
 * worktree or later `forge push`/pre-push firing never mints a duplicate.
 *
 * @param {object} params
 * @param {string} params.projectRoot
 * @param {string} params.worktreePath
 * @param {string} params.branch
 * @param {string|null} params.issueId - explicit --issue (skip auto-file when set).
 * @param {object} params.opts - DI (may inject `_ensureBackingIssue`, `_kernelDriver`, `_kernelBroker`, `_fs`).
 * @returns {Promise<object|null>} the backing-issue descriptor, or null when skipped/unavailable.
 */
async function autoFileBackingIssue({ projectRoot, worktreePath, branch, issueId, opts }) {
  if (issueId) return null; // explicit --issue already links a real issue.
  const fsApi = opts._fs || fs;
  const ensureFn = opts._ensureBackingIssue || require('../kernel/backing-issue').ensureBackingIssue;
  try {
    let driver = opts._kernelDriver;
    let broker = opts._kernelBroker;
    if (!driver || !broker) {
      if (!fsApi.existsSync(path.join(projectRoot, '.git'))) return null; // no repo → no kernel
      const { buildMigratedKernelIssueDeps } = require('../kernel/cli-broker-factory');
      const deps = await buildMigratedKernelIssueDeps({ projectRoot });
      driver = driver || deps.kernelDriver;
      broker = broker || deps.kernelBroker;
    }
    return await ensureFn({ branch, projectRoot, worktreePath, driver, broker });
  } catch (error) {
    process.stderr.write(`forge worktree: backing issue not auto-filed (${error.message})\n`);
    return null;
  }
}

/**
 * Handle the "create" subcommand.
 * @param {string} slug - Worktree slug
 * @param {object} flags - CLI flags
 * @param {string} projectRoot - Project root path
 * @param {object} opts - DI options
 * @returns {Promise<object>} Result object
 */
async function handleCreate(slug, flags, projectRoot, opts) {
  const runFile = opts._exec || execFileSync;
  const runSpawn = opts._spawn || spawnSync;
  const fsApi = opts._fs || fs;

  const branchName = flags['--branch'] || flags.branch || `feat/${slug}`;
  const issueId = flags['--issue'] || null;
  const workFolder = flags['--work-folder'] || null;
  const worktreesDir = path.resolve(projectRoot, '.worktrees');

  // Guard: Detect bare repo state - worktrees created from bare repos produce broken branches
  // git rev-parse --show-toplevel throws in a bare repo (no working tree)
  try {
    runFile('git', ['-C', projectRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    /* intentional: show-toplevel fails in bare repos */
    const errMsg = String(error?.stderr || error?.message || '').trim();
    if (/must be run in a work tree|this operation must be run in a work tree/i.test(errMsg)) {
      return { success: false, error: 'bare repo detected' };
    }
    return { success: false, error: errMsg || 'git rev-parse --show-toplevel failed' };
  }

  // Security: Validate slug doesn't contain path traversal (OWASP A01/A03)
  if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
    return { success: false, error: String.raw`Invalid slug: must not contain "..", "/", or "\"` };
  }

  const worktreePath = path.resolve(worktreesDir, slug);

  // Step 0: Check if worktree already exists
  if (fsApi.existsSync(worktreePath)) {
    // A pre-existing worktree may be checked out on a different branch than the
    // requested branchName — read the actual HEAD so the kernel row is accurate.
    let existingBranch = branchName;
    try {
      const head = runFile('git', ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      // A detached worktree reports the literal "HEAD" — don't persist that; keep branchName.
      if (head && head !== 'HEAD') existingBranch = head;
    } catch (_error) { /* not a resolvable worktree HEAD — fall back to branchName */ }
    const linkage = await registerWorktreeLinkage({ projectRoot, worktreePath, branch: existingBranch, issueId, workFolder, opts });
    const backing = await autoFileBackingIssue({ projectRoot, worktreePath, branch: existingBranch, issueId, opts });
    return {
      success: true,
      reused: true,
      message: `Worktree already exists at ${worktreePath}`,
      worktreePath,
      linkage,
      backing,
    };
  }

  // Step 1: Ensure .worktrees/ dir exists
  fsApi.mkdirSync(worktreesDir, { recursive: true });

  // Step 2: Create git worktree
  const hasBranch = branchExists(branchName, runFile);
  if (hasBranch) {
    runFile('git', ['worktree', 'add', worktreePath, branchName], { stdio: 'pipe' });
  } else {
    runFile('git', ['worktree', 'add', worktreePath, '-b', branchName], { stdio: 'pipe' });
  }

  // Step 3: Populate node_modules (link to the shared install, else install).
  // No per-worktree issue-store bootstrap is needed — the Kernel DB lives in the
  // shared git common dir, so the new worktree already sees the same kernel.
  let deps;
  try {
    deps = setupWorktreeDeps(worktreePath, projectRoot, {
      spawnFn: runSpawn,
      fsApi,
      platform: opts._platform || process.platform,
    });
  } catch (error) {
    // Surface the failure instead of leaving a worktree with no usable deps.
    return { success: false, error: error.message, worktreePath, branch: branchName };
  }

  const linkage = await registerWorktreeLinkage({ projectRoot, worktreePath, branch: branchName, issueId, workFolder, opts });
  const backing = await autoFileBackingIssue({ projectRoot, worktreePath, branch: branchName, issueId, opts });

  return {
    success: true,
    worktreePath,
    branch: branchName,
    depsLinked: deps.linked,
    depsInstalled: deps.installed,
    linkage,
    backing,
  };
}

/**
 * Handle the "list" subcommand — read the worktree registry from the Kernel.
 * @param {string} projectRoot - Project root path
 * @param {object} opts - DI options (may inject `_kernelDriver`)
 * @returns {Promise<object>} Result object with a `worktrees` array
 */
async function handleList(projectRoot, opts) {
  try {
    let driver = opts._kernelDriver;
    if (!driver) {
      const { buildMigratedKernelIssueDeps } = require('../kernel/cli-broker-factory');
      driver = (await buildMigratedKernelIssueDeps({ projectRoot })).kernelDriver;
    }
    return { success: true, worktrees: driver.listWorktrees({}) };
  } catch (error) {
    return { success: false, error: error.message, worktrees: [] };
  }
}

/**
 * Handle the "remove" subcommand.
 * @param {string} slug - Worktree slug
 * @param {string} projectRoot - Project root path
 * @param {object} opts - DI options
 * @returns {Promise<object>} Result object
 */
async function handleRemove(slug, projectRoot, opts) {
  // Security: Validate slug doesn't contain path traversal (OWASP A01/A03)
  if (slug.includes('..') || slug.includes('/') || slug.includes('\\')) {
    return { success: false, error: String.raw`Invalid slug: must not contain "..", "/", or "\"` };
  }

  const runFile = opts._exec || execFileSync;
  const worktreePath = path.resolve(projectRoot, '.worktrees', slug);

  // No issue-store server to stop: the Kernel SQLite DB lives in the shared git
  // common dir, so removing a worktree directory never touches it.
  runFile('git', ['worktree', 'remove', worktreePath], { stdio: 'pipe' });

  return { success: true, removed: worktreePath };
}

// Long flags that take a value, in both `--flag value` and `--flag=value` forms.
const WORKTREE_VALUE_FLAGS = ['--branch', '--issue', '--work-folder'];
const WORKTREE_USAGE_HINT = 'Usage: forge worktree create <slug> [--branch <name>] [--issue <id>] [--work-folder <path>]';

function parseWorktreeArgs(args, flags) {
  const positional = [];
  const parsedFlags = { ...flags };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    const spaceFlag = WORKTREE_VALUE_FLAGS.find(flag => arg === flag);
    if (spaceFlag) {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        return { error: `Missing value for ${spaceFlag}. ${WORKTREE_USAGE_HINT}` };
      }
      parsedFlags[spaceFlag] = value;
      i++;
      continue;
    }

    const eqFlag = WORKTREE_VALUE_FLAGS.find(flag => arg.startsWith(`${flag}=`));
    if (eqFlag) {
      const value = arg.slice(`${eqFlag}=`.length);
      if (!value) {
        return { error: `Missing value for ${eqFlag}. ${WORKTREE_USAGE_HINT}` };
      }
      parsedFlags[eqFlag] = value;
      continue;
    }

    positional.push(arg);
  }

  // Back-compat alias consumed by handleCreate (flags['--branch'] || flags.branch).
  if (parsedFlags['--branch']) parsedFlags.branch = parsedFlags['--branch'];

  return { args: positional, flags: parsedFlags };
}

module.exports = {
  name: 'worktree',
  description: 'Manage isolated worktrees',
  usage: 'forge worktree <create|remove|list> <slug>',
  flags: {
    '--branch': 'Custom branch name (default: feat/<slug>)',
    '--issue': 'Kernel issue id to link this worktree to (records issue → worktree)',
    '--work-folder': 'Repo-relative work-folder this issue owns (records worktree → work-folder + drops a .forge-issue marker)',
  },

  /**
   * Main handler for the worktree command.
   * @param {string[]} args - Positional arguments: [subcommand, slug]
   * @param {object} flags - CLI flags
   * @param {string} projectRoot - Project root path
   * @param {object} [opts] - Options for dependency injection
   * @param {Function} [opts._exec] - Override for execFileSync (testing)
   * @param {Function} [opts._spawn] - Override for spawnSync (testing)
   * @param {object} [opts._fs] - Override for fs module (testing)
   * @param {string} [opts._platform] - Override for process.platform (testing)
   * @returns {Promise<object>}
   */
  handler: async (args, flags, projectRoot, opts = {}) => {
    const parsed = parseWorktreeArgs(args, flags);
    if (parsed.error) {
      return { success: false, error: parsed.error };
    }

    const subcommand = parsed.args[0];

    if (!subcommand || !['create', 'remove', 'list'].includes(subcommand)) {
      return {
        success: false,
        error: 'Missing or invalid subcommand. Usage: forge worktree <create|remove|list> <slug>',
      };
    }

    // `list` reads the Kernel registry and takes no slug.
    if (subcommand === 'list') {
      return handleList(projectRoot, opts);
    }

    const slug = parsed.args[1];
    if (!slug) {
      return {
        success: false,
        error: 'Missing slug. Usage: forge worktree <create|remove|list> <slug>',
      };
    }

    if (subcommand === 'create') {
      return handleCreate(slug, parsed.flags, projectRoot, opts);
    }

    return handleRemove(slug, projectRoot, opts);
  },

  // Exposed for unit tests; not part of the CLI surface.
  _internal: {
    detectPackageManager,
    setupWorktreeDeps,
    runInstall,
    autoFileBackingIssue,
  },
};
