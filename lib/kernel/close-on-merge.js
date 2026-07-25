'use strict';

/**
 * Close-on-merge linkage (kernel issue 18f1988e).
 *
 * The branch->issue linkage backbone shipped (kernel_worktrees rows written by
 * `forge worktree create` and the auto-file rail), but nothing ever consumed it:
 * a merged PR closed no kernel issue, so finished work stayed open forever. A
 * hygiene sweep on 2026-07-25 closed 104 such issues, 61 of them auto-stubs
 * minted on branch push whose merged PR closed nothing.
 *
 * This module is the consumer. Given a branch whose PR is known to be MERGED, it
 * comments the merge evidence onto the linked kernel issue and closes it.
 *
 * Safety properties (each covered by test/kernel/close-on-merge.test.js):
 *   - LINKED ONLY. The issue comes from the kernel_worktrees linkage registry via
 *     resolveActiveIssueId — the same authoritative resolver `forge ship` stage
 *     state uses. An issue is never guessed from the branch/PR title, so a merge
 *     can only ever close the issue the branch was actually bound to.
 *   - IDEMPOTENT. The issue's status is read back first; a terminal issue
 *     (`done` / `cancelled` — the kernel's real terminal vocabulary) is a pure
 *     no-op that writes neither a comment nor a close. Running clean twice
 *     closes once.
 *   - NEVER CLOSES BLIND. An unreadable status is a skip, not an assumption.
 *   - BEST EFFORT. Every failure path — no kernel, a throwing driver, a rejected
 *     mutation — resolves to `{ closed: false, reason }`. Nothing throws, so
 *     `forge clean` still removes worktrees when tracking is broken.
 *
 * Writes go through the supported `runIssueOperation` seam (lib/forge-issues.js),
 * the same path `forge inbox ack` uses, so kernel events/provenance are recorded
 * exactly as a hand-run `forge comment` / `forge close` would be.
 *
 * @module kernel/close-on-merge
 */

const { resolveActiveIssueId } = require('../workflow/enforce-stage');
const { isWorkableStatus } = require('./readiness-model');

/**
 * Render the merge-evidence comment posted onto the issue before it is closed.
 * Stays honest when the PR could not be resolved: `forge clean` also detects a
 * merge by git patch-equivalence, with no GitHub data to cite.
 *
 * @param {object} params
 * @param {string} params.branch - Merged branch name
 * @param {{number: number, title?: string, mergeCommitOid?: string}|null} [params.pr]
 * @returns {string} Comment body
 */
function buildMergeEvidence({ branch, pr }) {
  const lines = ['Closed automatically: the branch backing this issue was merged.', '', `branch: ${branch}`];
  if (pr && pr.number) {
    lines.push(`pull request: #${pr.number}${pr.title ? ` — ${pr.title}` : ''}`);
    if (pr.mergeCommitOid) lines.push(`merge commit: ${pr.mergeCommitOid}`);
  } else {
    lines.push('pull request: no pull request resolved (merge detected from git history)');
  }
  return lines.join('\n');
}

/**
 * Render the `--reason` recorded on the close event.
 *
 * @param {object} params
 * @param {string} params.branch
 * @param {{number: number}|null} [params.pr]
 * @returns {string}
 */
function buildCloseReason({ branch, pr }) {
  return pr && pr.number ? `merged in PR #${pr.number}` : `branch ${branch} merged`;
}

/**
 * Read an issue's current status through the supported read path.
 *
 * @param {Function} runIssueOperation
 * @param {string} issueId
 * @param {string} projectRoot
 * @returns {Promise<string|null>} the status, or null when it could not be read.
 */
async function readIssueStatus(runIssueOperation, issueId, projectRoot) {
  const result = await runIssueOperation('show', [issueId, '--json'], projectRoot);
  if (!result || result.ok !== true || !result.data) return null;
  const status = result.data.status;
  return typeof status === 'string' && status ? status : null;
}

/** @returns {boolean} whether a mutation envelope reports success. */
function mutationSucceeded(result) {
  return Boolean(result && (result.ok === true || result.success === true));
}

/**
 * Comment the merge evidence onto the linked kernel issue and close it.
 * See the module doc for the full contract. NEVER throws.
 *
 * @param {object} options
 * @param {string} options.branch - The merged branch.
 * @param {string} [options.projectRoot] - Repo root threaded to the issue runner.
 * @param {{number: number, title?: string, mergeCommitOid?: string}|null} [options.pr]
 *   Merge evidence from GitHub, when available.
 * @param {object} options.driver - Kernel driver exposing the worktree linkage registry.
 * @param {Function} options.runIssueOperation - (operation, args, projectRoot) => envelope.
 * @param {Function} [options.resolveIssueId] - Override the branch->issue resolver (tests).
 * @returns {Promise<{closed: boolean, issueId?: string|null, reason?: string,
 *   commented?: boolean, status?: string, error?: string}>}
 */
async function closeLinkedIssueOnMerge(options = {}) {
  const { branch, projectRoot, pr = null, driver, runIssueOperation } = options;
  try {
    if (!branch || typeof branch !== 'string') return { closed: false, reason: 'no-branch' };
    if (!driver || typeof runIssueOperation !== 'function') {
      return { closed: false, reason: 'unavailable' };
    }

    // Linked only — never a title/heuristic match.
    const resolveIssueId = options.resolveIssueId || resolveActiveIssueId;
    const issueId = await resolveIssueId(driver, branch);
    if (!issueId) return { closed: false, reason: 'not-linked' };

    // Idempotency + never-close-blind: read the current status first.
    const status = await readIssueStatus(runIssueOperation, issueId, projectRoot);
    if (!status) return { closed: false, reason: 'read-failed', issueId };
    if (!isWorkableStatus(status)) {
      return { closed: false, reason: 'already-closed', issueId, status };
    }

    // Evidence first, so it survives even if the close is rejected.
    const commentResult = await runIssueOperation(
      'comment',
      [issueId, buildMergeEvidence({ branch, pr })],
      projectRoot,
    );
    const commented = mutationSucceeded(commentResult);

    const closeResult = await runIssueOperation(
      'close',
      [issueId, '--reason', buildCloseReason({ branch, pr })],
      projectRoot,
    );
    if (!mutationSucceeded(closeResult)) {
      return { closed: false, reason: 'close-failed', issueId, commented };
    }
    return { closed: true, issueId, commented };
  } catch (error) {
    // Best-effort: cleanup must never break on tracking.
    return { closed: false, reason: 'error', error: error && error.message };
  }
}

module.exports = {
  closeLinkedIssueOnMerge,
  buildMergeEvidence,
  buildCloseReason,
};
