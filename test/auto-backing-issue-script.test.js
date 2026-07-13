'use strict';

const { describe, test, expect } = require('bun:test');

const { run } = require('../scripts/auto-backing-issue');

const okDeps = (ensure) => ({
  projectRoot: '/r',
  existsSync: () => true,
  getBranch: () => 'feat/foo',
  buildDeps: () => ({ kernelDriver: {}, kernelBroker: {} }),
  ensureBackingIssue: ensure,
});

describe('pre-push auto-backing-issue script (run)', () => {
  test('invokes ensureBackingIssue with the pushed branch', async () => {
    let seen = null;
    const result = await run(okDeps((a) => { seen = a; return { issueId: 'x', branch: a.branch, created: true }; }));
    expect(seen.branch).toBe('feat/foo');
    expect(result.created).toBe(true);
  });

  test('skips on a detached HEAD / empty branch', async () => {
    let called = false;
    const result = await run({ ...okDeps(() => { called = true; }), getBranch: () => '' });
    expect(called).toBe(false);
    expect(result).toBeNull();
  });

  test('is non-blocking: a throwing ensure degrades to null (never propagates)', async () => {
    const result = await run(okDeps(() => { throw new Error('kernel down'); }));
    expect(result).toBeNull();
  });

  test('skips when there is no .git (best-effort, no repo)', async () => {
    let called = false;
    const result = await run({ ...okDeps(() => { called = true; }), existsSync: () => false });
    expect(called).toBe(false);
    expect(result).toBeNull();
  });
});
