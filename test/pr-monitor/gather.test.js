'use strict';

const { describe, test, expect } = require('bun:test');

const {
  SNAPSHOT_LIMITS,
  gatherMonitorSnapshot,
  normalizeSnapshot,
  classifyCheck,
  conflictBool,
} = require('../../lib/pr-monitor/gather');

describe('gather — normalizeSnapshot mapping', () => {
  test('classifyCheck reuses the verdict-core predicates', () => {
    expect(classifyCheck({ conclusion: 'FAILURE' })).toBe('failed');
    expect(classifyCheck({ conclusion: 'STALE' })).toBe('failed'); // A5 gap filled
    expect(classifyCheck({ status: 'COMPLETED', conclusion: 'SUCCESS' })).toBe('green');
    expect(classifyCheck({ conclusion: '', status: 'IN_PROGRESS' })).toBe('pending');
  });

  test('conflictBool is tri-state (null when prediction unsupported)', () => {
    expect(conflictBool({ supported: true, conflicted: true })).toBe(true);
    expect(conflictBool({ supported: true, conflicted: false })).toBe(false);
    expect(conflictBool({ supported: false, reason: 'git too old' })).toBeNull();
    expect(conflictBool(null)).toBeNull();
  });

  test('maps a raw gatherPrSnapshot result into the diff subject', () => {
    const raw = {
      state: { headSha: 'h1', state: 'OPEN', checks: [{ name: 'ci', conclusion: 'FAILURE' }] },
      draft: true,
      verdict: 'BLOCKED-THREADS',
      threads: [{
        threadId: 't1', isResolved: false, isOutdated: false,
        comments: [
          { author: 'coderabbitai', authorType: 'Bot' },
          { author: 'human-reviewer', authorType: 'User' },
        ],
      }],
      reviews: [{ author: 'coderabbitai', authorTypename: 'Bot', state: 'CHANGES_REQUESTED', commitOid: 'h1', submittedAt: 't' }],
      issueComments: [{ id: '9', author: 'sonarqubecloud', authorTypename: 'Bot', createdAt: 'x' }],
      behind: 2,
      conflicts: { supported: true, conflicted: false },
      degraded: [{ source: 'reviews', error: 'HTTP 403' }],
    };
    const s = normalizeSnapshot(raw, { repo: 'r', pr: '1' });
    expect(s.headSha).toBe('h1');
    expect(s.draft).toBe(true);
    expect(s.verdict.state).toBe('UNKNOWN');
    expect(s.checks).toEqual([{ name: 'ci', class: 'failed' }]);
    expect(s.threads[0]).toMatchObject({ threadId: 't1', commentCount: 2, actionable: true, actorKind: 'bot' });
    expect(s.reviews[0]).toMatchObject({ author: 'coderabbitai', actorKind: 'bot' });
    expect(s.comments).toEqual([{ id: '9', author: 'sonarqubecloud', actorKind: 'bot' }]);
    expect(s.behind).toBe(2);
    expect(s.conflicts).toBe(false);
    expect(s.degraded).toEqual([{ surface: 'reviews', error: 'HTTP 403' }]);
    expect(s.evidenceStatus).toBe('INCOMPLETE');
    expect(s.threadState).toBe('OPEN');
    expect(s.openThreadCount).toBe(1);
  });

  test('distinguishes authoritative zero threads from open threads', () => {
    const zero = normalizeSnapshot({
      state: { headSha: 'h1', state: 'OPEN', checks: [] },
      verdict: 'CLEAN-MERGEABLE', threads: [], reviews: [], issueComments: [], degraded: [],
    }, { repo: 'r', pr: '1' });
    expect(zero.evidenceStatus).toBe('COMPLETE');
    expect(zero.threadState).toBe('ZERO');
    expect(zero.openThreadCount).toBe(0);

    const open = normalizeSnapshot({
      state: { headSha: 'h1', state: 'OPEN', checks: [] },
      verdict: 'BLOCKED-THREADS',
      threads: [{
        threadId: 't1', isResolved: false, isOutdated: false,
        comments: [{ author: 'not-a-bot-name', authorType: 'Bot' }],
      }],
      reviews: [], issueComments: [], degraded: [],
    }, { repo: 'r', pr: '1' });
    expect(open.evidenceStatus).toBe('COMPLETE');
    expect(open.threadState).toBe('OPEN');
    expect(open.openThreadCount).toBe(1);
    expect(open.threads[0].actorKind).toBe('bot');
  });

  test('malformed provider evidence fails closed instead of becoming zero', () => {
    const s = normalizeSnapshot({
      state: { headSha: 'h1', state: 'OPEN', checks: {} },
      verdict: 'CLEAN-MERGEABLE',
      threads: null,
      reviews: [{ author: 'reviewer', state: 'APPROVED' }],
      issueComments: 'not-an-array',
      degraded: [],
    }, { repo: 'r', pr: '1' });

    expect(s.evidenceStatus).toBe('INCOMPLETE');
    expect(s.threadState).toBe('INCOMPLETE');
    expect(s.verdict.state).toBe('UNKNOWN');
    expect(s.degraded.map((item) => item.surface)).toEqual(expect.arrayContaining([
      'checks', 'threads', 'reviews', 'comments',
    ]));
  });

  test('bounds and redacts normalized provider evidence deterministically', () => {
    const secret = 'ghp_123456789012345678901234567890';
    const checks = Array.from({ length: SNAPSHOT_LIMITS.maxChecks + 5 }, (_, index) => ({
      name: `check-${index}-${secret}-C:\\Users\\alice\\private`,
      conclusion: 'SUCCESS',
      status: 'COMPLETED',
    }));
    const input = {
      state: { headSha: 'h1', state: 'OPEN', checks },
      verdict: 'CLEAN-MERGEABLE', threads: [], reviews: [], issueComments: [], degraded: [],
    };
    const s = normalizeSnapshot(input, { repo: 'r', pr: '1' });
    const serialized = JSON.stringify(s);

    expect(s.checks).toHaveLength(SNAPSHOT_LIMITS.maxChecks);
    expect(s.evidenceStatus).toBe('INCOMPLETE');
    expect(s.verdict.state).toBe('UNKNOWN');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('alice');
    expect(normalizeSnapshot(input, { repo: 'r', pr: '1' })).toEqual(s);
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
