'use strict';

/**
 * PR-monitor differ — the PURE heart of the monitor. `diffSnapshots(prev, next)`
 * returns the ordered candidate events for the transition between two normalized
 * snapshots (see lib/pr-monitor/gather.js for the shape). No I/O, no clock, no
 * randomness — same inputs always yield the same events, which is what makes the
 * monitor deterministic and duplicate-free across restarts.
 *
 * Each event carries a CONTENT key (head sha, threadId, check name+sha, comment
 * id, review author+commit, surface) so the journal can dedup by identity.
 *
 * @module pr-monitor/differ
 */

const { EVENT_TYPES: T, makeEvent } = require('./events');

/** Index an array of objects by a key field into a Map. */
function indexBy(list, field) {
  const map = new Map();
  for (const item of (Array.isArray(list) ? list : [])) {
    if (item && item[field] != null) map.set(String(item[field]), item);
  }
  return map;
}

/** True when every check is green (none failed, none pending). */
function allGreen(checks) {
  const list = Array.isArray(checks) ? checks : [];
  return list.length > 0 && list.every((c) => c.class === 'green');
}

/** head.pushed — the PR's head sha advanced. */
function diffHead(prev, next, out) {
  if (next.headSha && prev.headSha !== next.headSha) {
    out.push(makeEvent(T.HEAD_PUSHED, next.headSha, { from: prev.headSha || null, to: next.headSha }));
  }
}

/** check.failed / check.recovered / checks.green — keyed by name+sha. */
function diffChecks(prev, next, out) {
  const prevByName = indexBy(prev.checks, 'name');
  for (const c of (next.checks || [])) {
    const before = prevByName.get(String(c.name));
    const wasFailed = before && before.class === 'failed';
    if (c.class === 'failed' && !wasFailed) {
      out.push(makeEvent(T.CHECK_FAILED, `${c.name}:${next.headSha}`, { name: c.name }));
    } else if (c.class === 'green' && wasFailed) {
      out.push(makeEvent(T.CHECK_RECOVERED, `${c.name}:${next.headSha}`, { name: c.name }));
    }
  }
  if (allGreen(next.checks) && !allGreen(prev.checks)) {
    out.push(makeEvent(T.CHECKS_GREEN, next.headSha, {}));
  }
}

/** thread.opened / thread.reply / thread.resolved — keyed by threadId. */
function diffThreads(prev, next, out) {
  const prevById = indexBy(prev.threads, 'threadId');
  for (const t of (next.threads || [])) {
    const before = prevById.get(String(t.threadId));
    if (!before) {
      if (t.actionable) out.push(makeEvent(T.THREAD_OPENED, t.threadId, { path: t.path || null }));
      continue;
    }
    if ((t.commentCount || 0) > (before.commentCount || 0)) {
      out.push(makeEvent(T.THREAD_REPLY, `${t.threadId}:${t.commentCount}`, { threadId: t.threadId }));
    }
    if (t.isResolved && !before.isResolved) {
      out.push(makeEvent(T.THREAD_RESOLVED, t.threadId, {}));
    }
  }
}

/** comment.posted — a new direct PR issue comment, keyed by comment id. */
function diffComments(prev, next, out) {
  const prevIds = indexBy(prev.comments, 'id');
  for (const c of (next.comments || [])) {
    if (!prevIds.has(String(c.id))) {
      out.push(makeEvent(T.COMMENT_POSTED, c.id, { author: c.author || '' }));
    }
  }
}

/** review.submitted — a new/updated review per author (state or commit changed). */
function diffReviews(prev, next, out) {
  const prevByAuthor = indexBy(prev.reviews, 'author');
  for (const r of (next.reviews || [])) {
    const before = prevByAuthor.get(String(r.author));
    const changed = !before
      || before.submittedAt !== r.submittedAt
      || before.commitOid !== r.commitOid;
    if (changed) {
      out.push(makeEvent(T.REVIEW_SUBMITTED, `${r.author}:${r.commitOid || r.submittedAt}`, {
        author: r.author, verdict: r.state, commitOid: r.commitOid || null,
      }));
    }
  }
}

/** conflict.appeared / conflict.cleared — keyed by head sha. */
function diffConflict(prev, next, out) {
  if (next.conflicts === true && prev.conflicts !== true) {
    out.push(makeEvent(T.CONFLICT_APPEARED, next.headSha, {}));
  } else if (next.conflicts === false && prev.conflicts === true) {
    out.push(makeEvent(T.CONFLICT_CLEARED, next.headSha, {}));
  }
}

/** branch.behind — the branch fell behind its base. */
function diffBehind(prev, next, out) {
  if ((next.behind || 0) > 0 && (prev.behind || 0) === 0) {
    out.push(makeEvent(T.BRANCH_BEHIND, `${next.headSha}:${next.behind}`, { behind: next.behind }));
  }
}

/** verdict.changed — the fail-closed merge verdict flipped. */
function diffVerdict(prev, next, out) {
  const from = prev.verdict ? prev.verdict.state : null;
  const to = next.verdict ? next.verdict.state : null;
  if (from !== to) {
    out.push(makeEvent(T.VERDICT_CHANGED, `${from}->${to}:${next.headSha}`, {
      from, to, reason: next.verdict ? next.verdict.reason || null : null,
    }));
  }
}

/** pr.merged / pr.closed — terminal transitions from an OPEN PR. */
function diffPrState(prev, next, out) {
  if (prev.prState === 'OPEN' && next.prState === 'MERGED') {
    out.push(makeEvent(T.PR_MERGED, 'MERGED', {}));
  } else if (prev.prState === 'OPEN' && next.prState === 'CLOSED') {
    out.push(makeEvent(T.PR_CLOSED, 'CLOSED', {}));
  }
}

/** monitor.degraded — a read surface newly became unreadable (fail-closed). */
function diffDegraded(prev, next, out) {
  const prevSurfaces = new Set((prev.degraded || []).map((d) => d.surface));
  for (const d of (next.degraded || [])) {
    if (!prevSurfaces.has(d.surface)) {
      out.push(makeEvent(T.MONITOR_DEGRADED, d.surface, { surface: d.surface, error: d.error || '' }));
    }
  }
}

/**
 * Baseline events for the FIRST pass (no prior snapshot): a single verdict
 * baseline plus any already-terminal/degraded state — bounded, never a replay of
 * every historical thread/check.
 */
function diffBaseline(next, out) {
  out.push(makeEvent(T.VERDICT_CHANGED, `baseline:${next.headSha}`, {
    from: null, to: next.verdict ? next.verdict.state : null,
    reason: next.verdict ? next.verdict.reason || null : null,
  }));
  if (next.prState === 'MERGED') out.push(makeEvent(T.PR_MERGED, 'MERGED', {}));
  if (next.prState === 'CLOSED') out.push(makeEvent(T.PR_CLOSED, 'CLOSED', {}));
  for (const d of (next.degraded || [])) {
    out.push(makeEvent(T.MONITOR_DEGRADED, d.surface, { surface: d.surface, error: d.error || '' }));
  }
}

/**
 * Diff two normalized snapshots into ordered candidate events. `prev === null`
 * → first-pass baseline.
 *
 * @param {object|null} prev
 * @param {object} next
 * @returns {Array<{ type: string, key: string, data: object }>}
 */
function diffSnapshots(prev, next) {
  const out = [];
  if (!prev) {
    diffBaseline(next, out);
    return out;
  }
  diffHead(prev, next, out);
  diffChecks(prev, next, out);
  diffThreads(prev, next, out);
  diffComments(prev, next, out);
  diffReviews(prev, next, out);
  diffConflict(prev, next, out);
  diffBehind(prev, next, out);
  diffVerdict(prev, next, out);
  diffPrState(prev, next, out);
  diffDegraded(prev, next, out);
  return out;
}

module.exports = {
  diffSnapshots,
  allGreen,
  indexBy,
};
