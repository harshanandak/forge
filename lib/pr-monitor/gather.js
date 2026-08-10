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
const { classifyReviewActor, normalizeEvidenceText } = require('../review-adapter');

const SNAPSHOT_LIMITS = Object.freeze({
  maxChecks: 100,
  maxThreads: 100,
  maxReviews: 100,
  maxComments: 100,
  maxDegraded: 32,
  maxTextChars: 256,
});

/** green | failed | pending — reuses the SAME predicates as the verdict core. */
function classifyCheck(check) {
  if (isFailed(check)) return 'failed';
  if (isGreen(check)) return 'green';
  return 'pending';
}

function compareBy(field) {
  return (left, right) => {
    const a = String(left[field] ?? '');
    const b = String(right[field] ?? '');
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  };
}

function evidenceText(value) {
  return normalizeEvidenceText(value, { maxChars: SNAPSHOT_LIMITS.maxTextChars });
}

function identifiedSurface(value) {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value.source || value.surface || null;
  }
  return null;
}

function createEvidenceTracker(initialDegraded) {
  const degraded = [];
  const incompleteSurfaces = new Set();
  const add = (surface, error) => {
    const safeSurface = evidenceText(surface) || 'unknown';
    const safeError = evidenceText(error) || 'evidence unavailable';
    incompleteSurfaces.add(safeSurface);
    if (!degraded.some((item) => item.surface === safeSurface && item.error === safeError)
      && degraded.length < SNAPSHOT_LIMITS.maxDegraded) {
      degraded.push({ surface: safeSurface, error: safeError });
    }
  };
  if (!Array.isArray(initialDegraded)) {
    add('degraded', 'degraded evidence is malformed');
    const surface = identifiedSurface(initialDegraded);
    if (surface) add(surface, 'degraded evidence metadata is malformed');
  } else {
    for (const item of initialDegraded.slice(0, SNAPSHOT_LIMITS.maxDegraded)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        add('degraded', 'degraded evidence item is malformed');
        const surface = identifiedSurface(item);
        if (surface) add(surface, 'degraded evidence metadata is malformed');
      } else {
        add(item.source || item.surface || 'unknown', item.error || 'evidence unavailable');
      }
    }
    if (initialDegraded.length > SNAPSHOT_LIMITS.maxDegraded) {
      add('degraded', 'degraded evidence exceeded item limit');
    }
  }
  return { add, degraded, incompleteSurfaces };
}

function trackUnreadable(value, tracker) {
  if (!Array.isArray(value)) {
    tracker.add('unreadable', 'unreadable evidence is malformed');
    const surface = identifiedSurface(value);
    if (surface) tracker.add(surface, 'unreadable evidence metadata is malformed');
    return;
  }
  for (const item of value) {
    if (typeof item === 'string' && item.trim()) {
      tracker.add(item, 'provider read was incomplete');
    } else {
      tracker.add('unreadable', 'unreadable evidence item is malformed');
      const surface = identifiedSurface(item);
      if (surface) tracker.add(surface, 'unreadable evidence metadata is malformed');
    }
  }
}

function boundedNormalize(value, { surface, limit, normalize, tracker, sortField }) {
  if (!Array.isArray(value)) {
    tracker.add(surface, `${surface} evidence is missing or malformed`);
    return [];
  }
  if (value.length > limit) tracker.add(surface, `${surface} evidence exceeded ${limit} item limit`);
  const output = [];
  for (const item of value.slice(0, limit)) {
    try {
      output.push(normalize(item));
    } catch (_error) {
      tracker.add(surface, `${surface} evidence item is malformed`);
    }
  }
  return output.sort(compareBy(sortField));
}

function normalizeChecks(checks, tracker) {
  return boundedNormalize(checks, {
    surface: 'checks',
    limit: SNAPSHOT_LIMITS.maxChecks,
    tracker,
    sortField: 'name',
    normalize: (check) => {
      if (!check || typeof check !== 'object' || Array.isArray(check)
        || typeof check.name !== 'string' || !check.name.trim()
        || (typeof check.status !== 'string' && typeof check.conclusion !== 'string')) {
        throw new TypeError('malformed check');
      }
      return { name: evidenceText(check.name), class: classifyCheck(check) };
    },
  });
}

function normalizeActor(value) {
  const author = evidenceText(value.author);
  const actorKind = classifyReviewActor(value);
  if (!author || actorKind === 'unknown') throw new TypeError('malformed actor');
  return { author, actorKind };
}

function normalizeThreads(threads, tracker) {
  return boundedNormalize(threads, {
    surface: 'threads',
    limit: SNAPSHOT_LIMITS.maxThreads,
    tracker,
    sortField: 'threadId',
    normalize: (thread) => {
      if (!thread || typeof thread !== 'object' || Array.isArray(thread)
        || typeof thread.threadId !== 'string' || !thread.threadId
        || typeof thread.isResolved !== 'boolean'
        || typeof thread.isOutdated !== 'boolean'
        || !Array.isArray(thread.comments) || thread.comments.length === 0
        || (thread.path !== null && thread.path !== undefined && typeof thread.path !== 'string')) {
        throw new TypeError('malformed thread');
      }
      const actor = normalizeActor(thread.comments[0]);
      return {
        threadId: evidenceText(thread.threadId),
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        commentCount: thread.comments.length,
        actionable: !thread.isResolved && !thread.isOutdated,
        path: thread.path ? evidenceText(thread.path) : null,
        ...actor,
      };
    },
  });
}

function normalizeReviews(reviews, tracker) {
  return boundedNormalize(reviews, {
    surface: 'reviews',
    limit: SNAPSHOT_LIMITS.maxReviews,
    tracker,
    sortField: 'author',
    normalize: (review) => {
      if (!review || typeof review !== 'object' || Array.isArray(review)
        || typeof review.state !== 'string' || !review.state) {
        throw new TypeError('malformed review');
      }
      const actor = normalizeActor(review);
      return {
        ...actor,
        state: evidenceText(review.state),
        commitOid: review.commitOid == null ? null : evidenceText(review.commitOid),
        submittedAt: review.submittedAt == null ? null : evidenceText(review.submittedAt),
      };
    },
  });
}

function normalizeComments(comments, tracker) {
  return boundedNormalize(comments, {
    surface: 'comments',
    limit: SNAPSHOT_LIMITS.maxComments,
    tracker,
    sortField: 'id',
    normalize: (comment) => {
      if (!comment || typeof comment !== 'object' || Array.isArray(comment)
        || typeof comment.id !== 'string' || !comment.id) {
        throw new TypeError('malformed comment');
      }
      return { id: evidenceText(comment.id), ...normalizeActor(comment) };
    },
  });
}

/**
 * Conflict prediction → tri-state boolean: `true`/`false` when supported,
 * `null` when unknown (unsupported git, unreadable ref) so the differ never
 * emits a false conflict.appeared/cleared on missing data.
 */
function conflictBool(conflicts) {
  if (conflicts?.supported === true) return Boolean(conflicts.conflicted);
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
  const source = snap && typeof snap === 'object' && !Array.isArray(snap) ? snap : {};
  const state = source.state && typeof source.state === 'object' && !Array.isArray(source.state)
    ? source.state
    : {};
  const hasDegraded = Object.prototype.hasOwnProperty.call(source, 'degraded');
  const tracker = createEvidenceTracker(hasDegraded ? source.degraded : []);
  if (state !== source.state) tracker.add('state', 'PR state evidence is missing or malformed');
  if (Object.prototype.hasOwnProperty.call(source, 'unreadable')) {
    trackUnreadable(source.unreadable, tracker);
  }
  const checks = normalizeChecks(state.checks, tracker);
  const threads = normalizeThreads(source.threads, tracker);
  const reviews = normalizeReviews(source.reviews, tracker);
  const comments = normalizeComments(source.issueComments, tracker);
  const behind = Number.isSafeInteger(source.behind) && source.behind >= 0 ? source.behind : 0;
  if (behind !== source.behind && source.behind !== undefined) {
    tracker.add('branch', 'branch divergence evidence is malformed');
  }
  const openThreadCount = threads.filter((thread) => thread.actionable).length;
  const evidenceStatus = tracker.degraded.length === 0 ? 'COMPLETE' : 'INCOMPLETE';
  const threadState = tracker.incompleteSurfaces.has('threads')
    ? 'INCOMPLETE'
    : (openThreadCount > 0 ? 'OPEN' : 'ZERO');
  return {
    repo: evidenceText(ctx?.repo),
    pr: evidenceText(ctx?.pr),
    headSha: evidenceText(state.headSha),
    prState: String(state.state || 'OPEN').toUpperCase(),
    draft: Boolean(source.draft),
    verdict: {
      state: evidenceStatus === 'COMPLETE' ? (source.verdict || 'UNKNOWN') : 'UNKNOWN',
      reason: evidenceStatus === 'COMPLETE' ? null : 'review evidence incomplete',
    },
    evidenceStatus,
    threadState,
    openThreadCount,
    checks,
    threads,
    reviews,
    comments,
    behind,
    conflicts: conflictBool(source.conflicts),
    degraded: tracker.degraded.sort(compareBy('surface')),
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
  SNAPSHOT_LIMITS,
  gatherMonitorSnapshot,
  normalizeSnapshot,
  classifyCheck,
  conflictBool,
};
