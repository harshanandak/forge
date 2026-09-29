'use strict';

const { execFileSync } = require('child_process');
const fs = require('node:fs');
const path = require('path');

// This synchronous git spawn can hang on Windows/Node (same class of issue as
// ba388d01 / #356's Kernel broker fix). A bounded `timeout` makes each spawn
// fail fast (ETIMEDOUT) instead of hanging forever; git normally answers these
// in milliseconds, so 30s only guards against a pathological wedge.
const GIT_SPAWN_TIMEOUT_MS = 30000;

/**
 * Detect if the current directory is inside a git worktree.
 * Uses git rev-parse --git-dir vs --git-common-dir — they differ in worktrees.
 *
 * @param {string} [cwd=process.cwd()] - Directory to check
 * @param {object} [deps] - Injectable dependencies for testing (execFileSync, warn)
 * @returns {{ inWorktree: boolean, branch?: string, mainWorktree?: string, currentWorktree?: string }}
 */
function detectWorktree(cwd = process.cwd(), deps = {}) {
  const exec = deps.execFileSync || execFileSync;
  const warn = deps.warn || ((message) => console.warn(message));

  try {
    const gitDir = exec('git', ['rev-parse', '--git-dir'], {
      encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: GIT_SPAWN_TIMEOUT_MS
    }).trim();

    const gitCommonDir = exec('git', ['rev-parse', '--git-common-dir'], {
      encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: GIT_SPAWN_TIMEOUT_MS
    }).trim();

    // Empty output from either probe is not a valid git dir. Do NOT feed it to
    // path.resolve — an empty string resolves to `cwd`, which would make an
    // empty gitDir compare equal-or-unequal by accident (falsely reporting
    // inWorktree, or returning extra non-fallback fields). Degrade to the
    // documented { inWorktree: false } fallback with a warning instead.
    if (!gitDir || !gitCommonDir) {
      warn('[forge] git worktree detection got empty git dir output '
        + `(gitDir=${JSON.stringify(gitDir)}, gitCommonDir=${JSON.stringify(gitCommonDir)}); `
        + 'falling back to { inWorktree: false }');
      return { inWorktree: false };
    }

    // Resolve to absolute paths for reliable comparison
    const absGitDir = path.resolve(cwd, gitDir);
    const absCommonDir = path.resolve(cwd, gitCommonDir);

    const branch = exec('git', ['branch', '--show-current'], {
      encoding: 'utf8', cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout: GIT_SPAWN_TIMEOUT_MS
    }).trim();
    const mainWorktree = path.resolve(absCommonDir, '..');
    const currentWorktree = path.resolve(cwd);

    // In a worktree, git-dir is like .git/worktrees/<name>
    // while git-common-dir is the main .git directory
    if (absGitDir !== absCommonDir) {
      return { inWorktree: true, branch, mainWorktree, currentWorktree };
    }

    return { inWorktree: false, branch, mainWorktree, currentWorktree };
  } catch (err) {
    // Not in a git repo, git not available, or a spawn that hung past the
    // bound (ETIMEDOUT) — none of these should crash the caller. Degrade
    // gracefully to the same shape callers already handle.
    warn(`[forge] git worktree detection failed (${err.code || err.message}); `
      + 'falling back to { inWorktree: false }');
    return { inWorktree: false };
  }
}

/**
 * Parse `git worktree list --porcelain -z` into `{ path, bare }` records, in git's
 * order (the first record is always the main worktree). Fields are NUL-terminated
 * (a record ends with an extra NUL), so a path containing a newline stays intact.
 * @param {string} output - NUL-delimited porcelain output
 * @returns {Array<{ path: string, bare: boolean }>}
 */
function parseWorktreePorcelain(output) {
  const records = [];
  let current = null;
  for (const field of String(output || '').split('\0')) {
    if (field.startsWith('worktree ')) {
      current = { path: path.resolve(field.slice('worktree '.length)), bare: false };
      records.push(current);
    } else if (field === 'bare' && current) {
      current.bare = true;
    }
  }
  return records;
}

/**
 * One path from `git rev-parse <flag>`, with ONLY the single trailing newline
 * removed: each path gets its own call, so a path containing a newline (or
 * leading/trailing spaces) is never split or trimmed into a different path.
 */
function gitPath(runFile, projectRoot, flag) {
  return gitOut(runFile, projectRoot, ['rev-parse', flag]).replace(/\r?\n$/, '');
}

// Repository-location variables a git hook (or parent git) may export. Inherited,
// they redirect `git -C <dir>` discovery to another repo, so discovery drops them.
// Same list as scripts/test.js stripGitHookEnv (not imported: scripts/ -> lib/ only).
const GIT_LOCATION_ENV = new Set([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_QUARANTINE_PATH',
]);

function discoveryEnv(sourceEnv = process.env) {
  const env = { ...sourceEnv };
  for (const key of Object.keys(env)) {
    if (GIT_LOCATION_ENV.has(key.toUpperCase())) delete env[key];
  }
  return env;
}

function gitOut(runFile, projectRoot, args) {
  return String(runFile('git', ['-C', projectRoot, ...args], {
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: GIT_SPAWN_TIMEOUT_MS, env: discoveryEnv(),
  }) || '');
}

/**
 * Whether `dir` sits inside a LINKED worktree, judged from the filesystem alone:
 * the nearest `.git` entry walking up is a FILE (`gitdir: ...`), not a directory.
 * Used only to refuse the projectRoot fallback when git itself cannot answer.
 * @param {string} dir - Starting directory
 * @returns {boolean}
 */
function insideLinkedWorktree(dir) {
  let current = path.resolve(dir);
  for (;;) {
    try {
      return fs.lstatSync(path.join(current, '.git')).isFile();
    } catch (_error) { /* no .git here: keep walking up */ }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Resolve the MAIN worktree so `.worktrees/` always lives under the main checkout,
 * even from inside a linked worktree. `git worktree list --porcelain` lists the main
 * worktree first but reports the COMMON DIR as its path whenever that is not
 * `<checkout>/.git` (submodule, --separate-git-dir), so the checkout comes from, in
 * order: core.worktree (submodules), this checkout's toplevel when it IS the main
 * worktree, else the porcelain main entry. A bare main worktree, or a main checkout
 * git has no record of, is reported (`bare` / `error`) — callers refuse, never guess.
 * No `--path-format` (git >= 2.31 only): relative rev-parse output is resolved
 * against projectRoot, the directory git ran in (`-C`).
 *
 * Fallback (documented): when git reports nothing — a non-git directory, or a
 * mocked runner in tests — the result is projectRoot with `worktrees: null`. That
 * fallback is REFUSED (`error`) when projectRoot is inside a linked worktree, where
 * guessing projectRoot would nest `.worktrees/` under the linked checkout.
 * @param {string} projectRoot - Current worktree / project root
 * @param {Function} [runFile] - execFileSync-compatible function (for DI)
 * @returns {{ root: string, bare: boolean, error?: string, worktrees: Array<{ path: string, bare: boolean }>|null }}
 */
function resolveMainWorktree(projectRoot, runFile = execFileSync) {
  const base = path.resolve(projectRoot);
  const unknown = (reason) => ({
    root: base, bare: false, worktrees: null,
    error: `main worktree location unknown: ${reason}. Run this from the main checkout.`,
  });
  const fallback = () => (insideLinkedWorktree(base)
    ? unknown('git could not list worktrees from inside a linked worktree')
    : { root: projectRoot, bare: false, worktrees: null }); // as given: callers treat it exactly like projectRoot

  let worktrees;
  try {
    worktrees = parseWorktreePorcelain(gitOut(runFile, projectRoot, ['worktree', 'list', '--porcelain', '-z']));
  } catch (_error) {
    return fallback();
  }
  if (worktrees.length === 0) return fallback();
  if (worktrees[0].bare) return { root: worktrees[0].path, bare: true, worktrees };

  let gitDir;
  let commonDir;
  try {
    gitDir = gitPath(runFile, projectRoot, '--git-dir');
    commonDir = gitPath(runFile, projectRoot, '--git-common-dir');
  } catch (error) {
    return unknown(`git rev-parse failed (${String(error?.message).split('\n')[0]})`);
  }
  if (!gitDir || !commonDir) return unknown('git rev-parse returned no paths');
  gitDir = path.resolve(base, gitDir);
  commonDir = path.resolve(base, commonDir);

  let coreWorktree = '';
  try {
    coreWorktree = gitOut(runFile, projectRoot, ['config', '--get', 'core.worktree']).replace(/\r?\n$/, '');
  } catch (_error) { /* unset: git exits 1 */ }
  if (coreWorktree) return { root: path.resolve(commonDir, coreWorktree), bare: false, worktrees };
  if (gitDir === commonDir) {
    let topLevel = '';
    try { topLevel = gitPath(runFile, projectRoot, '--show-toplevel'); } catch (_error) { /* handled below */ }
    if (!topLevel) return unknown('git rev-parse --show-toplevel failed');
    return { root: path.resolve(base, topLevel), bare: false, worktrees };
  }
  if (path.relative(worktrees[0].path, commonDir) === '') {
    return { ...unknown(`git reports only its git dir (${commonDir})`), worktrees };
  }
  return { root: worktrees[0].path, bare: false, worktrees };
}

/**
 * The toplevel of the checkout a command was INVOKED from. bin/forge.js passes the
 * invocation cwd, which may be a subdirectory, so compare this — not projectRoot —
 * against a worktree before removing it. When git cannot answer (fails, times
 * out, prints nothing) but `main` shows git DID list worktrees, the invoking
 * checkout is unknown: returns `{ error }` so callers refuse rather than compare
 * the wrong path. Only the documented non-git/mocked fallback (`main.worktrees`
 * null or no `main`) compares projectRoot itself.
 * @param {string} projectRoot - Invocation directory
 * @param {Function} [runFile] - execFileSync-compatible function (for DI)
 * @param {{ worktrees: Array|null }} [main] - resolveMainWorktree() result
 * @returns {{ root: string } | { error: string }}
 */
function resolveInvokingWorktreeRoot(projectRoot, runFile = execFileSync, main = null) {
  try {
    const top = gitPath(runFile, projectRoot, '--show-toplevel');
    if (top) return { root: path.resolve(projectRoot, top) };
  } catch (_error) { /* handled below */ }
  if (main?.worktrees) {
    return { error: `invoking checkout unknown: git rev-parse --show-toplevel failed in ${projectRoot}. Refusing to remove worktrees; retry, or run from another checkout.` };
  }
  return { root: path.resolve(projectRoot) };
}

/**
 * Canonical comparison key for a filesystem path: symlinks/8.3 names resolved via
 * realpathSync.native when the path exists, case-folded on win32.
 * @param {string} p - Path to canonicalize
 * @param {string} [platform] - Case-fold when 'win32' (default: this process)
 * @returns {string}
 */
function canonicalPathKey(p, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  let resolved = pathApi.resolve(p);
  try { resolved = fs.realpathSync.native(resolved); } catch (_error) { /* missing: compare as resolved */ }
  // Separator-normalised on win32 (git porcelain emits C:/..., path.resolve C:\...).
  return platform === 'win32' ? pathApi.normalize(resolved).toLowerCase() : resolved;
}

/**
 * True when `target` IS the invoking checkout or CONTAINS it (an ancestor, as in
 * the legacy nested layout `.worktrees/A/.worktrees/B` run from B). Removing
 * such a target deletes the invoking checkout with it, so callers must refuse.
 * Canonical paths; a `path.relative` check plus a separator-boundary check keep
 * `/a/foo` from matching `/a/foobar`.
 * @param {string} target - Worktree about to be removed
 * @param {string} invokingRoot - Toplevel of the checkout the command runs from
 * @param {string} [platform] - Case-fold when 'win32' (default: this process)
 * @returns {boolean}
 */
function isSameOrAncestor(target, invokingRoot, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const t = canonicalPathKey(target, platform);
  const i = canonicalPathKey(invokingRoot, platform);
  if (t === i) return true;
  const rel = pathApi.relative(t, i);
  const inside = rel !== '' && rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel);
  return inside && i.startsWith(t.endsWith(pathApi.sep) ? t : `${t}${pathApi.sep}`);
}

/**
 * Every REGISTERED worktree strictly inside `targetPath` (the target's own entry
 * excluded). A worktree may be removed only when this is empty: removing it would
 * otherwise delete those checkouts and their uncommitted (often ignored) files,
 * e.g. the legacy nested layout `.worktrees/A/.worktrees/B`, wherever the command
 * runs from. The invoking checkout is registered, so this covers "contains the
 * invoking checkout" too. Segment-prefix containment via isSameOrAncestor.
 * @param {string} targetPath - Worktree about to be removed
 * @param {string[]} registeredWorktreePaths - Every `git worktree list` path (main included)
 * @param {string} [platform] - Case-fold/separator-normalise when 'win32' (default: this process)
 * @returns {string[]} The nested registered paths, as given
 */
function findNestedWorktrees(targetPath, registeredWorktreePaths, platform = process.platform) {
  const targetKey = canonicalPathKey(targetPath, platform);
  return registeredWorktreePaths.filter((p) => canonicalPathKey(p, platform) !== targetKey
    && isSameOrAncestor(targetPath, p, platform));
}

module.exports = {
  detectWorktree,
  resolveMainWorktree,
  resolveInvokingWorktreeRoot,
  canonicalPathKey,
  isSameOrAncestor,
  findNestedWorktrees,
  parseWorktreePorcelain,
};
