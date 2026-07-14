/**
 * Shared lefthook / git-hook wiring for `forge setup` and `forge init`.
 *
 * Single source of truth for the hook-wiring primitives. The LIVE `forge setup` /
 * `forge init` path is the registry command in lib/commands/setup.js (it wins in the
 * dispatcher and returns before bin/forge.js's inline setup branch is ever reached; the
 * bin copy is LEGACY/DEAD — see the banner at bin/forge.js "LEGACY / DEAD SETUP PATH").
 * The mid-stage repair path (enforce-stage → repairRuntimeReadiness) also consumes these
 * primitives. Earlier the shadow-config fix landed only in one copy while `forge setup`
 * ran a stale copy, leaving a fresh `forge setup` with TDD enforcement SILENTLY INERT
 * (kernel e452422c / c713fce7 / 22e33dbf, beta blocker B3) — hence one shared module.
 *
 * Responsibilities:
 *   - Provide the REAL user-facing lefthook.yml (never lefthook's commented example).
 *   - Decide when it is safe to (over)write lefthook.yml (replace only a stub).
 *   - Install a native `.git/hooks` fallback when the lefthook binary is unavailable,
 *     so raw `git commit` / `git push` still enforce the TDD gate.
 *   - Verify honestly whether hooks are actually active, so setup can fail LOUDLY
 *     instead of no-op'ing.
 *
 * @module lib/lefthook-wiring
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// Sentinel embedded in every native hook Forge writes. Lets verifyHooksActive
// distinguish a Forge-managed hook from a lefthook-managed one or a user's own.
const FORGE_NATIVE_HOOK_SENTINEL = '# forge-native-git-hook (installed by `forge setup`)';

// The lefthook.yml Forge writes into a USER project. The repo's own dev lefthook.yml
// references repo-internal scripts (scripts/branch-protection.js, lint.js, test.js, …)
// that a user's project never has, so shipping it produced hooks that fail on the first
// commit. This minimal config references only what every Forge project gets: the
// self-contained TDD gate (.forge/hooks/check-tdd.js) on pre-commit, and the project's
// own test script (a no-op when absent) on pre-push. Both hooks exist, so the
// HOOKS_NOT_ACTIVE gate is satisfied and the workflow is reachable out of the box.
const FORGE_USER_LEFTHOOK_YML = `# Forge git hooks — installed by \`forge setup\` / \`forge init\`.
# pre-commit enforces the TDD gate; pre-push runs your test script if you have one.
# Edit freely to add your own checks — Forge only replaces a fully-commented stub.

pre-commit:
  commands:
    forge-tdd:
      run: node .forge/hooks/check-tdd.js

pre-push:
  commands:
    tests:
      run: npm test --if-present
`;

/**
 * A fresh `lefthook install` (run by lefthook's own npm postinstall) drops a stock
 * EXAMPLE lefthook.yml with every hook commented out. That disposable stub used to
 * block Forge from writing its config, leaving pre-commit/pre-push unwired so every
 * stage command dead-ended on HOOKS_NOT_ACTIVE right after `forge init` (kernel
 * c713fce7). Overwrite a missing file or such a stub, but never clobber a lefthook.yml
 * that already has active (uncommented) jobs — a user's real config, or Forge's own
 * once written.
 *
 * @param {string} lefthookTarget - Absolute path to the candidate lefthook.yml.
 * @returns {boolean} true when Forge should (over)write its config at that path.
 */
function forgeShouldWriteLefthookConfig(lefthookTarget) {
  let stat;
  try {
    stat = fs.lstatSync(lefthookTarget);
  } catch (error) {
    if (error && error.code !== 'ENOENT') {
      throw error;
    }
    return true; // no existing file → write Forge's config
  }
  // Never write THROUGH a symlink (or any non-regular file): a checked-out lefthook.yml
  // pointing outside projectRoot could otherwise be created/overwritten via the
  // follow-through of readFileSync/writeFileSync. Only regular files are safe.
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return false;
  }
  const content = fs.readFileSync(lefthookTarget, 'utf8');
  const activeLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  return activeLines.length === 0;
}

/**
 * Resolve the directory git ACTUALLY reads hooks from for a given project root.
 *
 * Asks git first (`git rev-parse --git-path hooks`), which is authoritative: it
 * honors `core.hooksPath` (husky, a global config, etc.), so verify checks — and the
 * native installer writes to — the directory git will really execute. Without this a
 * project with `core.hooksPath` set would get hooks written to `.git/hooks` that git
 * never runs, and verify would falsely report ACTIVE (a silent-inert false pass, B3).
 *
 * Falls back to a pure-filesystem resolution when git is unavailable or the path is not
 * a git repo — keeps the function testable against synthetic `.git` layouts:
 *   - Normal repo: `.git` is a directory → `<root>/.git/hooks`.
 *   - Linked worktree: `.git` is a file `gitdir: <path>`; hooks live in the common git
 *     dir (resolved via the worktree's `commondir` file) → `<common>/hooks`.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {string|null} Absolute hooks dir, or null when not a git repo.
 */
function resolveGitHooksDir(projectRoot) {
  return resolveHooksDirViaGit(projectRoot) || resolveGitHooksDirFromFs(projectRoot);
}

// Authoritative resolution via git (honors core.hooksPath). One fast spawn; returns
// null on any failure (git missing, not a repo) so the filesystem fallback can run.
function resolveHooksDirViaGit(projectRoot) {
  try {
    const out = execFileSync(
      'git',
      ['-C', projectRoot, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

// Pure-filesystem fallback (no git spawn). Does NOT see core.hooksPath — only used when
// git could not answer.
function resolveGitHooksDirFromFs(projectRoot) {
  const gitPath = path.join(projectRoot, '.git');
  let stat;
  try {
    stat = fs.lstatSync(gitPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    return path.join(gitPath, 'hooks');
  }
  if (stat.isFile()) {
    return resolveWorktreeHooksDir(gitPath, projectRoot);
  }
  return null;
}

// A linked worktree's `.git` is a file containing `gitdir: <path>`. Its hooks live in
// the common repo's hooks dir (resolved via the worktree's `commondir` file). Returns
// null when the pointer file is unreadable or malformed.
function resolveWorktreeHooksDir(gitFile, projectRoot) {
  let content;
  try {
    content = fs.readFileSync(gitFile, 'utf8');
  } catch {
    return null;
  }
  const match = content.match(/gitdir:\s*(.+)/);
  if (!match) return null;
  const rawGitdir = match[1].trim();
  const gitdir = path.isAbsolute(rawGitdir) ? rawGitdir : path.resolve(projectRoot, rawGitdir);
  return path.join(resolveWorktreeCommonDir(gitdir), 'hooks');
}

// Follow the worktree's `commondir` pointer to the common git dir; fall back to the
// per-worktree gitdir when it is absent or unreadable.
function resolveWorktreeCommonDir(gitdir) {
  const commonDirFile = path.join(gitdir, 'commondir');
  try {
    if (fs.existsSync(commonDirFile)) {
      const rel = fs.readFileSync(commonDirFile, 'utf8').trim();
      return path.isAbsolute(rel) ? rel : path.resolve(gitdir, rel);
    }
  } catch {
    // fall through to the per-worktree gitdir
  }
  return gitdir;
}

const NATIVE_HOOK_BODIES = {
  'pre-commit': `#!/bin/sh
${FORGE_NATIVE_HOOK_SENTINEL}
# Fallback TDD gate used when the lefthook binary is unavailable. Enforces the same
# check as the lefthook pre-commit job. Remove this file only if you install lefthook.
if [ -f ".forge/hooks/check-tdd.js" ]; then
  node ".forge/hooks/check-tdd.js" || exit 1
fi
`,
  'pre-push': `#!/bin/sh
${FORGE_NATIVE_HOOK_SENTINEL}
# Fallback pre-push gate used when the lefthook binary is unavailable. Runs your test
# script before pushing (a no-op when the project has none).
npm test --if-present || exit 1
`,
};

/**
 * Install native `.git/hooks` pre-commit/pre-push scripts that invoke Forge's own
 * TDD gate. This is the fallback that keeps enforcement live when the lefthook binary
 * cannot be installed (e.g. a fresh consumer repo with no package.json), so `git
 * commit` / `git push` are never silently unguarded.
 *
 * A pre-existing hook that is neither Forge-managed nor lefthook-managed is preserved:
 * it is backed up to `<hook>.forge-backup` (once) and left in place (reported in
 * `skipped`) rather than destroyed.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {{ installed: boolean, method?: string, hooksDir?: string,
 *   written?: string[], skipped?: string[], reason?: string }}
 */
function installNativeGitHooks(projectRoot) {
  const hooksDir = resolveGitHooksDir(projectRoot);
  if (!hooksDir) {
    return { installed: false, reason: 'not-a-git-repo' };
  }
  try {
    fs.mkdirSync(hooksDir, { recursive: true });
  } catch (error) {
    return { installed: false, reason: `hooks-dir-unwritable: ${error.message}` };
  }

  const written = [];
  const skipped = [];
  for (const [name, body] of Object.entries(NATIVE_HOOK_BODIES)) {
    const outcome = writeNativeHook(path.join(hooksDir, name), body);
    (outcome === 'written' ? written : skipped).push(name);
  }

  return {
    installed: written.length > 0,
    method: 'native',
    hooksDir,
    written,
    skipped,
  };
}

// Write a single native hook, preserving a pre-existing non-Forge/non-lefthook hook
// (backed up once, left in place). Returns 'written' or 'skipped'.
function writeNativeHook(dest, body) {
  if (shouldPreserveExistingHook(dest)) {
    backupHookOnce(dest);
    return 'skipped';
  }
  fs.writeFileSync(dest, body, 'utf8');
  try {
    fs.chmodSync(dest, 0o755); // NOSONAR — hooks must be executable
  } catch {
    // Windows filesystems ignore the mode bits — non-fatal.
  }
  return 'written';
}

// A hook is ours to overwrite when it is missing, Forge-managed, or lefthook-managed.
// Anything else is the user's / a third party's and must be preserved.
function shouldPreserveExistingHook(dest) {
  if (!fs.existsSync(dest)) return false;
  let existing;
  try {
    existing = fs.readFileSync(dest, 'utf8');
  } catch {
    existing = '';
  }
  return !existing.includes(FORGE_NATIVE_HOOK_SENTINEL) && !existing.includes('lefthook');
}

// Back up a hook to `<hook>.forge-backup` once (never clobber an existing backup).
function backupHookOnce(dest) {
  const backup = `${dest}.forge-backup`;
  try {
    if (!fs.existsSync(backup)) fs.copyFileSync(dest, backup);
  } catch {
    // Best-effort backup; the caller still refuses to overwrite the original.
  }
}

/**
 * Report — honestly — whether git hooks are actually active for the project, so
 * `forge setup` can fail LOUDLY instead of silently no-op'ing. A hook counts as
 * active only when a `pre-commit` hook exists AND is either lefthook-managed or
 * carries Forge's native sentinel.
 *
 * @param {string} projectRoot - Absolute path to the project root.
 * @returns {{ active: boolean, method: 'lefthook'|'native'|'none'|'unknown', reason?: string, hook?: string }}
 */
function verifyHooksActive(projectRoot) {
  const hooksDir = resolveGitHooksDir(projectRoot);
  if (!hooksDir) {
    return { active: false, method: 'none', reason: 'not a git repository' };
  }
  const preCommit = path.join(hooksDir, 'pre-commit');
  if (!fs.existsSync(preCommit)) {
    return { active: false, method: 'none', reason: 'no pre-commit hook installed' };
  }
  let body;
  try {
    body = fs.readFileSync(preCommit, 'utf8');
  } catch (error) {
    return { active: false, method: 'unknown', reason: `pre-commit unreadable: ${error.message}` };
  }
  // Check the Forge native sentinel FIRST: our native hook body mentions "lefthook"
  // in a comment, so a substring test for lefthook would otherwise misclassify it.
  if (body.includes(FORGE_NATIVE_HOOK_SENTINEL)) {
    return { active: true, method: 'native', hook: preCommit };
  }
  if (body.includes('lefthook')) {
    return { active: true, method: 'lefthook', hook: preCommit };
  }
  return {
    active: false,
    method: 'unknown',
    reason: 'pre-commit hook present but not Forge- or lefthook-managed',
    hook: preCommit,
  };
}

module.exports = {
  FORGE_NATIVE_HOOK_SENTINEL,
  FORGE_USER_LEFTHOOK_YML,
  forgeShouldWriteLefthookConfig,
  resolveGitHooksDir,
  installNativeGitHooks,
  verifyHooksActive,
};
