'use strict';

const { describe, test, expect } = require('bun:test');

const { diffSnapshots } = require('../../lib/pr-monitor/differ');
const { EVENT_TYPES: T } = require('../../lib/pr-monitor/events');

/** A green baseline snapshot; override any field per test. */
function snap(over = {}) {
  return {
    repo: 'r', pr: '1', headSha: 'sha1', prState: 'OPEN', draft: false,
    verdict: { state: 'CLEAN-MERGEABLE', reason: null },
    checks: [], threads: [], reviews: [], comments: [], behind: 0, conflicts: false, degraded: [],
    ...over,
  };
}

const types = (events) => events.map((e) => e.type);
const find = (events, type) => events.find((e) => e.type === type);

describe('diffSnapshots — baseline (first pass)', () => {
  test('emits a single verdict baseline keyed on head sha', () => {
    const events = diffSnapshots(null, snap());
    expect(types(events)).toEqual([T.VERDICT_CHANGED]);
    expect(events[0].key).toBe('baseline:sha1');
    expect(events[0].data).toEqual({ from: null, to: 'CLEAN-MERGEABLE', reason: null });
  });

  test('baseline includes terminal + degraded state but never replays history', () => {
    const events = diffSnapshots(null, snap({
      prState: 'MERGED',
      degraded: [{ surface: 'threads', error: 'HTTP 403' }],
      threads: [{ threadId: 't1', isResolved: false, isOutdated: false, commentCount: 1, actionable: true }],
    }));
    expect(types(events)).toContain(T.PR_MERGED);
    expect(types(events)).toContain(T.MONITOR_DEGRADED);
    expect(types(events)).not.toContain(T.THREAD_OPENED);
  });
});

describe('diffSnapshots — per-type transitions', () => {
  test('head.pushed on a head-sha advance, keyed on the new sha', () => {
    const e = find(diffSnapshots(snap(), snap({ headSha: 'sha2' })), T.HEAD_PUSHED);
    expect(e).toBeDefined();
    expect(e.key).toBe('sha2');
  });

  test('check.failed / check.recovered / checks.green', () => {
    const green = snap({ checks: [{ name: 'ci', class: 'green' }] });
    const failed = snap({ checks: [{ name: 'ci', class: 'failed' }] });
    expect(find(diffSnapshots(green, failed), T.CHECK_FAILED).key).toBe('ci:sha1');
    const events = diffSnapshots(failed, green);
    expect(find(events, T.CHECK_RECOVERED).key).toBe('ci:sha1');
    expect(find(events, T.CHECKS_GREEN)).toBeDefined();
  });

  test('thread.opened only for an actionable new thread', () => {
    const opened = find(diffSnapshots(snap(), snap({
      threads: [{ threadId: 't1', isResolved: false, isOutdated: false, commentCount: 1, actionable: true }],
    })), T.THREAD_OPENED);
    expect(opened.key).toBe('t1');
    const none = diffSnapshots(snap(), snap({
      threads: [{ threadId: 't2', isResolved: true, isOutdated: false, commentCount: 1, actionable: false }],
    }));
    expect(types(none)).not.toContain(T.THREAD_OPENED);
  });

  test('thread.reply on a comment-count increase; thread.resolved on resolution', () => {
    const prev = snap({ threads: [{ threadId: 't1', isResolved: false, isOutdated: false, commentCount: 1, actionable: true }] });
    const next = snap({ threads: [{ threadId: 't1', isResolved: true, isOutdated: false, commentCount: 2, actionable: false }] });
    const events = diffSnapshots(prev, next);
    expect(find(events, T.THREAD_REPLY).key).toBe('t1:2');
    expect(find(events, T.THREAD_RESOLVED).key).toBe('t1');
  });

  test('comment.posted keyed on the stable comment id', () => {
    expect(find(diffSnapshots(snap(), snap({ comments: [{ id: '999', author: 'sonarqubecloud' }] })), T.COMMENT_POSTED).key).toBe('999');
  });

  test('review.submitted when a review is new or its commit changed', () => {
    const prev = snap({ reviews: [{ author: 'coderabbitai', state: 'COMMENTED', commitOid: 'old', submittedAt: 't0' }] });
    const next = snap({ reviews: [{ author: 'coderabbitai', state: 'CHANGES_REQUESTED', commitOid: 'new', submittedAt: 't1' }] });
    const e = find(diffSnapshots(prev, next), T.REVIEW_SUBMITTED);
    expect(e.key).toBe('coderabbitai:new');
    expect(e.data.verdict).toBe('CHANGES_REQUESTED');
  });

  test('conflict.appeared / conflict.cleared; null conflict never emits', () => {
    expect(find(diffSnapshots(snap({ conflicts: false }), snap({ conflicts: true })), T.CONFLICT_APPEARED)).toBeDefined();
    expect(find(diffSnapshots(snap({ conflicts: true }), snap({ conflicts: false })), T.CONFLICT_CLEARED)).toBeDefined();
    expect(types(diffSnapshots(snap({ conflicts: false }), snap({ conflicts: null })))).not.toContain(T.CONFLICT_APPEARED);
  });

  test('branch.behind only on the 0 → >0 transition', () => {
    expect(find(diffSnapshots(snap({ behind: 0 }), snap({ behind: 3 })), T.BRANCH_BEHIND).data.behind).toBe(3);
    expect(types(diffSnapshots(snap({ behind: 2 }), snap({ behind: 5 })))).not.toContain(T.BRANCH_BEHIND);
  });

  test('verdict.changed carries from/to/reason', () => {
    const prev = snap({ verdict: { state: 'REVIEW-PENDING', reason: null } });
    const next = snap({ verdict: { state: 'CLEAN-MERGEABLE', reason: 'settled' } });
    expect(find(diffSnapshots(prev, next), T.VERDICT_CHANGED).data).toEqual({ from: 'REVIEW-PENDING', to: 'CLEAN-MERGEABLE', reason: 'settled' });
  });

  test('pr.merged / pr.closed only from OPEN', () => {
    expect(find(diffSnapshots(snap(), snap({ prState: 'MERGED' })), T.PR_MERGED)).toBeDefined();
    expect(find(diffSnapshots(snap(), snap({ prState: 'CLOSED' })), T.PR_CLOSED)).toBeDefined();
  });

  test('monitor.degraded surfaced (not swallowed) for a newly-unreadable surface', () => {
    const e = find(diffSnapshots(snap(), snap({ degraded: [{ surface: 'reviews', error: 'HTTP 403' }] })), T.MONITOR_DEGRADED);
    expect(e.key).toBe('reviews');
    expect(e.data.error).toBe('HTTP 403');
  });
});

describe('diffSnapshots — determinism', () => {
  test('identical snapshots produce no events', () => {
    expect(diffSnapshots(snap(), snap())).toEqual([]);
  });

  test('the same transition always yields the same content key (crash-safe identity)', () => {
    const mk = () => diffSnapshots(snap({ checks: [{ name: 'ci', class: 'green' }] }), snap({ checks: [{ name: 'ci', class: 'failed' }] }));
    expect(mk().map((e) => `${e.type} ${e.key}`)).toEqual(mk().map((e) => `${e.type} ${e.key}`));
  });
});
