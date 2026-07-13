'use strict';

const { describe, test, expect } = require('bun:test');

const push = require('../lib/commands/push');
const { autoFileBackingIssueForPush } = push._internal;

const FAKE_DRIVER = { registerWorktree() {}, listWorktrees() { return []; } };
const FAKE_BROKER = { runIssueOperation() { return { ok: true }; } };

// execFileSync mock returning canned git output; records the git subcommands seen.
function fakeExec(branch = 'feat/foo') {
  return (cmd, args) => {
    if (cmd === 'git' && args[0] === 'branch') return `${branch}\n`;
    if (cmd === 'git' && args[0] === 'rev-list') return '2\n';
    return '';
  };
}

describe('push auto-file rail (autoFileBackingIssueForPush)', () => {
  test('invokes ensureBackingIssue with the current branch', async () => {
    let seen = null;
    const deps = {
      _kernelDriver: FAKE_DRIVER,
      _kernelBroker: FAKE_BROKER,
      _ensureBackingIssue: (a) => { seen = a; return { issueId: 'x', branch: a.branch, created: true }; },
    };
    const result = await autoFileBackingIssueForPush('/r', fakeExec('feat/bar'), deps);
    expect(seen.branch).toBe('feat/bar');
    expect(result.created).toBe(true);
  });

  test('is non-blocking: a throwing ensure degrades to null', async () => {
    const deps = {
      _kernelDriver: FAKE_DRIVER,
      _kernelBroker: FAKE_BROKER,
      _ensureBackingIssue: () => { throw new Error('boom'); },
    };
    expect(await autoFileBackingIssueForPush('/r', fakeExec(), deps)).toBeNull();
  });

  test('degrades to null (no throw) when kernel is unavailable, nothing injected', async () => {
    // No _ensureBackingIssue / driver / broker; '/no/such/repo/.git' does not exist.
    // Confirms the reorganized require-inside-try never aborts a push (CodeRabbit #370).
    expect(await autoFileBackingIssueForPush('/no/such/repo', fakeExec('feat/foo'), {})).toBeNull();
  });

  test("returns null on an unresolved branch ('unknown')", async () => {
    const deps = { _kernelDriver: FAKE_DRIVER, _kernelBroker: FAKE_BROKER, _ensureBackingIssue: () => ({}) };
    const execUnknown = () => { throw new Error('no branch'); }; // getCurrentBranch → 'unknown'
    expect(await autoFileBackingIssueForPush('/r', execUnknown, deps)).toBeNull();
  });
});

describe('push handler wires the rail non-blockingly', () => {
  function pushDeps(ensureImpl) {
    return {
      execFileSync: fakeExec('feat/foo'),
      spawnSync: () => ({ status: 0 }),        // lint passes
      existsSync: () => false,                 // npm default; no lockfiles
      log: () => {},
      writeForgeToken: () => {},
      _kernelDriver: FAKE_DRIVER,
      _kernelBroker: FAKE_BROKER,
      _ensureBackingIssue: ensureImpl,
    };
  }

  test('a quick push invokes the rail and still pushes', async () => {
    let called = false;
    const res = await push.handler([], { '--quick': true }, '/r', pushDeps(() => { called = true; return { created: true }; }));
    expect(res.pushed).toBe(true);
    expect(called).toBe(true);
  });

  test('a throwing rail never aborts the push', async () => {
    const res = await push.handler([], { '--quick': true }, '/r', pushDeps(() => { throw new Error('kernel down'); }));
    expect(res.pushed).toBe(true);
    expect(res.success).toBe(true);
  });
});
