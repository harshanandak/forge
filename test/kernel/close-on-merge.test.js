'use strict';

// Unit tests for the close-on-merge linkage (kernel issue 18f1988e).
//
// The primitive is fully injectable: it talks to a kernel `driver` (for the
// branch->issue linkage registry) and a `runIssueOperation` runner (the supported
// issue-command path), both supplied here as in-memory fakes. No git repo, no
// sqlite DB, and no filesystem access — so nothing can leak onto a real drive.

const { describe, test, expect } = require('bun:test');

const {
  closeLinkedIssueOnMerge,
  buildMergeEvidence,
  buildCloseReason,
} = require('../../lib/kernel/close-on-merge');

const PR = Object.freeze({
  number: 452,
  title: 'fix(push): make --quick genuinely lint-only',
  mergeCommitOid: '535b84e4c7db37abe1622de9bacdb96766c63f1a',
});

// Driver stand-in exposing only listWorktrees (the linkage registry surface
// resolveActiveIssueId reads).
function makeDriver(rows = []) {
  return { listWorktrees: () => rows.slice() };
}

// Runner stand-in over an { id -> status } map. Records every call so tests can
// assert the exact operation/args sent to the supported issue-command path.
function makeRunner(statuses = {}, overrides = {}) {
  const calls = [];
  const state = { ...statuses };
  const runner = async (operation, args = []) => {
    calls.push({ operation, args });
    if (overrides[operation]) return overrides[operation](args, state);
    if (operation === 'show') {
      const id = args[0];
      if (!(id in state)) return { ok: false, error: 'not found' };
      return { ok: true, data: { id, status: state[id] } };
    }
    if (operation === 'comment') return { ok: true, data: { id: args[0] } };
    if (operation === 'close') {
      state[args[0]] = 'done';
      return { ok: true, data: { id: args[0] } };
    }
    return { ok: false };
  };
  return { runner, calls };
}

const LINKED_ROW = Object.freeze({
  branch: 'feat/widget',
  issue_id: 'issue-1',
  state: 'active',
});

function baseOpts(extra = {}) {
  return {
    branch: 'feat/widget',
    projectRoot: '/virtual/project',
    pr: PR,
    driver: makeDriver([LINKED_ROW]),
    ...extra,
  };
}

describe('buildMergeEvidence', () => {
  test('names the PR number, title and merge commit', () => {
    const body = buildMergeEvidence({ branch: 'feat/widget', pr: PR });
    expect(body).toContain('#452');
    expect(body).toContain('fix(push): make --quick genuinely lint-only');
    expect(body).toContain('535b84e4c7db37abe1622de9bacdb96766c63f1a');
    expect(body).toContain('feat/widget');
  });

  test('stays honest when no PR was resolved (git-only merge detection)', () => {
    const body = buildMergeEvidence({ branch: 'feat/widget', pr: null });
    expect(body).toContain('feat/widget');
    expect(body).not.toContain('#');
    expect(body.toLowerCase()).toContain('no pull request');
  });
});

describe('buildCloseReason', () => {
  test('references the PR when known', () => {
    expect(buildCloseReason({ branch: 'feat/widget', pr: PR })).toContain('#452');
  });

  test('falls back to the branch when the PR is unknown', () => {
    const reason = buildCloseReason({ branch: 'feat/widget', pr: null });
    expect(reason).toContain('feat/widget');
    expect(reason).not.toContain('#');
  });
});

describe('closeLinkedIssueOnMerge', () => {
  test('comments the merge evidence and closes the linked issue', async () => {
    const { runner, calls } = makeRunner({ 'issue-1': 'open' });
    const result = await closeLinkedIssueOnMerge(baseOpts({ runIssueOperation: runner }));

    expect(result.closed).toBe(true);
    expect(result.issueId).toBe('issue-1');
    expect(result.commented).toBe(true);

    const comment = calls.find(c => c.operation === 'comment');
    expect(comment.args[0]).toBe('issue-1');
    expect(comment.args[1]).toContain('#452');
    expect(comment.args[1]).toContain('535b84e4c7db37abe1622de9bacdb96766c63f1a');

    const close = calls.find(c => c.operation === 'close');
    expect(close.args[0]).toBe('issue-1');
    expect(close.args).toContain('--reason');
  });

  test('closes issues that are in_progress, not just open', async () => {
    const { runner } = makeRunner({ 'issue-1': 'in_progress' });
    const result = await closeLinkedIssueOnMerge(baseOpts({ runIssueOperation: runner }));
    expect(result.closed).toBe(true);
  });

  // Linked-only: the merge evidence is never matched against an issue by title or
  // any other guess — an unlinked branch must leave the kernel untouched.
  test('leaves an unlinked branch alone and writes nothing', async () => {
    const { runner, calls } = makeRunner({ 'issue-1': 'open' });
    const result = await closeLinkedIssueOnMerge(baseOpts({
      driver: makeDriver([]),
      runIssueOperation: runner,
    }));

    expect(result.closed).toBe(false);
    expect(result.reason).toBe('not-linked');
    expect(calls).toHaveLength(0);
  });

  test('ignores a linkage row for a different branch', async () => {
    const { runner, calls } = makeRunner({ 'issue-1': 'open' });
    const result = await closeLinkedIssueOnMerge(baseOpts({
      driver: makeDriver([{ branch: 'feat/other', issue_id: 'issue-1', state: 'active' }]),
      runIssueOperation: runner,
    }));

    expect(result.closed).toBe(false);
    expect(result.reason).toBe('not-linked');
    expect(calls).toHaveLength(0);
  });

  test('ignores a superseded (non-active) linkage row', async () => {
    const { runner, calls } = makeRunner({ 'issue-1': 'open' });
    const result = await closeLinkedIssueOnMerge(baseOpts({
      driver: makeDriver([{ branch: 'feat/widget', issue_id: 'issue-1', state: 'retired' }]),
      runIssueOperation: runner,
    }));

    expect(result.closed).toBe(false);
    expect(result.reason).toBe('not-linked');
    expect(calls).toHaveLength(0);
  });

  // Idempotency: kernel terminal statuses are `done` / `cancelled` (verified
  // against `forge issue list --json`), NOT the literal 'closed'.
  for (const status of ['done', 'cancelled']) {
    test(`already-${status} issue is a no-op (no comment, no close)`, async () => {
      const { runner, calls } = makeRunner({ 'issue-1': status });
      const result = await closeLinkedIssueOnMerge(baseOpts({ runIssueOperation: runner }));

      expect(result.closed).toBe(false);
      expect(result.reason).toBe('already-closed');
      expect(result.issueId).toBe('issue-1');
      expect(calls.every(c => c.operation === 'show')).toBe(true);
    });
  }

  test('running twice closes exactly once', async () => {
    const { runner, calls } = makeRunner({ 'issue-1': 'open' });
    const opts = baseOpts({ runIssueOperation: runner });

    const first = await closeLinkedIssueOnMerge(opts);
    const second = await closeLinkedIssueOnMerge(opts);

    expect(first.closed).toBe(true);
    expect(second.closed).toBe(false);
    expect(second.reason).toBe('already-closed');
    expect(calls.filter(c => c.operation === 'close')).toHaveLength(1);
    expect(calls.filter(c => c.operation === 'comment')).toHaveLength(1);
  });

  // Never close blind: an unreadable issue must not be closed on assumption.
  test('does not close when the status read fails', async () => {
    const { runner, calls } = makeRunner({});
    const result = await closeLinkedIssueOnMerge(baseOpts({ runIssueOperation: runner }));

    expect(result.closed).toBe(false);
    expect(result.reason).toBe('read-failed');
    expect(calls.some(c => c.operation === 'close')).toBe(false);
  });

  test('still closes when the evidence comment fails', async () => {
    const { runner } = makeRunner({ 'issue-1': 'open' }, {
      comment: () => ({ ok: false, error: 'comment rejected' }),
    });
    const result = await closeLinkedIssueOnMerge(baseOpts({ runIssueOperation: runner }));

    expect(result.closed).toBe(true);
    expect(result.commented).toBe(false);
  });

  test('reports a failed close instead of claiming success', async () => {
    const { runner } = makeRunner({ 'issue-1': 'open' }, {
      close: () => ({ ok: false, error: 'kernel busy' }),
    });
    const result = await closeLinkedIssueOnMerge(baseOpts({ runIssueOperation: runner }));

    expect(result.closed).toBe(false);
    expect(result.reason).toBe('close-failed');
    expect(result.issueId).toBe('issue-1');
  });

  // Best-effort: a throwing kernel must degrade, never propagate into the caller
  // (`forge clean` must still remove worktrees when tracking is broken).
  test('swallows a throwing runner', async () => {
    const result = await closeLinkedIssueOnMerge(baseOpts({
      runIssueOperation: () => { throw new Error('kernel exploded'); },
    }));
    expect(result.closed).toBe(false);
    expect(result.reason).toBe('error');
  });

  test('swallows a throwing driver', async () => {
    const result = await closeLinkedIssueOnMerge(baseOpts({
      driver: { listWorktrees: () => { throw new Error('db locked'); } },
      runIssueOperation: async () => ({ ok: true, data: { status: 'open' } }),
    }));
    expect(result.closed).toBe(false);
    expect(['not-linked', 'error']).toContain(result.reason);
  });

  test('degrades when the kernel is unavailable', async () => {
    const withoutDriver = await closeLinkedIssueOnMerge(baseOpts({ driver: null, runIssueOperation: async () => ({ ok: true }) }));
    expect(withoutDriver.closed).toBe(false);
    expect(withoutDriver.reason).toBe('unavailable');

    const withoutRunner = await closeLinkedIssueOnMerge(baseOpts({ runIssueOperation: null }));
    expect(withoutRunner.closed).toBe(false);
    expect(withoutRunner.reason).toBe('unavailable');
  });

  test('skips a missing branch', async () => {
    const { runner, calls } = makeRunner({ 'issue-1': 'open' });
    const result = await closeLinkedIssueOnMerge(baseOpts({ branch: '', runIssueOperation: runner }));
    expect(result.closed).toBe(false);
    expect(result.reason).toBe('no-branch');
    expect(calls).toHaveLength(0);
  });

  test('closes with branch-only evidence when no PR was resolved', async () => {
    const { runner, calls } = makeRunner({ 'issue-1': 'open' });
    const result = await closeLinkedIssueOnMerge(baseOpts({ pr: null, runIssueOperation: runner }));

    expect(result.closed).toBe(true);
    const comment = calls.find(c => c.operation === 'comment');
    expect(comment.args[1]).toContain('feat/widget');
  });
});
