'use strict';

/**
 * PR-monitor gather — turn ONE `gatherPrSnapshot` read (the SAME shared read the
 * `--pull` verdict uses) into the normalized snapshot the differ compares. Because
 * the verdict and the monitor events both derive from this one read, they can
 * never disagree (the frame in docs/work/2026-07-13-pr-monitor/plan.md).
 *
 * The normalized snapshot is the diff subject:
 *   { repo, pr, headSha, prState, draft, verdict:{state,reason},
 *     checks:[{name,class}], threads:[{threadId,isResolved,isOutdated,commentCount,actionable,path}],
 *     reviews:[{author,state,commitOid,submittedAt}], comments:[{id,author}],
 *     behind, conflicts:(true|false|null), degraded:[{surface,error}] }
 *
 * @module pr-monitor/gather
 */

const { gatherPrSnapshot } = require('../pr-pull');
const { isFailed, isGreen } = require('../pr-shepherd');

/** green | failed | pending — reuses the SAME predicates as the verdict core. */
function classifyCheck(check) {
  if (isFailed(check)) return 'failed';
  if (isGreen(check)) return 'green';
  return 'pending';
}

function normalizeChecks(checks) {
  return (Array.isArray(checks) ? checks : []).map((c) => ({
    name: c.name || '',
    class: classifyCheck(c),
  }));
}

function normalizeThreads(threads) {
  return (Array.isArray(threads) ? threads : []).map((t) => ({
    threadId: t.threadId || '',
    isResolved: Boolean(t.isResolved),
    isOutdated: Boolean(t.isOutdated),
    commentCount: Array.isArray(t.comments) ? t.comments.length : 0,
    actionable: !t.isResolved && !t.isOutdated,
    path: t.path || null,
  }));
}

function normalizeReviews(reviews) {
  return (Array.isArray(reviews) ? reviews : []).map((r) => ({
    author: r.author || '',
    state: r.state || '',
    commitOid: r.commitOid || null,
    submittedAt: r.submittedAt || null,
  }));
}

function normalizeComments(comments) {
  return (Array.isArray(comments) ? comments : []).map((c) => ({
    id: c.id || `${c.author || ''}:${c.createdAt || ''}`,
    author: c.author || '',
  }));
}

function normalizeDegraded(degraded) {
  return (Array.isArray(degraded) ? degraded : []).map((d) => ({
    surface: d.source || d.surface || 'unknown',
    error: d.error || '',
  }));
}

/**
 * Conflict prediction → tri-state boolean: `true`/`false` when supported,
 * `null` when unknown (unsupported git, unreadable ref) so the differ never
 * emits a false conflict.appeared/cleared on missing data.
 */
function conflictBool(conflicts) {
  if (conflicts && conflicts.supported === true) return Boolean(conflicts.conflicted);
  return null;
}

/**
 * Normalize a raw `gatherPrSnapshot` result into the monitor diff subject.
 *
 * @param {object} snap - gatherPrSnapshot result.
 * @param {{ repo: string, pr: string|number }} ctx
 * @returns {object}
 */
function normalizeSnapshot(snap, ctx) {
  const state = snap.state || {};
  return {
    repo: ctx.repo,
    pr: String(ctx.pr),
    headSha: state.headSha || '',
    prState: String(state.state || 'OPEN').toUpperCase(),
    draft: Boolean(snap.draft),
    verdict: { state: snap.verdict || 'UNKNOWN', reason: null },
    checks: normalizeChecks(state.checks),
    threads: normalizeThreads(snap.threads),
    reviews: normalizeReviews(snap.reviews),
    comments: normalizeComments(snap.issueComments),
    behind: snap.behind || 0,
    conflicts: conflictBool(snap.conflicts),
    degraded: normalizeDegraded(snap.degraded),
  };
}

/**
 * Gather + normalize the monitor snapshot for a PR. `ctx.gatherSnapshot` is
 * injectable for tests; production uses the shared `gatherPrSnapshot`.
 *
 * @param {object} ctx - the same ctx shape gatherPrSnapshot takes (pr, owner,
 *   repo, base, baseRef, cwd, self, adapter, now, settleWindowMs).
 * @returns {Promise<object>} normalized snapshot.
 */
async function gatherMonitorSnapshot(ctx) {
  const gather = ctx.gatherSnapshot || gatherPrSnapshot;
  const snap = await gather(ctx);
  return normalizeSnapshot(snap, ctx);
}

module.exports = {
  gatherMonitorSnapshot,
  normalizeSnapshot,
  classifyCheck,
  conflictBool,
};
