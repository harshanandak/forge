'use strict';

const { describe, test, expect } = require('bun:test');

const worktree = require('../lib/commands/worktree');
const { autoFileBackingIssue } = worktree._internal;

// Fake kernel driver/broker so the helper never builds a real kernel; a fake `_fs`
// makes the `.git` existence check pass without a repo.
const FAKE_DRIVER = { registerWorktree() {}, listWorktrees() { return []; } };
const FAKE_BROKER = { runIssueOperation() { return { ok: true }; } };
const FAKE_FS = { existsSync: () => true };

function baseOpts(overrides) {
  return { _kernelDriver: FAKE_DRIVER, _kernelBroker: FAKE_BROKER, _fs: FAKE_FS, ...overrides };
}

describe('worktree auto-file rail (autoFileBackingIssue)', () => {
  test('invokes ensureBackingIssue with the branch when no --issue is set', async () => {
    let seen = null;
    const opts = baseOpts({ _ensureBackingIssue: (args) => { seen = args; return { issueId: 'x', branch: args.branch, created: true }; } });
    const result = await autoFileBackingIssue({ projectRoot: '/r', worktreePath: '/r/wt', branch: 'feat/foo', issueId: null, opts });
    expect(seen).not.toBeNull();
    expect(seen.branch).toBe('feat/foo');
    expect(result.created).toBe(true);
  });

  test('skips entirely when an explicit --issue already links a real issue', async () => {
    let called = false;
    const opts = baseOpts({ _ensureBackingIssue: () => { called = true; return {}; } });
    const result = await autoFileBackingIssue({ projectRoot: '/r', worktreePath: '/r/wt', branch: 'feat/foo', issueId: 'ISSUE-1', opts });
    expect(called).toBe(false);
    expect(result).toBeNull();
  });

  test('is non-blocking: a throwing ensure degrades to null (never propagates)', async () => {
    const opts = baseOpts({ _ensureBackingIssue: () => { throw new Error('kernel exploded'); } });
    const result = await autoFileBackingIssue({ projectRoot: '/r', worktreePath: '/r/wt', branch: 'feat/foo', issueId: null, opts });
    expect(result).toBeNull();
  });

  test('idempotent pass-through: an existing link is returned, not duplicated', async () => {
    const opts = baseOpts({ _ensureBackingIssue: () => ({ issueId: 'x', branch: 'feat/foo', created: false, existed: true }) });
    const result = await autoFileBackingIssue({ projectRoot: '/r', worktreePath: '/r/wt', branch: 'feat/foo', issueId: null, opts });
    expect(result.existed).toBe(true);
    expect(result.created).toBe(false);
  });
});
