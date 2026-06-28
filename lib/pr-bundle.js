'use strict';

/**
 * PR-state bundle — the "everything ready for the agent" gather half of the
 * monitor (kernel 9b24257f, increment 1).
 *
 * `gatherPrBundle` aggregates the COMPLETE, read-only state of an open PR into
 * one structured object a fixer-agent can act on WITHOUT fetching anything
 * itself: every unresolved review thread (any author), the merge state, the
 * full CI rollup (tagged with required-check membership), branch divergence, and
 * predicted merge conflicts.
 *
 * This module is pure aggregation over a validated pr-state adapter. It makes NO
 * decisions and takes NO actions — it never merges, never resolves threads,
 * never writes code. The decision state machine stays in lib/pr-shepherd.js; the
 * agent dispatch, the continuous loop, and close-on-merge that will consume this
 * bundle are follow-ups, not part of this increment.
 *
 * @module pr-bundle
 */

const { isGreen, isFailed } = require('./pr-shepherd');

/**
 * Map an unresolved review thread to the agent-input comment shape. Uses the
 * thread opener (first comment) for author/body and the thread-level
 * id/path/line, tolerating adapters/payloads that don't surface every field.
 *
 * @param {object} thread
 * @returns {{ author: string, path: string|null, line: number|null, body: string, threadId: string|null }}
 */
function toUnresolvedComment(thread) {
  const comments = Array.isArray(thread.comments) ? thread.comments : [];
  const first = comments[0] || {};
  const author = (first.author && first.author.login) || first.author || thread.author || '';
  return {
    author: String(author),
    path: thread.path || null,
    line: typeof thread.line === 'number' ? thread.line : null,
    body: String(first.body || thread.body || ''),
    threadId: thread.threadId || thread.id || null,
  };
}

/**
 * Read ALL unresolved review threads (any author) and map them to the agent
 * comment shape. `readComments` is optional on the adapter; a missing or failing
 * read yields `[]` rather than collapsing the whole bundle.
 */
async function gatherUnresolvedComments(adapter, { owner, repo, pr }) {
  if (typeof adapter.readComments !== 'function') return [];
  try {
    const threads = await adapter.readComments({ owner, repo, pr });
    return (Array.isArray(threads) ? threads : [])
      .filter((t) => !(t.isResolved || t.resolved))
      .map(toUnresolvedComment);
  } catch (_err) {
    // A failed comment read must not sink the rest of the bundle.
    return [];
  }
}

/**
 * Predict merge conflicts. `detectConflicts` is optional on the adapter; when
 * absent or failing, report it as unsupported rather than throwing.
 */
async function gatherConflicts(adapter, { baseRef, cwd }) {
  if (typeof adapter.detectConflicts !== 'function') {
    return { supported: false, reason: 'adapter has no detectConflicts capability' };
  }
  try {
    return await adapter.detectConflicts({ baseRef, cwd });
  } catch (error) {
    return { supported: false, reason: error.message || 'conflict detection failed' };
  }
}

/**
 * Tag the CI rollup with required-check membership and split out failing/pending.
 *
 * `requiredSet` is the branch-protection required set (array), or `null` when it
 * is unreadable — in which case `required` is left `null` per check rather than
 * `false`, so the agent is never told "nothing is required" on bad data.
 *
 * @param {object[]} checks - Normalized rollup from `readState`.
 * @param {string[]|null} requiredSet
 * @returns {{ checks: object[], failing: object[], pending: object[] }}
 */
function buildCi(checks, requiredSet) {
  const isRequired = (name) => (requiredSet === null ? null : requiredSet.includes(name));
  const tagged = (Array.isArray(checks) ? checks : []).map((c) => ({
    name: c.name || '',
    status: c.status || '',
    conclusion: c.conclusion || '',
    required: isRequired(c.name || ''),
    detailsUrl: c.detailsUrl || null,
  }));
  return {
    checks: tagged,
    failing: tagged.filter((c) => isFailed(c)),
    pending: tagged.filter((c) => !isGreen(c) && !isFailed(c)),
  };
}

/**
 * Gather the complete read-only PR-state bundle for the monitor's fixer-agent.
 *
 * @param {object} ctx
 * @param {string} ctx.pr
 * @param {string} ctx.owner
 * @param {string} ctx.repo
 * @param {string} ctx.base    - Base BRANCH name (for branch-protection lookup).
 * @param {string} ctx.baseRef - Base REF for divergence/conflicts (e.g. `origin/master`).
 * @param {string} [ctx.cwd]
 * @param {object} ctx.adapter - A validated pr-state adapter.
 * @returns {Promise<object>} the structured bundle.
 */
async function gatherPrBundle({ pr, owner, repo, base, baseRef, cwd, adapter }) {
  if (!adapter || typeof adapter.readState !== 'function') {
    throw new Error('gatherPrBundle requires a pr-state adapter with readState');
  }

  const state = await adapter.readState(pr);
  // NOTE: required-check lookup needs the base BRANCH name (`base`), not the
  // remote ref (`baseRef`); passing the ref builds a bad protection path and
  // silently yields a null required set.
  const requiredRaw = await adapter.readRequiredChecks({ owner, repo, base });
  const divergence = await adapter.readDivergence({ baseRef, cwd });
  const unresolvedComments = await gatherUnresolvedComments(adapter, { owner, repo, pr });
  const conflicts = await gatherConflicts(adapter, { baseRef, cwd });

  const requiredSet = requiredRaw === undefined ? null : requiredRaw;

  return {
    pr: String(pr),
    owner,
    repo,
    base,
    baseRef,
    unresolvedComments,
    mergeState: {
      mergeable: state.mergeable || 'UNKNOWN',
      mergeStateStatus: state.mergeStateStatus || 'UNKNOWN',
      state: String(state.state || 'OPEN').toUpperCase(),
    },
    ci: buildCi(state.checks, requiredSet),
    branch: {
      ahead: divergence.ahead || 0,
      behind: divergence.behind || 0,
    },
    conflicts,
  };
}

module.exports = {
  gatherPrBundle,
  buildCi,
  toUnresolvedComment,
};
