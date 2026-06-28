'use strict';

const { describe, test, expect } = require('bun:test');

const { gatherPrBundle, buildCi, toUnresolvedComment } = require('../lib/pr-bundle');

/**
 * Build a fake pr-state adapter from a declarative spec. Mirrors the style of
 * test/pr-shepherd.test.js but exposes the fields the BUNDLE reads (mergeable,
 * thread path/line/threadId, detectConflicts). Optional methods can be dropped
 * via spec flags to exercise graceful degradation.
 */
function makeAdapter(spec = {}) {
  const calls = [];
  const adapter = {
    id: 'fake-pr-state',
    kind: 'pr-state',
    async readState(pr) {
      calls.push({ method: 'readState', pr });
      return {
        headSha: spec.headSha || 'sha-1',
        state: spec.state || 'OPEN',
        mergeable: spec.mergeable || 'MERGEABLE',
        mergeStateStatus: spec.mergeStateStatus || 'CLEAN',
        checks: spec.checks || [],
        threads: [],
      };
    },
    async readRequiredChecks(args) {
      calls.push({ method: 'readRequiredChecks', ...args });
      if (spec.requiredThrows) throw spec.requiredThrows;
      return spec.required === undefined ? [] : spec.required;
    },
    async readDivergence(args) {
      calls.push({ method: 'readDivergence', ...args });
      return { behind: spec.behind || 0, ahead: spec.ahead || 0 };
    },
    async rerunFailedChecks() {},
    async replyToThread() {},
  };
  if (!spec.noComments) {
    adapter.readComments = async (args) => {
      calls.push({ method: 'readComments', ...args });
      if (spec.commentsThrow) throw spec.commentsThrow;
      return spec.threads || [];
    };
  }
  if (!spec.noConflicts) {
    adapter.detectConflicts = async (args) => {
      calls.push({ method: 'detectConflicts', ...args });
      if (spec.conflictsThrow) throw spec.conflictsThrow;
      return spec.conflicts || { supported: true, conflicted: false, files: [] };
    };
  }
  return { adapter, calls };
}

const BASE_CTX = {
  pr: '123', owner: 'o', repo: 'r', base: 'master', baseRef: 'origin/master', cwd: '/wt',
};

describe('gatherPrBundle — complete PR-state gather', () => {
  test('aggregates merge state, ci, branch and conflicts into one object', async () => {
    const { adapter } = makeAdapter({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      state: 'OPEN',
      required: ['unit', 'lint'],
      checks: [
        { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'u1' },
        { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'u2' },
        { name: 'bench', status: 'IN_PROGRESS', conclusion: '' },
      ],
      behind: 2,
      ahead: 5,
      conflicts: { supported: true, conflicted: true, files: ['a.js'] },
    });
    const bundle = await gatherPrBundle({ ...BASE_CTX, adapter });

    expect(bundle.pr).toBe('123');
    expect(bundle.mergeState).toEqual({
      mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', state: 'OPEN',
    });
    expect(bundle.branch).toEqual({ ahead: 5, behind: 2 });
    expect(bundle.conflicts).toEqual({ supported: true, conflicted: true, files: ['a.js'] });
    expect(bundle.ci.checks).toHaveLength(3);
  });

  test('required-check tagging marks membership and splits failing/pending', async () => {
    const { adapter } = makeAdapter({
      required: ['unit', 'lint'],
      checks: [
        { name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'bench', status: 'IN_PROGRESS', conclusion: '' }, // optional + pending
      ],
    });
    const { ci } = await gatherPrBundle({ ...BASE_CTX, adapter });

    expect(ci.checks.find((c) => c.name === 'unit').required).toBe(true);
    expect(ci.checks.find((c) => c.name === 'lint').required).toBe(true);
    expect(ci.checks.find((c) => c.name === 'bench').required).toBe(false);
    expect(ci.failing.map((c) => c.name)).toEqual(['lint']);
    expect(ci.pending.map((c) => c.name)).toEqual(['bench']);
  });

  test('unresolved filtering keeps any author and drops resolved threads', async () => {
    const { adapter } = makeAdapter({
      threads: [
        {
          threadId: 'T1', path: 'src/a.js', line: 10, isResolved: false,
          comments: [{ author: 'coderabbitai', body: 'nit: rename' }],
        },
        {
          threadId: 'T2', path: 'src/b.js', line: 20, isResolved: true,
          comments: [{ author: 'human', body: 'already fixed' }],
        },
        {
          threadId: 'T3', path: 'src/c.js', line: 30, isResolved: false,
          comments: [{ author: 'some-human', body: 'please change' }],
        },
      ],
    });
    const { unresolvedComments } = await gatherPrBundle({ ...BASE_CTX, adapter });

    expect(unresolvedComments).toHaveLength(2);
    expect(unresolvedComments.map((c) => c.threadId)).toEqual(['T1', 'T3']);
    // bot author is retained (any author), unlike the shepherd's human-only filter
    expect(unresolvedComments[0]).toEqual({
      author: 'coderabbitai', path: 'src/a.js', line: 10, body: 'nit: rename', threadId: 'T1',
    });
  });

  test('required set null (unreadable) → required is null per check, never false', async () => {
    const { adapter } = makeAdapter({
      required: null,
      checks: [{ name: 'unit', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    });
    const { ci } = await gatherPrBundle({ ...BASE_CTX, adapter });
    expect(ci.checks[0].required).toBeNull();
  });

  test('passes the base BRANCH name (not baseRef) to readRequiredChecks', async () => {
    const { adapter, calls } = makeAdapter({ required: [] });
    await gatherPrBundle({ ...BASE_CTX, adapter });
    const reqCall = calls.find((c) => c.method === 'readRequiredChecks');
    expect(reqCall.base).toBe('master');
    expect(reqCall.base).not.toBe('origin/master');
  });

  test('degrades gracefully when readComments / detectConflicts are absent', async () => {
    const { adapter } = makeAdapter({ noComments: true, noConflicts: true });
    const bundle = await gatherPrBundle({ ...BASE_CTX, adapter });
    expect(bundle.unresolvedComments).toEqual([]);
    expect(bundle.conflicts.supported).toBe(false);
  });

  test('a throwing readComments does not collapse the bundle', async () => {
    const { adapter } = makeAdapter({ commentsThrow: new Error('graphql boom'), required: [] });
    const bundle = await gatherPrBundle({ ...BASE_CTX, adapter });
    expect(bundle.unresolvedComments).toEqual([]);
    expect(bundle.mergeState.mergeable).toBe('MERGEABLE');
  });

  test('a throwing detectConflicts is reported as unsupported', async () => {
    const { adapter } = makeAdapter({ conflictsThrow: new Error('merge-tree boom'), required: [] });
    const bundle = await gatherPrBundle({ ...BASE_CTX, adapter });
    expect(bundle.conflicts.supported).toBe(false);
    expect(bundle.conflicts.reason).toContain('merge-tree boom');
  });

  test('throws when no readState-capable adapter is provided', async () => {
    await expect(gatherPrBundle({ ...BASE_CTX, adapter: {} })).rejects.toThrow(/readState/);
  });
});

describe('buildCi / toUnresolvedComment helpers', () => {
  test('buildCi treats NEUTRAL/SKIPPED as green (not failing, not pending)', () => {
    const ci = buildCi([
      { name: 'a', conclusion: 'NEUTRAL' },
      { name: 'b', conclusion: 'SKIPPED' },
    ], ['a']);
    expect(ci.failing).toHaveLength(0);
    expect(ci.pending).toHaveLength(0);
  });

  test('toUnresolvedComment uses the thread opener and tolerates missing fields', () => {
    const mapped = toUnresolvedComment({ comments: [{ author: 'x', body: 'hi' }] });
    expect(mapped).toEqual({
      author: 'x', path: null, line: null, body: 'hi', threadId: null,
    });
  });
});
