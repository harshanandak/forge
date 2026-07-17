'use strict';

const { describe, test, expect } = require('bun:test');

const push = require('../../lib/commands/push');
const shepherd = require('../../lib/commands/shepherd');

const { maybeArmWatcherAfterPush } = push._internal;

// Gap 1 (epic c2d398e5, refs cf8361bc): arm the constant PR watcher on ANY open
// PR, not just `forge ship`. `forge push` arms the current branch's open PR;
// `forge shepherd watch --adopt` arms every open PR. Both reuse the existing
// startPrWatcherDetached, are gated by rail.auto_shepherd, and NEVER throw into
// the push/adopt path.

describe('maybeArmWatcherAfterPush (forge push wiring)', () => {
  test('arms the watcher when the rail is on and an open PR exists', () => {
    const calls = [];
    const r = maybeArmWatcherAfterPush({
      projectRoot: '/r', execFn: () => '',
      startWatcher: (opts) => { calls.push(opts); return { started: true, pid: 1 }; },
      railEnabled: () => true,
      prLookup: () => 42,
    });
    expect(r.armed).toBe(true);
    expect(r.prNumber).toBe(42);
    expect(calls).toHaveLength(1);
    expect(calls[0].prNumber).toBe(42);
    expect(calls[0].cwd).toBe('/r');
  });

  test('skips when there is no open PR for the branch', () => {
    let called = false;
    const r = maybeArmWatcherAfterPush({
      projectRoot: '/r', execFn: () => '',
      startWatcher: () => { called = true; return { started: true }; },
      railEnabled: () => true,
      prLookup: () => null,
    });
    expect(called).toBe(false);
    expect(r.armed).toBe(false);
    expect(r.reason).toBe('no-open-pr');
  });

  test('skips when rail.auto_shepherd is disabled', () => {
    let called = false;
    const r = maybeArmWatcherAfterPush({
      projectRoot: '/r', execFn: () => '',
      startWatcher: () => { called = true; return { started: true }; },
      railEnabled: () => false,
      prLookup: () => 42,
    });
    expect(called).toBe(false);
    expect(r.armed).toBe(false);
    expect(r.reason).toMatch(/rail\.auto_shepherd/);
  });

  test('never throws when the PR lookup throws — push must survive', () => {
    const r = maybeArmWatcherAfterPush({
      projectRoot: '/r', execFn: () => '',
      startWatcher: () => ({ started: true }),
      railEnabled: () => true,
      prLookup: () => { throw new Error('gh boom'); },
    });
    expect(r.armed).toBe(false);
    expect(r.reason).toMatch(/gh boom/);
  });

  test('never throws when the watcher spawn throws', () => {
    const r = maybeArmWatcherAfterPush({
      projectRoot: '/r', execFn: () => '',
      startWatcher: () => { throw new Error('spawn boom'); },
      railEnabled: () => true,
      prLookup: () => 7,
    });
    expect(r.armed).toBe(false);
    expect(r.reason).toMatch(/spawn boom/);
  });
});

describe('forge shepherd watch --adopt', () => {
  test('arms a detached watcher for every open PR', async () => {
    const calls = [];
    const res = await shepherd.handler(['watch', '--adopt'], {}, '/r', {
      listOpenPrs: () => [10, 11, 12],
      startWatcher: (opts) => { calls.push(opts.prNumber); return { started: true }; },
    });
    expect(res.success).toBe(true);
    expect(calls.sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect(res.adopted.sort((a, b) => a - b)).toEqual([10, 11, 12]);
    expect(res.total).toBe(3);
  });

  test('does NOT double-arm an already-running watcher (idempotent)', async () => {
    const res = await shepherd.handler(['watch', '--adopt'], {}, '/r', {
      listOpenPrs: () => [5, 6],
      // PR 6 already has a running watcher → startWatcher reports not started.
      startWatcher: (opts) => ({ started: opts.prNumber === 5 }),
    });
    expect(res.adopted).toEqual([5]);
    expect(res.total).toBe(2);
  });

  test('is fail-open when listing open PRs throws', async () => {
    const res = await shepherd.handler(['watch', '--adopt'], {}, '/r', {
      listOpenPrs: () => { throw new Error('gh down'); },
      startWatcher: () => ({ started: true }),
    });
    expect(res.success).toBe(true);
    expect(res.adopted).toEqual([]);
  });

  test('one bad arm never blocks the rest', async () => {
    const res = await shepherd.handler(['watch', '--adopt'], {}, '/r', {
      listOpenPrs: () => [1, 2, 3],
      startWatcher: (opts) => {
        if (opts.prNumber === 2) throw new Error('arm 2 failed');
        return { started: true };
      },
    });
    expect(res.adopted.sort((a, b) => a - b)).toEqual([1, 3]);
  });

  test('is a no-op when rail.auto_shepherd is disabled — no listing, no spawn', async () => {
    let listed = false;
    let spawned = false;
    const res = await shepherd.handler(['watch', '--adopt'], {}, '/r', {
      railEnabled: () => false,
      listOpenPrs: () => { listed = true; return [1, 2, 3]; },
      startWatcher: () => { spawned = true; return { started: true }; },
    });
    expect(listed).toBe(false);
    expect(spawned).toBe(false);
    expect(res.success).toBe(true);
    expect(res.adopted).toEqual([]);
    expect(res.total).toBe(0);
    expect(res.reason).toMatch(/rail\.auto_shepherd/);
  });
});
