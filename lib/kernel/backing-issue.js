'use strict';

/**
 * Auto Kernel Tracking — foundational primitive.
 *
 * `ensureBackingIssue()` guarantees that a unit of work (a branch/worktree) has a
 * backing Kernel issue, WITHOUT anyone remembering to run `forge issue create`.
 * It is the reusable core of the auto-tracking design
 * (docs/work/2026-07-06-auto-kernel-tracking/design.md, kernel issue 67ab465b /
 * PR1 131ab014); PR2/PR3 wire it into `forge worktree`, `forge push`, and the
 * lefthook pre-push, but this module is deliberately side-effect-free beyond the
 * injected kernel and never wires itself in.
 *
 * Contract (all guarantees are covered by test/kernel/backing-issue.test.js):
 *   - Idempotent + deduped BY BRANCH: if the branch already resolves to an issue
 *     (via the kernel_worktrees linkage row, or an issue id encoded in the branch
 *     name), that issue is returned/linked — never a duplicate.
 *   - Auto-creates a good-enough stub otherwise: title derived from the branch,
 *     body noting it was auto-created, labelled `auto-stub`. Then links the branch.
 *   - Skips work it should not track: main/master, detached HEAD (no branch), and
 *     ignore-glob branches (tmp/spike/wip/throwaway). Returns null, creates nothing.
 *   - Degrades gracefully: a missing/limited kernel, a non-kernel backend, or any
 *     thrown error yields null (never throws) — so it is safe to call from a hook.
 *   - Fully injectable: pass the kernel `driver` + `broker` (or a fake with the
 *     same method surface), plus an optional clock (`now`) and id source
 *     (`generateId`), so it is unit-testable without a real repo or sqlite DB.
 *
 * Storage choice: the branch->issue link lives in the `kernel_worktrees` row
 * (`issue_id`, keyed by worktree `path`, with `branch` recorded) — the existing
 * "the issue this branch serves" linkage cited by the design. No new table.
 *
 * @module kernel/backing-issue
 */

const { randomUUID } = require('node:crypto');

const DEFAULT_PROTECTED_BRANCHES = Object.freeze(['main', 'master']);
const DEFAULT_IGNORE_GLOBS = Object.freeze(['tmp/*', 'spike/*', 'wip/*', 'throwaway/*']);
const AUTO_STUB_LABEL = 'auto-stub';
// Branch prefixes stripped before deriving a title / probing for an encoded issue id.
const BRANCH_PREFIX = /^(feat|feature|fix|bugfix|hotfix|chore|refactor|docs|test|spike|wip)\//i;
// An issue key encoded in a branch slug, e.g. `feat/kap-7-foo` -> `kap-7`.
const ENCODED_ISSUE_ID = /^([a-z][a-z0-9]*-\d+)\b/i;
// Regex metacharacters escaped when compiling an ignore glob.
const GLOB_METACHARS = '.+^${}()|[]\\';

/**
 * Resolve the injected kernel driver/broker from a variety of accepted shapes, so
 * a caller can pass `{ driver, broker }`, the real `{ kernelDriver, kernelBroker }`
 * from buildMigratedKernelIssueDeps(), or `{ kernel: <either> }`.
 *
 * @param {object} options
 * @returns {{ driver: object|null, broker: object|null }}
 */
function resolveKernel(options) {
  const kernel = options.kernel || {};
  const driver = options.driver || options.kernelDriver || kernel.driver || kernel.kernelDriver || null;
  const broker = options.broker || options.kernelBroker || kernel.broker || kernel.kernelBroker || null;
  return { driver, broker };
}

/**
 * @param {object} driver
 * @returns {boolean} whether the driver exposes the worktree-linkage surface used here.
 */
function driverIsUsable(driver) {
  return Boolean(
    driver
    && typeof driver.registerWorktree === 'function'
    && (typeof driver.getWorktreeLinkage === 'function' || typeof driver.listWorktrees === 'function'),
  );
}

/** @param {object} broker @returns {boolean} whether the broker can create issues. */
function brokerIsUsable(broker) {
  return Boolean(broker && typeof broker.runIssueOperation === 'function');
}

/** @param {string} glob @returns {RegExp} anchored regex; `*` = one segment, `**` = any. */
function globToRegExp(glob) {
  const source = String(glob);
  let pattern = '';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === '*') {
      if (source[i + 1] === '*') {
        pattern += '.*';
        i += 1;
      } else {
        pattern += '[^/]*';
      }
    } else if (GLOB_METACHARS.includes(char)) {
      pattern += `\\${char}`;
    } else {
      pattern += char;
    }
  }
  return new RegExp(`^${pattern}$`);
}

/**
 * @param {string} branch
 * @param {string[]} globs
 * @returns {boolean} whether the branch matches any ignore glob.
 */
function matchesIgnoreGlob(branch, globs) {
  return globs.some(glob => globToRegExp(glob).test(branch));
}

/**
 * Decide whether the branch is a trackable unit of work.
 *
 * @param {string} branch
 * @param {{ protectedBranches: string[], ignoreGlobs: string[] }} config
 * @returns {{ skip: boolean, reason?: string }}
 */
function classifyBranch(branch, { protectedBranches, ignoreGlobs }) {
  if (!branch || typeof branch !== 'string' || branch === 'HEAD') {
    return { skip: true, reason: 'detached HEAD / no branch' };
  }
  if (protectedBranches.includes(branch)) {
    return { skip: true, reason: `protected branch (${branch})` };
  }
  if (matchesIgnoreGlob(branch, ignoreGlobs)) {
    return { skip: true, reason: `ignore-glob branch (${branch})` };
  }
  return { skip: false };
}

/** @param {string} branch @returns {string} branch slug with any known prefix removed. */
function stripPrefix(branch) {
  return branch.replace(BRANCH_PREFIX, '');
}

/**
 * Derive a human-ish issue title from a branch name.
 *
 * @param {string} branch
 * @returns {string}
 */
function deriveTitle(branch) {
  const slug = stripPrefix(branch).replace(/[-_/]+/g, ' ').trim();
  if (!slug) return branch;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

/**
 * Extract an issue id encoded in the branch name (e.g. `feat/kap-7-foo` -> `kap-7`).
 *
 * @param {string} branch
 * @returns {string|null}
 */
function extractEncodedIssueId(branch) {
  const match = ENCODED_ISSUE_ID.exec(stripPrefix(branch));
  return match ? match[1] : null;
}

/**
 * Find an existing branch->issue linkage row (with a non-null issue_id). Prefers the
 * path-keyed row; falls back to scanning by branch. Best-effort — returns null on any error.
 *
 * @param {object} driver
 * @param {{ worktreePath?: string, branch: string }} query
 * @returns {object|null} the linkage row, or null.
 */
function findExistingLink(driver, { worktreePath, branch }) {
  try {
    if (worktreePath && typeof driver.getWorktreeLinkage === 'function') {
      const row = driver.getWorktreeLinkage({ path: worktreePath });
      if (row && row.issue_id && row.branch === branch) return row;
    }
    if (typeof driver.listWorktrees === 'function') {
      const rows = driver.listWorktrees() || [];
      // Match ACTIVE (live) rows only: a superseded/stale registration for a
      // reused branch name must not be treated as the existing link (be18881c —
      // the third resolver, kept consistent with resolveActiveIssueId and
      // currentBranchIssueFromDriver). Tolerate a null state for legacy rows.
      const match = rows.find(row => row && row.branch === branch && row.issue_id
        && (row.state === 'active' || row.state == null));
      if (match) return match;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Persist the branch->issue link into the kernel_worktrees registry.
 *
 * @param {object} driver
 * @param {object} params
 * @returns {object|null} the upserted row, or null on error.
 */
function linkBranchToIssue(driver, { projectRoot, worktreePath, gitCommonDir, branch, issueId, actor, now }) {
  try {
    return driver.registerWorktree({
      git_common_dir: gitCommonDir || projectRoot || 'unknown',
      path: worktreePath || projectRoot,
      branch,
      actor: actor || null,
      issue_id: issueId,
      work_folder: null,
      registered_at: now().toISOString(),
      state: 'active',
    });
  } catch {
    return null;
  }
}

/**
 * Ensure the given branch has a backing Kernel issue. Idempotent, deduped by branch,
 * best-effort (never throws). See the module doc for the full contract.
 *
 * @param {object} options
 * @param {string} options.branch - Current branch (falsy or 'HEAD' => detached => skip).
 * @param {string} [options.projectRoot] - Repo root; default worktree path / git-common-dir fallback.
 * @param {string} [options.worktreePath] - Absolute worktree path (linkage row key). Defaults to projectRoot.
 * @param {string} [options.gitCommonDir] - Git common dir for the linkage row.
 * @param {object} [options.driver] - Kernel driver (real or fake). Also accepts kernelDriver / kernel.*.
 * @param {object} [options.broker] - Kernel broker (real or fake). Also accepts kernelBroker / kernel.*.
 * @param {string} [options.actor] - Actor recorded on the issue/linkage. Default FORGE_ACTOR or 'forge'.
 * @param {string[]} [options.protectedBranches] - Never-track branches. Default ['main','master'].
 * @param {string[]} [options.ignoreGlobs] - Never-track globs. Default tmp/spike/wip/throwaway.
 * @param {() => Date} [options.now] - Clock injection. Default () => new Date().
 * @param {() => string} [options.generateId] - Issue id source. Default randomUUID.
 * @returns {Promise<{issueId: string, branch: string, created: boolean, existed: boolean, linked?: boolean, label?: string}|null>}
 *   The backing issue descriptor, or null when the branch is skipped or the kernel is unavailable.
 */
async function ensureBackingIssue(options = {}) {
  try {
    const {
      branch,
      projectRoot,
      worktreePath,
      gitCommonDir,
      actor = process.env.FORGE_ACTOR || 'forge',
      protectedBranches = DEFAULT_PROTECTED_BRANCHES,
      ignoreGlobs = DEFAULT_IGNORE_GLOBS,
      now = () => new Date(),
      generateId = randomUUID,
    } = options;

    // 1. Only track real units of work.
    const classification = classifyBranch(branch, { protectedBranches, ignoreGlobs });
    if (classification.skip) return null;

    // 2. Kernel must be present + usable, else degrade (non-kernel backend / offline).
    const { driver, broker } = resolveKernel(options);
    if (!driverIsUsable(driver) || !brokerIsUsable(broker)) return null;

    const linkParams = { projectRoot, worktreePath, gitCommonDir, branch, actor, now };

    // 3. Idempotency: an existing branch->issue link wins (the common, cheap case).
    const existing = findExistingLink(driver, { worktreePath, branch });
    if (existing) {
      return { issueId: existing.issue_id, branch, created: false, existed: true };
    }

    // 4. Dedupe: if the branch encodes an existing issue id, link that instead of
    //    minting a stub.
    const encodedId = extractEncodedIssueId(branch);
    if (encodedId && typeof driver.loadKernelEntity === 'function') {
      let entity = null;
      try {
        entity = await driver.loadKernelEntity('issue', encodedId);
      } catch {
        entity = null;
      }
      if (entity) {
        // Report link persistence honestly: if registerWorktree failed (returns null),
        // linked:false surfaces that the branch->issue link did NOT persist, so the
        // idempotency guarantee is degraded (a later call may re-create) rather than
        // silently claiming success. Callers/hooks can warn on linked:false.
        const linked = linkBranchToIssue(driver, { ...linkParams, issueId: encodedId });
        return { issueId: encodedId, branch, created: false, existed: true, linked: linked !== null };
      }
    }

    // 5. Create a good-enough stub, then link the branch to it.
    const issueId = generateId();
    const title = deriveTitle(branch);
    const body = `Auto-created stub for branch ${branch} — enrich with design/acceptance.`;
    const createResult = await broker.runIssueOperation(
      'create',
      ['--id', issueId, '--title', title, '--body', body, '--label', AUTO_STUB_LABEL, '--type', 'task', '--status', 'open'],
      { actor, origin: 'forge-autotrack', idempotencyKey: `issue.create:${issueId}` },
    );
    if (createResult && createResult.ok === false) return null;

    const linked = linkBranchToIssue(driver, { ...linkParams, issueId });
    return { issueId, branch, created: true, existed: false, linked: linked !== null, label: AUTO_STUB_LABEL };
  } catch {
    // Best-effort: a hook must never be broken by tracking. Degrade to null.
    return null;
  }
}

module.exports = {
  ensureBackingIssue,
  // Exported for focused unit tests / reuse by PR2-PR4 surfaces.
  classifyBranch,
  deriveTitle,
  extractEncodedIssueId,
  findExistingLink,
  matchesIgnoreGlob,
  DEFAULT_PROTECTED_BRANCHES,
  DEFAULT_IGNORE_GLOBS,
  AUTO_STUB_LABEL,
};
