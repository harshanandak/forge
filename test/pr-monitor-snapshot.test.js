'use strict';

const { describe, test, expect } = require('bun:test');
const { gatherPrSnapshot } = require('../lib/pr-pull');
const { isFailed } = require('../lib/pr-shepherd');

/** A fake pr-state adapter that records the ORDER of its method calls. */
function recordingAdapter(order) {
  const rec = (name, ret) => (..._a) => { order.push(name); return ret; };
  return {
    id: 'fake', kind: 'pr-state', name: 'fake',
    readState: rec('readState', { headSha: 'h1', state: 'OPEN', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, isDraft: false, checks: [] }),
    readRequiredChecks: rec('readRequiredChecks', []),
    readComments: rec('readComments', []),
    fetchBase: rec('fetchBase', undefined),
    readDivergence: rec('readDivergence', { behind: 0, ahead: 1 }),
    detectConflicts: rec('detectConflicts', { supported: true, conflicted: false, files: [] }),
    readIssueComments: rec('readIssueComments', []),
    readReviews: rec('readReviews', []),
    readHeadCommitTime: rec('readHeadCommitTime', 1000),
  };
}

describe('gatherPrSnapshot — the shared monitor gather', () => {
  test('fetches the base ref BEFORE reading divergence/conflicts (A6)', async () => {
    const order = [];
    await gatherPrSnapshot({
      pr: '1', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      adapter: recordingAdapter(order), self: 'forge-bot', now: 2000, settleWindowMs: 0,
    });
    const fetchIdx = order.indexOf('fetchBase');
    const divIdx = order.indexOf('readDivergence');
    const conflictIdx = order.indexOf('detectConflicts');
    expect(fetchIdx).toBeGreaterThanOrEqual(0);
    expect(fetchIdx).toBeLessThan(divIdx);
    expect(fetchIdx).toBeLessThan(conflictIdx);
  });

  test('returns the verdict + raw reads the monitor diffs', async () => {
    const snap = await gatherPrSnapshot({
      pr: '1', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master',
      adapter: recordingAdapter([]), self: 'forge-bot', now: 2000, settleWindowMs: 0,
    });
    expect(typeof snap.verdict).toBe('string');
    expect(snap.state.headSha).toBe('h1');
    expect(Array.isArray(snap.threads)).toBe(true);
    expect(Array.isArray(snap.reviews)).toBe(true);
    expect(Array.isArray(snap.issueComments)).toBe(true);
  });
});

describe('isFailed — STALE conclusion (A5)', () => {
  test('a STALE required check is treated as failed, not pending forever', () => {
    expect(isFailed({ conclusion: 'STALE' })).toBe(true);
    expect(isFailed({ conclusion: 'SUCCESS' })).toBe(false);
  });
});
