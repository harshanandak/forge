'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Forge Clean Command
 * Remove worktrees for merged branches (squash-merge aware) and optionally
 * fast-forward the main checkout's default branch after merges.
 *
 * Uses execFileSync (not execSync) to prevent command injection (OWASP A03).
 *
 * The Kernel issue store lives in the shared git common dir, so there is no
 * per-worktree server to stop before removal — cleanup is pure git.
 *
 * @module commands/clean
 */

/**
 * Run a git/gh command through the injected runner, returning trimmed stdout.
 * Returns '' on any failure (callers treat empty as "no signal").
 * @param {Function} runFile - execFileSync-compatible function
 * @param {string} cmd - Executable (e.g. 'git', 'gh')
 * @param {string[]} args - Arguments
 * @returns {string} Trimmed stdout, or '' on error
 */
function tryRun(runFile, cmd, args) {
  try {
    return runFile(cmd, args, { stdio: 'pipe' }).toString().trim();
  } catch (_e) { /* intentional: caller treats '' as no-signal */ // NOSONAR S2486
    return '';
  }
}

/**
 * Detect the default branch (main, master, develop, trunk).
 * Tries origin/HEAD first, then probes common names.
 * @param {Function} runFile - execFileSync-compatible function
 * @returns {string} Default branch name
 */
function getDefaultBranch(runFile) {
  try {
    return runFile('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { stdio: 'pipe' })
      .toString().trim().replace('origin/', '');
  } catch (_e) { /* intentional: origin/HEAD not set, probe common names */ // NOSONAR S2486
    for (const name of ['main', 'master', 'develop', 'trunk']) {
      try {
        runFile('git', ['rev-parse', '--verify', name], { stdio: 'pipe' });
        return name;
      } catch (_e2) { /* intentional: try next branch name */ } // NOSONAR S2486
    }
    return 'main';
  }
}

/**
 * Parse `git worktree list --porcelain` output into a map of path -> branch.
 * @param {string} output - Raw porcelain output
 * @returns {Map<string, string>} Map of worktree path -> branch name
 */
function parseWorktreeList(output) {
  const map = new Map();
  const blocks = output.split('\n\n');
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    let wtPath = null;
    let branch = null;
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length);
      }
      if (line.startsWith('branch ')) {
        // branch refs/heads/feat/foo -> feat/foo
        branch = line.slice('branch refs/heads/'.length);
      }
    }
    if (wtPath && branch) {
      map.set(wtPath, branch);
    }
  }
  return map;
}

/**
 * Return the first worktree block from `git worktree list --porcelain` — the
 * main working tree — as { path, branch } (branch is null when detached).
 * @param {string} output - Raw porcelain output
 * @returns {{ path: string, branch: string|null }|null}
 */
function parseMainWorktree(output) {
  const firstBlock = output.split('\n\n')[0] || '';
  let wtPath = null;
  let branch = null;
  for (const line of firstBlock.trim().split('\n')) {
    if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length);
    if (line.startsWith('branch ')) branch = line.slice('branch refs/heads/'.length);
  }
  return wtPath ? { path: wtPath, branch } : null;
}

/**
 * GitHub tier: collect head refs of merged PRs (one memoized call).
 * Returns an empty Set when gh is unavailable or errors — a safe no-signal.
 * @param {Function} runFile - execFileSync-compatible function
 * @returns {Map<string, string>} Map of merged PR head branch name -> head commit OID
 */
function getGhMergedRefs(runFile) {
  const out = tryRun(runFile, 'gh', ['pr', 'list', '--state', 'merged', '--json', 'headRefName,headRefOid', '--limit', '200']);
  if (!out) return new Map();
  try {
    const arr = JSON.parse(out);
    if (!Array.isArray(arr)) return new Map();
    const map = new Map();
    // Record the head OID too: a reused/advanced branch name must NOT be treated as
    // merged unless its current tip still matches the OID GitHub merged.
    for (const p of arr) {
      if (p && p.headRefName && p.headRefOid) map.set(p.headRefName, p.headRefOid);
    }
    return map;
  } catch (_e) { /* intentional: malformed gh output → no signal */ // NOSONAR S2486
    return new Map();
  }
}

/**
 * Squash-merge tier (git-only, deterministic). A squash-merged branch tip is
 * NOT an ancestor of the default branch, so `git branch --merged` misses it.
 * Instead, synthesize a single commit from the branch's tree onto the
 * merge-base and ask `git cherry` whether the default branch already contains a
 * patch-equivalent commit. `git cherry` prints `- <sha>` when an equivalent
 * exists (i.e. the branch was squash-merged) and `+ <sha>` otherwise.
 * Empty output / any error → treated as NOT merged (never remove on doubt).
 * @param {string} branch - Branch under test
 * @param {string} defaultBranch - Default branch name
 * @param {Function} runFile - execFileSync-compatible function
 * @returns {boolean} True iff the branch is patch-equivalent-merged into default
 */
function isSquashMerged(branch, defaultBranch, runFile) {
  const mergeBase = tryRun(runFile, 'git', ['merge-base', defaultBranch, branch]);
  if (!mergeBase) return false;
  const tree = tryRun(runFile, 'git', ['rev-parse', `${branch}^{tree}`]);
  if (!tree) return false;
  const synthetic = tryRun(runFile, 'git', ['commit-tree', tree, '-p', mergeBase, '-m', '_']);
  if (!synthetic) return false;
  const cherry = tryRun(runFile, 'git', ['cherry', defaultBranch, synthetic]);
  // A single `- <sha>` line means the combined diff is already in `default`.
  return cherry.startsWith('-');
}

/**
 * Squash-aware merged detection over three short-circuiting tiers:
 *   (a) ancestry list (`git branch --merged`), (b) merged-PR head refs (gh),
 *   (c) git-only squash patch-equivalence. A branch confirmed by none stays.
 * @param {string} branch - Branch name
 * @param {object} ctx - Detection context
 * @param {string} ctx.defaultBranch - Default branch name
 * @param {string[]} ctx.mergedBranches - Ancestry-merged branch names
 * @param {Map<string, string>} ctx.ghMergedRefs - Merged PR head branch -> head OID
 * @param {Function} ctx.runFile - execFileSync-compatible function
 * @returns {boolean} True iff the branch is merged (any tier)
 */
function detectMerged(branch, ctx) {
  if (ctx.mergedBranches.includes(branch)) return true;
  if (ctx.ghMergedRefs) {
    const mergedOid = ctx.ghMergedRefs.get(branch);
    // Only trust the gh "merged" signal when the merged PR's head OID still matches
    // the branch tip; a reused/advanced branch name with new commits falls through
    // to the squash patch-equivalence check (never remove on doubt).
    if (mergedOid) {
      const tip = tryRun(ctx.runFile, 'git', ['rev-parse', branch]);
      if (tip && tip === mergedOid) return true;
    }
  }
  return isSquashMerged(branch, ctx.defaultBranch, ctx.runFile);
}

/**
 * Whether a worktree has uncommitted (staged or unstaged) changes.
 * Merged branches have their commits in the default branch already, so the only
 * loss risk is uncommitted working-tree edits — those block removal.
 * @param {string} wtPath - Absolute worktree path
 * @param {Function} runFile - execFileSync-compatible function
 * @returns {boolean} True iff dirty
 */
function isWorktreeDirty(wtPath, runFile) {
  try {
    const out = runFile('git', ['-C', wtPath, 'status', '--porcelain'], { stdio: 'pipe' }).toString().trim();
    return out.length > 0;
  } catch (_e) { /* status unknowable → treat as UNSAFE (dirty) so we never remove on doubt */ // NOSONAR S2486
    return true;
  }
}

const DEFAULT_MAX_TRIES = 3;

/**
 * Windows-robust worktree removal. FS locks on Windows frequently fail
 * `git worktree remove` with "Directory not empty" / "Permission denied", so:
 *   1. retry plain remove with backoff,
 *   2. fall back to `--force`,
 *   3. `git worktree prune` + manual recursive dir removal.
 * Never throws — returns a structured outcome so survivors can be reported.
 * @param {string} wtPath - Absolute worktree path
 * @param {Function} runFile - execFileSync-compatible function
 * @param {object} fsApi - fs-compatible module
 * @param {object} opts - Injection: _sleep, _maxTries
 * @returns {Promise<{ removed: boolean, method?: string, error?: string }>}
 */
async function removeWorktreeRobust(wtPath, runFile, fsApi, opts = {}) {
  const sleep = opts._sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const maxTries = Number.isInteger(opts._maxTries) ? opts._maxTries : DEFAULT_MAX_TRIES;
  const errors = [];

  for (let attempt = 0; attempt < maxTries; attempt++) {
    try {
      runFile('git', ['worktree', 'remove', wtPath], { stdio: 'pipe' });
      return { removed: true, method: 'remove' };
    } catch (err) {
      errors.push(err.message);
      if (attempt < maxTries - 1) await sleep(200 * (attempt + 1));
    }
  }

  try {
    runFile('git', ['worktree', 'remove', '--force', wtPath], { stdio: 'pipe' });
    return { removed: true, method: 'force' };
  } catch (err) { errors.push(err.message); }

  // Last resort: prune the ref, then manually remove the directory.
  try {
    runFile('git', ['worktree', 'prune'], { stdio: 'pipe' });
    if (fsApi.existsSync(wtPath)) {
      fsApi.rmSync(wtPath, { recursive: true, force: true });
    }
    if (!fsApi.existsSync(wtPath)) {
      runFile('git', ['worktree', 'prune'], { stdio: 'pipe' });
      return { removed: true, method: 'prune+rm' };
    }
  } catch (err) { errors.push(err.message); }

  return { removed: false, error: errors[errors.length - 1] || 'unknown removal failure' };
}

/**
 * Categorize + (optionally) remove a single worktree directory.
 * @param {string} dir - Directory name within .worktrees/
 * @param {Map<string, string>} worktreeMap - Path-to-branch mapping
 * @param {Function} isMergedFn - (branch) => boolean squash-aware detector
 * @param {string} worktreesDir - Absolute path to .worktrees/
 * @param {boolean} dryRun - If true, skip actual removal
 * @param {Function} runFile - execFileSync-compatible function
 * @param {object} fsApi - fs-compatible module
 * @param {object} opts - Removal injection options
 * @returns {Promise<{ status: string, path: string, branch: string|null, error?: string }>}
 */
async function cleanWorktree(dir, worktreeMap, isMergedFn, worktreesDir, dryRun, runFile, fsApi, opts) {
  const wtPath = path.resolve(worktreesDir, dir);
  const branch = worktreeMap.get(wtPath) || null;

  if (!branch || !isMergedFn(branch)) {
    return { status: 'active', path: wtPath, branch };
  }

  // Merged, but never blow away uncommitted local edits. Checked BEFORE the dry-run
  // branch so a dry run reports the same "dirty" skip the real run would take.
  if (isWorktreeDirty(wtPath, runFile)) {
    return { status: 'dirty', path: wtPath, branch };
  }

  if (dryRun) {
    return { status: 'cleaned', path: wtPath, branch };
  }

  const outcome = await removeWorktreeRobust(wtPath, runFile, fsApi, opts);
  if (outcome.removed) {
    return { status: 'cleaned', path: wtPath, branch, method: outcome.method };
  }
  return { status: 'survivor', path: wtPath, branch, error: outcome.error };
}

/**
 * Parse the file list from git's "untracked working tree files would be
 * overwritten by merge" error text.
 * @param {string} stderr - Combined stderr text from the failed merge
 * @returns {string[]} Repo-relative file paths
 */
function parseUntrackedOverwrites(stderr) {
  const files = [];
  let collecting = false;
  for (const raw of stderr.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/would be overwritten by merge:/i.test(line)) { collecting = true; continue; }
    if (/^please move or remove them|^aborting/i.test(line.trim())) { collecting = false; continue; }
    if (collecting) {
      const f = line.trim();
      if (f) files.push(f);
    }
  }
  return files;
}

/**
 * Move would-be-overwritten untracked files into a timestamped backup dir so a
 * fast-forward can proceed without losing local work.
 * @returns {string[]} Relative paths that were backed up
 */
function backupUntracked(fsApi, mainPath, stderr, opts) {
  const files = parseUntrackedOverwrites(stderr);
  if (files.length === 0) return [];
  const stamp = opts && opts._now ? opts._now() : Date.now();
  const backupDir = path.join(mainPath, '.forge', `clean-backup-${stamp}`);
  const moved = [];
  for (const rel of files) {
    try {
      const dest = path.join(backupDir, rel);
      fsApi.mkdirSync(path.dirname(dest), { recursive: true });
      fsApi.renameSync(path.join(mainPath, rel), dest);
      moved.push(rel);
    } catch (_e) { /* intentional: best-effort per-file backup */ } // NOSONAR S2486
  }
  return moved;
}

/**
 * Count revisions in a range (e.g. `main..origin/main`). Returns null on error/no
 * signal so callers can distinguish "verified 0 commits" from "could not verify"
 * (a successful rev-list --count always prints at least "0").
 */
function countRevs(runFile, cwd, range) {
  const out = tryRun(runFile, 'git', ['-C', cwd, 'rev-list', '--count', range]);
  if (out === '') return null;
  const n = parseInt(out, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fast-forward the checked-out default branch to origin, backing up any
 * untracked files that would block the merge.
 */
function fastForwardCheckedOut(runFile, fsApi, mainPath, defaultBranch, opts) {
  try {
    runFile('git', ['-C', mainPath, 'merge', '--ff-only', `origin/${defaultBranch}`], { stdio: 'pipe' });
    return { synced: true, method: 'ff' };
  } catch (err) {
    const stderr = err && err.stderr ? err.stderr.toString() : (err && err.message) || '';
    if (/untracked working tree files would be overwritten/i.test(stderr)) {
      const backedUp = backupUntracked(fsApi, mainPath, stderr, opts);
      try {
        runFile('git', ['-C', mainPath, 'merge', '--ff-only', `origin/${defaultBranch}`], { stdio: 'pipe' });
        return { synced: true, method: 'ff-after-backup', backedUp };
      } catch (err2) {
        return { synced: false, reason: 'ff-failed-after-backup', error: err2.message, backedUp };
      }
    }
    return { synced: false, reason: 'ff-failed', error: err && err.message };
  }
}

/**
 * Post-merge master auto-update: fetch origin and fast-forward the MAIN
 * checkout's default branch when it is strictly behind (never on divergence).
 * Untracked local files are preserved (backed up if they would block the FF).
 * Default-on; opt out with `--no-master-sync`. Never throws.
 * @returns {Promise<object>} Structured outcome for reporting
 */
async function syncMasterBranch(runFile, fsApi, opts = {}) {
  const result = { attempted: true, synced: false };
  try {
    const listOut = tryRun(runFile, 'git', ['worktree', 'list', '--porcelain']);
    const main = parseMainWorktree(listOut);
    if (!main) { result.reason = 'no-main-worktree'; return result; }

    const defaultBranch = getDefaultBranch(runFile);
    result.defaultBranch = defaultBranch;

    // Refresh origin/<default> without touching the working tree. A fetch failure is
    // surfaced (not swallowed into a misleading "up-to-date").
    try {
      runFile('git', ['-C', main.path, 'fetch', 'origin', defaultBranch], { stdio: 'pipe' });
    } catch (err) {
      result.reason = 'fetch-failed';
      result.error = err && err.message;
      return result;
    }

    const behind = countRevs(runFile, main.path, `${defaultBranch}..origin/${defaultBranch}`);
    const ahead = countRevs(runFile, main.path, `origin/${defaultBranch}..${defaultBranch}`);
    // null = rev-list could not verify the range; do NOT claim up-to-date on doubt.
    if (behind === null || ahead === null) { result.reason = 'rev-list-failed'; return result; }
    result.behind = behind;
    result.ahead = ahead;

    if (behind === 0) { result.reason = 'up-to-date'; return result; }
    if (ahead > 0) { result.reason = 'diverged'; return result; } // not a fast-forward — leave it

    if (main.branch === defaultBranch) {
      Object.assign(result, fastForwardCheckedOut(runFile, fsApi, main.path, defaultBranch, opts));
      return result;
    }

    // Main checkout is on a feature branch: fast-forward the local ref without checkout.
    try {
      runFile('git', ['-C', main.path, 'fetch', 'origin', `${defaultBranch}:${defaultBranch}`], { stdio: 'pipe' });
      result.synced = true;
      result.method = 'ref-update';
    } catch (err) {
      result.reason = 'ref-update-failed';
      result.error = err && err.message;
    }
    return result;
  } catch (err) {
    result.reason = 'error';
    result.error = err && err.message;
    return result;
  }
}

/** Append the dirty-worktree lines (extracted to keep formatOutput simple). */
function renderDirty(dirty, lines) {
  if (!dirty || dirty.length === 0) return;
  lines.push(`Skipped ${dirty.length} dirty worktree(s) with uncommitted changes:`);
  for (const p of dirty) lines.push(`  - ${p}`);
}

/** Append the survivor warning lines. */
function renderSurvivors(survivors, lines) {
  if (!survivors || survivors.length === 0) return;
  lines.push(`WARNING: ${survivors.length} merged worktree(s) could not be removed (manual cleanup needed):`);
  for (const s of survivors) lines.push(`  - ${s.path}${s.error ? ` (${s.error})` : ''}`);
}

/** Append the master-sync outcome line(s). */
function renderMasterSync(masterSync, lines) {
  if (!masterSync || !masterSync.attempted) return;
  const ms = masterSync;
  if (ms.synced) {
    lines.push(`Fast-forwarded ${ms.defaultBranch} (${ms.behind} commit(s) behind, method: ${ms.method}).`);
    if (ms.backedUp && ms.backedUp.length > 0) {
      lines.push(`  Backed up ${ms.backedUp.length} untracked file(s) before fast-forward.`);
    }
  } else if (ms.reason && ms.reason !== 'up-to-date' && ms.reason !== 'no-main-worktree') {
    lines.push(`Master sync skipped (${ms.reason}${ms.error ? `: ${ms.error}` : ''}).`);
  }
}

/**
 * Build the user-facing report line(s) for the clean run.
 */
function formatOutput(summary) {
  const lines = [];
  const verb = summary.dryRun ? 'Would remove' : 'Removed';
  lines.push(`${verb} ${summary.cleaned} merged worktree(s); ${summary.active} active kept.`);
  renderDirty(summary.dirty, lines);
  renderSurvivors(summary.survivors, lines);
  renderMasterSync(summary.masterSync, lines);
  return lines.join('\n');
}

/**
 * Main handler for the clean command.
 * @param {string[]} _args - Positional arguments (unused)
 * @param {object} flags - CLI flags
 * @param {string} projectRoot - Project root path
 * @param {object} [opts] - Options for dependency injection
 * @param {Function} [opts._exec] - Override for execFileSync (testing)
 * @param {object} [opts._fs] - Override for fs module (testing)
 * @param {Function} [opts._isMerged] - Override merged detection (testing)
 * @param {Function} [opts._syncMaster] - Override master sync (testing)
 * @returns {Promise<object>} Structured result
 */
/**
 * Scan .worktrees/ and remove the merged ones (squash-aware). Returns the tallies;
 * a no-op ({0,0,[],[]}) when .worktrees/ is absent or empty. Extracted from handler
 * so the top-level orchestration stays under the complexity gate.
 * @returns {Promise<{ cleaned: number, active: number, survivors: object[], dirty: string[] }>}
 */
async function cleanWorktrees(worktreesDir, runFile, fsApi, dryRun, opts) {
  const acc = { cleaned: 0, active: 0, survivors: [], dirty: [] };
  if (!fsApi.existsSync(worktreesDir)) return acc;

  const entries = fsApi.readdirSync(worktreesDir, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  if (dirs.length === 0) return acc;

  // Detection context: ancestry list + gh merged refs + squash fallback.
  const defaultBranch = getDefaultBranch(runFile);
  let mergedBranches = [];
  const mergedOut = tryRun(runFile, 'git', ['branch', '--merged', defaultBranch]);
  if (mergedOut) {
    mergedBranches = mergedOut.split('\n').map(b => b.trim().replace(/^\*\s*/, '')).filter(Boolean);
  }
  const ghMergedRefs = getGhMergedRefs(runFile);
  const ctx = { defaultBranch, mergedBranches, ghMergedRefs, runFile };
  const isMergedFn = opts._isMerged || (branch => detectMerged(branch, ctx));

  const listOutput = tryRun(runFile, 'git', ['worktree', 'list', '--porcelain']);
  const worktreeMap = listOutput ? parseWorktreeList(listOutput) : new Map();

  for (const dir of dirs) {
    const res = await cleanWorktree(dir, worktreeMap, isMergedFn, worktreesDir, dryRun, runFile, fsApi, opts);
    if (res.status === 'cleaned') acc.cleaned++;
    else if (res.status === 'survivor') acc.survivors.push(res);
    else if (res.status === 'dirty') acc.dirty.push(res.path);
    else acc.active++;
  }

  if (!dryRun && acc.cleaned > 0) {
    tryRun(runFile, 'git', ['worktree', 'prune']);
  }
  return acc;
}

async function handler(_args, flags, projectRoot, opts = {}) {
  const runFile = opts._exec || execFileSync;
  const fsApi = opts._fs || fs;
  const dryRun = !!(flags['--dry-run'] || flags.dryRun);
  const masterSyncEnabled = !(flags['--no-master-sync'] || flags.noMasterSync);
  const worktreesDir = path.resolve(projectRoot, '.worktrees');

  // Worktree cleanup (no-op when .worktrees/ absent); master auto-update is independent.
  const { cleaned, active, survivors, dirty } = await cleanWorktrees(worktreesDir, runFile, fsApi, dryRun, opts);

  // Post-merge master auto-update (default-on; skipped in dry-run).
  let masterSync = null;
  if (masterSyncEnabled && !dryRun) {
    const doSync = opts._syncMaster || (() => syncMasterBranch(runFile, fsApi, opts));
    masterSync = await doSync();
  }

  return finalize({ success: true, cleaned, active, dryRun, survivors, dirty }, masterSync);
}

/**
 * Attach the master-sync outcome + a rendered report to the result.
 */
function finalize(summary, masterSync) {
  const withSync = { ...summary, masterSync };
  return { ...withSync, output: formatOutput(withSync) };
}

module.exports = {
  name: 'clean',
  description: 'Remove worktrees for merged branches (squash-aware) and fast-forward the default branch',
  usage: 'forge clean [--dry-run] [--no-master-sync]',
  flags: {
    '--dry-run': 'Show what would be cleaned without removing',
    '--no-master-sync': 'Do not fast-forward the main checkout default branch after cleaning',
  },
  handler,
  // Exported for unit tests / reuse.
  _internals: {
    getDefaultBranch,
    parseWorktreeList,
    parseMainWorktree,
    getGhMergedRefs,
    isSquashMerged,
    detectMerged,
    isWorktreeDirty,
    removeWorktreeRobust,
    cleanWorktree,
    cleanWorktrees,
    parseUntrackedOverwrites,
    backupUntracked,
    syncMasterBranch,
    formatOutput,
  },
};
