'use strict';

const { describe, test, expect } = require('bun:test');

const { startPrWatcherDetached, defaultResolveSlug } = require('../../lib/pr-monitor/watch-lifecycle');
const { maybeStartPrWatcher } = require('../../lib/commands/ship');

/** A fake detached child: records unref() and reports a pid. */
function fakeChild(pid = 4242) {
  let unrefd = false;
  return {
    pid,
    unref() { unrefd = true; },
    wasUnrefd() { return unrefd; },
  };
}

describe('startPrWatcherDetached', () => {
  test('spawns a detached, unref\'d `shepherd watch <pr>` and returns synchronously', () => {
    const calls = [];
    const child = fakeChild(999);
    const start = Date.now();
    const res = startPrWatcherDetached({
      prNumber: 42,
      cwd: '/repo',
      resolveSlug: () => null, // skip the idempotency probe → straight to spawn
      spawn: (bin, args, opts) => { calls.push({ bin, args, opts }); return child; },
    });
    // Non-blocking: returns effectively immediately (no watch loop runs inline).
    expect(Date.now() - start).toBeLessThan(500);
    expect(res.started).toBe(true);
    expect(res.pid).toBe(999);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toContain('shepherd');
    expect(calls[0].args).toContain('watch');
    expect(calls[0].args).toContain('42');
    expect(calls[0].opts.detached).toBe(true);
    expect(calls[0].opts.stdio).toBe('ignore');
    expect(child.wasUnrefd()).toBe(true);
  });

  test('is a no-op when a live watcher already owns the PR (spawn not called)', () => {
    let spawned = false;
    const res = startPrWatcherDetached({
      prNumber: 7,
      cwd: '/repo',
      resolveSlug: () => 'forge',
      journal: {
        journalDir: () => '/repo/.forge/pr-monitor/forge-7',
        watcherRunning: () => true,
      },
      spawn: () => { spawned = true; return fakeChild(); },
    });
    expect(res.started).toBe(false);
    expect(res.reason).toBe('already-running');
    expect(spawned).toBe(false);
  });

  test('spawns when the slug resolves but no watcher is live yet', () => {
    let spawned = false;
    const res = startPrWatcherDetached({
      prNumber: 8,
      cwd: '/repo',
      resolveSlug: () => 'forge',
      journal: {
        journalDir: () => '/repo/.forge/pr-monitor/forge-8',
        watcherRunning: () => false,
      },
      spawn: () => { spawned = true; return fakeChild(1234); },
    });
    expect(spawned).toBe(true);
    expect(res.started).toBe(true);
  });

  test('never throws when spawn fails — degrades to not-started', () => {
    const res = startPrWatcherDetached({
      prNumber: 9,
      cwd: '/repo',
      resolveSlug: () => null,
      spawn: () => { throw new Error('spawn EACCES'); },
    });
    expect(res.started).toBe(false);
    expect(res.reason).toMatch(/spawn EACCES/);
  });

  test('returns not-started (no spawn) when no PR number is given', () => {
    let spawned = false;
    const res = startPrWatcherDetached({ prNumber: undefined, spawn: () => { spawned = true; return fakeChild(); } });
    expect(res.started).toBe(false);
    expect(res.reason).toBe('no-pr');
    expect(spawned).toBe(false);
  });
});

describe('defaultResolveSlug', () => {
  test('extracts the bare repo name from an SSH remote url', () => {
    const slug = defaultResolveSlug({ cwd: '/repo', exec: () => 'git@github.com:harshanandak/forge.git\n' });
    expect(slug).toBe('forge');
  });

  test('extracts the bare repo name from an HTTPS remote url', () => {
    const slug = defaultResolveSlug({ cwd: '/repo', exec: () => 'https://github.com/harshanandak/forge\n' });
    expect(slug).toBe('forge');
  });

  test('returns null when the git command fails', () => {
    const slug = defaultResolveSlug({ cwd: '/repo', exec: () => { throw new Error('not a repo'); } });
    expect(slug).toBeNull();
  });
});

describe('maybeStartPrWatcher (ship wiring)', () => {
  test('starts the watcher with the PR number after a real PR is created', () => {
    const calls = [];
    const res = maybeStartPrWatcher({
      dryRun: false, prNumber: 373,
      startWatcher: (opts) => { calls.push(opts); return { started: true, pid: 1 }; },
    });
    expect(res.started).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].prNumber).toBe(373);
    expect(typeof calls[0].cwd).toBe('string');
  });

  test('does NOT start on a dry run', () => {
    let called = false;
    const res = maybeStartPrWatcher({ dryRun: true, prNumber: 5, startWatcher: () => { called = true; } });
    expect(called).toBe(false);
    expect(res.started).toBe(false);
  });

  test('does NOT start when there is no PR number', () => {
    let called = false;
    const res = maybeStartPrWatcher({ dryRun: false, prNumber: undefined, startWatcher: () => { called = true; } });
    expect(called).toBe(false);
    expect(res.started).toBe(false);
  });

  test('never fails ship even if the watcher start throws', () => {
    const res = maybeStartPrWatcher({
      dryRun: false, prNumber: 9,
      startWatcher: () => { throw new Error('boom'); },
    });
    // Swallowed → ship continues; the throw never propagates.
    expect(res.started).toBe(false);
    expect(res.reason).toMatch(/boom/);
  });
});
