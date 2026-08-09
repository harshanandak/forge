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
 * Canonicalize a worktree path for MAP KEYS ONLY (86b04c20): on Windows, git
 * worktree list --porcelain emits forward-slash paths (C:/...) while
 * path.resolve emits backslashes (C:\...), so a raw-string lookup never matches
 * and every merged worktree reads "active". Normalizes separators + drive-letter
 * case. Real fs/git calls keep the native path form.
 * @param {string} p - Path in either separator style
 * @returns {string} Canonical forward-slash key
 */
function normalizeWorktreeKey(p, platform = process.platform) {
  const key = String(p).replace(/\\/g, '/').replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`);
  // Windows filesystems are case-insensitive, so fold the WHOLE key there —
  // segment-level case differences between porcelain output and path.resolve
  // must not miss the lookup. POSIX paths stay case-sensitive.
  return platform === 'win32' ? key.toLowerCase() : key;
}

/**
 * Parse `git worktree list --porcelain` output into a map of path -> branch.
 * Keys are canonicalized via normalizeWorktreeKey so lookups match on Windows.
 * @param {string} output - Raw porcelain output
 * @returns {Map<string, string>} Map of canonical worktree path -> branch name
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
      map.set(normalizeWorktreeKey(wtPath), branch);
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
 * GitHub tier: collect merged PRs keyed by head branch (one memoized call).
 * Returns an empty Map when gh is unavailable or errors — a safe no-signal.
 * The number/title/merge-commit ride along so a merge can be CITED as evidence on
 * the kernel issue the branch was linked to (18f1988e), not just detected.
 * @param {Function} runFile - execFileSync-compatible function
 * @returns {Map<string, {headRefOid: string, number: number, title: string, mergeCommitOid: string|null}>}
 */
function getGhMergedPrs(runFile) {
  const out = tryRun(runFile, 'gh', ['pr', 'list', '--state', 'merged', '--json', 'number,title,headRefName,headRefOid,mergeCommit', '--limit', '200']);
  if (!out) return new Map();
  try {
    const arr = JSON.parse(out);
    if (!Array.isArray(arr)) return new Map();
    const map = new Map();
    // Record the head OID too: a reused/advanced branch name must NOT be treated as
    // merged unless its current tip still matches the OID GitHub merged.
    for (const p of arr) {
      if (p && p.headRefName && p.headRefOid) {
        map.set(p.headRefName, {
          headRefOid: p.headRefOid,
          number: p.number,
          title: p.title,
          mergeCommitOid: (p.mergeCommit && p.mergeCommit.oid) || null,
        });
      }
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
 * GitHub tier: a merged PR whose head OID still matches the branch tip. This is
 * direct evidence THIS tip was merged, not a git-topology inference — a
 * reused/advanced branch name falls through to the git-only tiers instead.
 * @param {string} branch - Branch name
 * @param {object} ctx - Detection context (see detectMerged)
 * @returns {boolean} True iff a merged PR is pinned to the current branch tip
 */
function hasMergedPrEvidence(branch, ctx) {
  const pr = ctx.ghMergedPrs && ctx.ghMergedPrs.get(branch);
  if (!pr || !pr.headRefOid) return false;
  const tip = tryRun(ctx.runFile, 'git', ['rev-parse', branch]);
  return Boolean(tip) && tip === pr.headRefOid;
}

/**
 * Whether a branch has contributed nothing yet — zero commits ahead of the
 * default branch (kernel c5ab529e).
 *
 * A branch created but not yet committed to points AT a default-branch commit,
 * so `git branch --merged` lists it and squash patch-equivalence finds an empty
 * diff already present: every git-only tier reads it as merged. It is unstarted
 * work, and `forge clean` deleted a live agent's fresh worktree and closed its
 * issue on that reading. Only a VERIFIED count of 0 counts as unstarted; an
 * unreadable count leaves detection exactly as it was.
 *
 * @param {string} branch - Branch name
 * @param {object} ctx - Detection context (see detectMerged)
 * @returns {boolean} True iff the branch is verified to have no commits of its own
 */
function isUnstartedBranch(branch, ctx) {
  const out = tryRun(ctx.runFile, 'git', ['rev-list', '--count', `${ctx.defaultBranch}..${branch}`]);
  return out !== '' && parseInt(out, 10) === 0;
}

/**
 * Squash-aware merged detection over three short-circuiting tiers:
 *   (a) merged-PR head refs (gh), (b) ancestry list (`git branch --merged`),
 *   (c) git-only squash patch-equivalence. A branch confirmed by none stays.
 *
 * The gh tier runs first because it is the only tier that cites real merge
 * evidence, so it still recognizes a fast-forward/merge-commit PR whose branch
 * ends up 0 commits ahead. The git-only tiers below cannot tell that case apart
 * from an unstarted branch, so they are gated on the branch having commits.
 *
 * @param {string} branch - Branch name
 * @param {object} ctx - Detection context
 * @param {string} ctx.defaultBranch - Default branch name
 * @param {string[]} ctx.mergedBranches - Ancestry-merged branch names
 * @param {Map<string, object>} ctx.ghMergedPrs - Merged PR head branch -> PR evidence
 * @param {Function} ctx.runFile - execFileSync-compatible function
 * @returns {boolean} True iff the branch is merged (any tier)
 */
function detectMerged(branch, ctx) {
  if (hasMergedPrEvidence(branch, ctx)) return true;
  if (isUnstartedBranch(branch, ctx)) return false;
  if (ctx.mergedBranches.includes(branch)) return true;
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
 * @returns {Promise<{ status: string, path: string, branch: string|null,
 *   closeIssue: boolean, error?: string }>}
 */
async function cleanWorktree(dir, worktreeMap, isMergedFn, worktreesDir, dryRun, runFile, fsApi, opts) {
  const wtPath = path.resolve(worktreesDir, dir);
  // Lookup by canonical key (86b04c20): porcelain emits C:/ paths, resolve emits C:\.
  const branch = worktreeMap.get(normalizeWorktreeKey(wtPath)) || null;

  // `closeIssue` rides on the SAME outcome that decides removal (kernel c5ab529e).
  // Closing is irreversible — `done` is terminal — so it may never be recomputed
  // independently and drift away from what cleanup actually decided to do.
  if (!branch || !isMergedFn(branch)) {
    return { status: 'active', path: wtPath, branch, closeIssue: false };
  }

  // Merged, but never blow away uncommitted local edits. Checked BEFORE the dry-run
  // branch so a dry run reports the same "dirty" skip the real run would take.
  // Held back for safety => the work is not confirmed finished => never closed.
  if (isWorktreeDirty(wtPath, runFile)) {
    return { status: 'dirty', path: wtPath, branch, closeIssue: false };
  }

  // A dry run reports what it would do and mutates nothing, kernel included.
  if (dryRun) {
    return { status: 'cleaned', path: wtPath, branch, closeIssue: false };
  }

  const outcome = await removeWorktreeRobust(wtPath, runFile, fsApi, opts);
  if (outcome.removed) {
    return { status: 'cleaned', path: wtPath, branch, method: outcome.method, closeIssue: true };
  }
  // Merged with a clean tree; only the directory removal lost to an FS lock. The
  // work IS in the default branch, so the issue is finished either way.
  return { status: 'survivor', path: wtPath, branch, error: outcome.error, closeIssue: true };
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

/** Append the closed-linked-issue lines. */
function renderClosedIssues(closedIssues, lines) {
  if (!closedIssues || closedIssues.length === 0) return;
  lines.push(`Closed ${closedIssues.length} linked issue(s) on merge:`);
  for (const c of closedIssues) lines.push(`  - ${c.issueId} (${c.branch})`);
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
  renderClosedIssues(summary.closedIssues, lines);
  renderMasterSync(summary.masterSync, lines);
  return lines.join('\n');
}

/**
 * Strip the merged-PR record down to the evidence cited on the kernel issue.
 * @param {Map<string, object>} ghMergedPrs
 * @param {string} branch
 * @returns {{number: number, title: string, mergeCommitOid: string|null}|null}
 */
function prEvidenceFor(ghMergedPrs, branch) {
  const pr = ghMergedPrs && ghMergedPrs.get(branch);
  if (!pr || !pr.number) return null;
  return { number: pr.number, title: pr.title, mergeCommitOid: pr.mergeCommitOid };
}

/**
 * Bridge from a merged branch to the close-on-merge primitive (kernel 18f1988e).
 *
 * The kernel driver + issue runner are built ONCE and only on the first merged
 * branch, so a clean run that removes nothing pays nothing. The driver is closed
 * by `dispose()` — and ONLY when this helper owns it, since an injected driver
 * belongs to the caller. Leaving an owned sqlite handle open keeps the kernel file
 * locked and fails Windows cleanup.
 *
 * @param {string} projectRoot
 * @param {Function} runFile - execFileSync-compatible function (repo probe)
 * @param {object} opts - DI (`_closeLinkedIssue`, `_kernelDriver`, `_runIssueOperation`)
 * @returns {{ close: Function, dispose: Function }}
 */
function createIssueCloser(projectRoot, runFile, opts) {
  const injected = opts._closeLinkedIssue;
  let built = null;
  const unavailable = { driver: null, run: null, owned: false };

  async function resolveDeps() {
    if (built) return built;
    if (opts._kernelDriver && opts._runIssueOperation) {
      built = { driver: opts._kernelDriver, run: opts._runIssueOperation, owned: false };
      return built;
    }
    // Only reach for the kernel inside a REAL git repo. buildMigratedKernelIssueDeps
    // CREATES the store at <git-common-dir>/forge/kernel.sqlite, so probing first is
    // what stops a clean run pointed at a non-repo path from minting a stray kernel
    // there. An empty result (rev-parse failed) means "not a repo".
    if (!tryRun(runFile, 'git', ['-C', projectRoot, 'rev-parse', '--git-common-dir'])) {
      built = unavailable;
      return built;
    }
    try {
      const { buildMigratedKernelIssueDeps } = require('../kernel/cli-broker-factory');
      const { runIssueOperation } = require('../forge-issues');
      const { kernelDriver, kernelBroker } = await buildMigratedKernelIssueDeps({ projectRoot });
      // Thread the broker through so every op reuses THIS driver instead of opening
      // a fresh kernel handle per call.
      built = {
        driver: kernelDriver,
        run: (operation, args, root) => runIssueOperation(operation, args, root, { kernelBroker }),
        owned: true,
      };
    } catch (_e) { /* intentional: no kernel → close nothing, clean normally */ // NOSONAR S2486
      built = unavailable;
    }
    return built;
  }

  return {
    async close(branch, pr) {
      try {
        if (injected) return await injected({ branch, pr, projectRoot });
        const { driver, run } = await resolveDeps();
        if (!driver || !run) return { closed: false, reason: 'unavailable' };
        const { closeLinkedIssueOnMerge } = require('../kernel/close-on-merge');
        return await closeLinkedIssueOnMerge({ branch, projectRoot, pr, driver, runIssueOperation: run });
      } catch (error) {
        // Best-effort: cleanup must never fail because tracking did.
        return { closed: false, reason: 'error', error: error && error.message };
      }
    },
    dispose() {
      if (built && built.owned && built.driver && typeof built.driver.close === 'function') {
        try { built.driver.close(); } catch (_e) { /* best-effort */ } // NOSONAR S2486
      }
    },
  };
}

async function reconcileDeadClaims(projectRoot, runFile, opts = {}) {
  try {
    if (typeof opts._reconcileClaims === 'function') {
      return await opts._reconcileClaims({ projectRoot });
    }

    let driver = opts._kernelDriver;
    let owned = false;
    if (!driver) {
      const commonDirOutput = tryRun(runFile, 'git', ['-C', projectRoot, 'rev-parse', '--git-common-dir']);
      if (!commonDirOutput) {
        return { examined: 0, released: [] };
      }
      const gitCommonDir = path.isAbsolute(commonDirOutput)
        ? commonDirOutput
        : path.resolve(projectRoot, commonDirOutput);
      const {
        buildMigratedKernelIssueDeps,
        resolveKernelDatabasePath,
      } = require('../kernel/cli-broker-factory');
      const databasePath = resolveKernelDatabasePath({ gitCommonDir });
      const fsApi = opts._fs || fs;
      if (!fsApi.existsSync(databasePath)) return { examined: 0, released: [] };
      const deps = await buildMigratedKernelIssueDeps({ projectRoot, gitCommonDir, databasePath });
      driver = deps.kernelDriver;
      owned = true;
    }
    if (!driver) return { examined: 0, released: [] };

    try {
      const { reconcileKernelClaims } = require('../kernel/claim-reconciler');
      return await reconcileKernelClaims({
        driver,
        fsApi: opts._fs || fs,
        manifestDir: opts._manifestDir,
        isProcessAlive: opts._isProcessAlive,
        getProcessIdentity: opts._getProcessIdentity,
      });
    } finally {
      if (owned && typeof driver.close === 'function') driver.close();
    }
  } catch (_e) { /* best-effort: unverifiable authority never aborts clean */ // NOSONAR S2486
    return { examined: 0, released: [] };
  }
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
 * @param {{close: Function}|null} [closer] - Close-on-merge bridge (null in dry-run)
 * @returns {Promise<{ cleaned: number, active: number, survivors: object[], dirty: string[], closedIssues: object[] }>}
 */
async function cleanWorktrees(worktreesDir, runFile, fsApi, dryRun, opts, closer = null) {
  const acc = { cleaned: 0, active: 0, survivors: [], dirty: [], closedIssues: [] };
  if (!fsApi.existsSync(worktreesDir)) return acc;

  const entries = fsApi.readdirSync(worktreesDir, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  if (dirs.length === 0) return acc;

  // Detection context: ancestry list + gh merged refs + squash fallback.
  const defaultBranch = getDefaultBranch(runFile);
  let mergedBranches = [];
  const mergedOut = tryRun(runFile, 'git', ['branch', '--merged', defaultBranch]);
  if (mergedOut) {
    // Strip the current-branch `*` and the linked-worktree `+` prefixes that
    // `git branch --merged` emits, so worktree-checked-out branches still hit the
    // ancestry fast path instead of falling through to the slower squash tier.
    mergedBranches = mergedOut.split('\n').map(b => b.trim().replace(/^[*+]\s*/, '')).filter(Boolean);
  }
  const ghMergedPrs = getGhMergedPrs(runFile);
  const ctx = { defaultBranch, mergedBranches, ghMergedPrs, runFile };
  const isMergedFn = opts._isMerged || (branch => detectMerged(branch, ctx));

  const listOutput = tryRun(runFile, 'git', ['worktree', 'list', '--porcelain']);
  const worktreeMap = listOutput ? parseWorktreeList(listOutput) : new Map();

  for (const dir of dirs) {
    const res = await cleanWorktree(dir, worktreeMap, isMergedFn, worktreesDir, dryRun, runFile, fsApi, opts);
    if (res.status === 'cleaned') acc.cleaned++;
    else if (res.status === 'survivor') acc.survivors.push(res);
    else if (res.status === 'dirty') acc.dirty.push(res.path);
    else acc.active++;

    // Close only what THIS outcome authorized (18f1988e, tightened by c5ab529e):
    // `closeIssue` is set by cleanWorktree alongside the removal decision, so a
    // worktree held back for any reason cannot have its issue closed.
    if (closer && res.branch && res.closeIssue) {
      const outcome = await closer.close(res.branch, prEvidenceFor(ghMergedPrs, res.branch));
      if (outcome && outcome.closed) {
        acc.closedIssues.push({ branch: res.branch, issueId: outcome.issueId });
      }
    }
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
  // A dry run detects merges but must not mutate the kernel, so it gets no closer.
  const closer = dryRun ? null : createIssueCloser(projectRoot, runFile, opts);
  let scan;
  try {
    scan = await cleanWorktrees(worktreesDir, runFile, fsApi, dryRun, opts, closer);
  } finally {
    if (closer) closer.dispose();
  }
  const { cleaned, active, survivors, dirty, closedIssues } = scan;

  // Claim repair is an explicit clean-lifecycle maintenance action. Run after
  // worktree removal so a newly-missing linked checkout can be observed, while
  // dry-run remains mutation-free. Evidence gaps and Kernel failures fail closed.
  if (!dryRun) await reconcileDeadClaims(projectRoot, runFile, opts);

  // Post-merge master auto-update (default-on; skipped in dry-run).
  let masterSync = null;
  if (masterSyncEnabled && !dryRun) {
    const doSync = opts._syncMaster || (() => syncMasterBranch(runFile, fsApi, opts));
    masterSync = await doSync();
  }

  return finalize({ success: true, cleaned, active, dryRun, survivors, dirty, closedIssues }, masterSync);
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
    normalizeWorktreeKey,
    parseWorktreeList,
    parseMainWorktree,
    getGhMergedPrs,
    prEvidenceFor,
    createIssueCloser,
    reconcileDeadClaims,
    isSquashMerged,
    hasMergedPrEvidence,
    isUnstartedBranch,
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
