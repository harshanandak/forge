'use strict';

const { describe, test, expect } = require('bun:test');

const {
  computeVerdict,
  verdictLabel,
  verdictHeadline,
  VERDICT_LABELS,
  VERDICTS,
} = require('../lib/pr-verdict');

/**
 * Build a `gatherPrBundle` result (lib/pr-bundle.js shape) with the pr-monitor
 * workflow's `ciAvailable` stamp, from a compact spec. Defaults describe a
 * fully-read, clean, mergeable PR; each flag overrides one signal so a test
 * isolates the transition it asserts.
 */
function makeBundle(spec = {}) {
  const {
    pr = '123',
    failing = [],
    pending = [],
    threads = 0,
    threadsAvailable = true,
    ciAvailable = true,
    mergeStateStatus = 'CLEAN',
    behind = 0,
  } = spec;
  return {
    pr: String(pr),
    unresolvedComments: Array.from({ length: threads }, (_, i) => ({ author: 'x', threadId: `T${i}` })),
    unresolvedCommentsAvailable: threadsAvailable,
    unresolvedCommentsError: threadsAvailable ? null : 'unreadable',
    ciAvailable,
    mergeState: { mergeable: 'MERGEABLE', mergeStateStatus, state: 'OPEN' },
    ci: {
      checks: [],
      failing: failing.map((name) => ({ name, conclusion: 'FAILURE' })),
      pending: pending.map((name) => ({ name, status: 'IN_PROGRESS' })),
    },
    branch: { ahead: 1, behind },
  };
}

describe('computeVerdict — the actionable transitions', () => {
  test('clean + green + zero threads → mergeable', () => {
    const v = computeVerdict(makeBundle());
    expect(v.verdict).toBe('mergeable');
    expect(v.mergeable).toBe(true);
  });

  test('a failed check → check-failed (never mergeable)', () => {
    const v = computeVerdict(makeBundle({ failing: ['Tests'] }));
    expect(v.verdict).toBe('check-failed');
    expect(v.mergeable).toBe(false);
    expect(v.failing_checks).toEqual(['Tests']);
  });

  test('unresolved review threads → threads-open', () => {
    const v = computeVerdict(makeBundle({ threads: 3 }));
    expect(v.verdict).toBe('threads-open');
    expect(v.threads_open).toBe(3);
  });

  test('merge conflict (DIRTY) → conflict', () => {
    const v = computeVerdict(makeBundle({ mergeStateStatus: 'DIRTY' }));
    expect(v.verdict).toBe('conflict');
    expect(v.mergeable).toBe(false);
  });

  test('branch behind base → behind', () => {
    expect(computeVerdict(makeBundle({ mergeStateStatus: 'BEHIND' })).verdict).toBe('behind');
    expect(computeVerdict(makeBundle({ behind: 25 })).verdict).toBe('behind');
  });

  test('checks still running (non-CLEAN) → pending', () => {
    const v = computeVerdict(makeBundle({ pending: ['Build'], mergeStateStatus: 'UNSTABLE' }));
    expect(v.verdict).toBe('pending');
  });
});

describe('computeVerdict — priority mirrors the canonical --pull ladder', () => {
  // UNKNOWN > CONFLICT > BEHIND > CHECK-FAILED > THREADS-OPEN > PENDING > MERGEABLE
  test('unreadable signal outranks everything → unknown (fail-closed)', () => {
    expect(computeVerdict(makeBundle({ ciAvailable: false, failing: ['x'] })).verdict).toBe('unknown');
    expect(computeVerdict(makeBundle({ threadsAvailable: false, threads: 0 })).verdict).toBe('unknown');
  });

  test('conflict outranks behind, checks, and threads', () => {
    const v = computeVerdict(makeBundle({ mergeStateStatus: 'DIRTY', failing: ['t'], threads: 2, behind: 5 }));
    expect(v.verdict).toBe('conflict');
  });

  test('behind outranks check-failed and threads', () => {
    const v = computeVerdict(makeBundle({ behind: 3, failing: ['t'], threads: 2, mergeStateStatus: 'BEHIND' }));
    expect(v.verdict).toBe('behind');
  });

  test('check-failed outranks threads-open', () => {
    const v = computeVerdict(makeBundle({ failing: ['t'], threads: 2 }));
    expect(v.verdict).toBe('check-failed');
    expect(v.threads_open).toBe(2); // still surfaced in payload
  });

  test('never mergeable while any blocker or unreadable signal exists', () => {
    for (const spec of [{ failing: ['t'] }, { threads: 1 }, { mergeStateStatus: 'DIRTY' }, { behind: 1 }, { ciAvailable: false }]) {
      expect(computeVerdict(makeBundle(spec)).mergeable).toBe(false);
    }
  });

  test('empty / malformed bundle does not throw and is unknown', () => {
    expect(() => computeVerdict(undefined)).not.toThrow();
    expect(computeVerdict({}).verdict).toBe('unknown');
  });
});

describe('labels + headline', () => {
  test('verdictLabel maps a verdict to its pr-verdict:* label', () => {
    expect(verdictLabel('mergeable')).toBe('pr-verdict:mergeable');
    expect(verdictLabel('check-failed')).toBe('pr-verdict:check-failed');
  });

  test('VERDICT_LABELS is the full reconcile set — one per verdict', () => {
    for (const v of VERDICTS) expect(VERDICT_LABELS).toContain(verdictLabel(v));
    expect(VERDICT_LABELS.length).toBe(VERDICTS.length);
  });

  test('verdictHeadline is a one-line human summary carrying the verdict', () => {
    const line = verdictHeadline(computeVerdict(makeBundle({ failing: ['Tests'] })));
    expect(line).toContain('check-failed');
    expect(line.toLowerCase()).toContain('tests');
  });
});
