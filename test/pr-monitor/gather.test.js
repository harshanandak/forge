'use strict';

const { describe, test, expect } = require('bun:test');

const { gatherMonitorSnapshot, normalizeSnapshot, classifyCheck, conflictBool } = require('../../lib/pr-monitor/gather');

describe('gather — normalizeSnapshot mapping', () => {
  test('classifyCheck reuses the verdict-core predicates', () => {
    expect(classifyCheck({ conclusion: 'FAILURE' })).toBe('failed');
    expect(classifyCheck({ conclusion: 'STALE' })).toBe('failed'); // A5 gap filled
    expect(classifyCheck({ conclusion: 'SUCCESS' })).toBe('green');
    expect(classifyCheck({ conclusion: '', status: 'IN_PROGRESS' })).toBe('pending');
  });

  test('conflictBool is tri-state (null when prediction unsupported)', () => {
    expect(conflictBool({ supported: true, conflicted: true })).toBe(true);
    expect(conflictBool({ supported: true, conflicted: false })).toBe(false);
    expect(conflictBool({ supported: false, reason: 'git too old' })).toBe(null);
    expect(conflictBool(null)).toBe(null);
  });

  test('maps a raw gatherPrSnapshot result into the diff subject', () => {
    const raw = {
      state: { headSha: 'h1', state: 'OPEN', checks: [{ name: 'ci', conclusion: 'FAILURE' }] },
      draft: true,
      verdict: 'BLOCKED-THREADS',
      threads: [{ threadId: 't1', isResolved: false, isOutdated: false, comments: [{}, {}] }],
      reviews: [{ author: 'coderabbitai', state: 'CHANGES_REQUESTED', commitOid: 'h1', submittedAt: 't' }],
      issueComments: [{ id: '9', author: 'sonarqubecloud', createdAt: 'x' }],
      behind: 2,
      conflicts: { supported: true, conflicted: false },
      degraded: [{ source: 'reviews', error: 'HTTP 403' }],
    };
    const s = normalizeSnapshot(raw, { repo: 'r', pr: '1' });
    expect(s.headSha).toBe('h1');
    expect(s.draft).toBe(true);
    expect(s.verdict.state).toBe('BLOCKED-THREADS');
    expect(s.checks).toEqual([{ name: 'ci', class: 'failed' }]);
    expect(s.threads[0]).toMatchObject({ threadId: 't1', commentCount: 2, actionable: true });
    expect(s.comments).toEqual([{ id: '9', author: 'sonarqubecloud' }]);
    expect(s.behind).toBe(2);
    expect(s.conflicts).toBe(false);
    expect(s.degraded).toEqual([{ surface: 'reviews', error: 'HTTP 403' }]);
  });

  test('gatherMonitorSnapshot uses the injected snapshot source', async () => {
    const s = await gatherMonitorSnapshot({
      repo: 'r', pr: '5',
      gatherSnapshot: async () => ({ state: { headSha: 'z', state: 'MERGED', checks: [] }, verdict: 'CLEAN-MERGEABLE' }),
    });
    expect(s.prState).toBe('MERGED');
    expect(s.headSha).toBe('z');
  });
});
