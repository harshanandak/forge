'use strict';

const { describe, test, expect } = require('bun:test');

const shepherd = require('../../lib/commands/shepherd');

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
