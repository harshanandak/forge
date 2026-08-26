'use strict';

const { describe, test, expect } = require('bun:test');
const { EventEmitter } = require('node:events');

const { startPrWatcherDetached, defaultResolveSlug } = require('../../lib/pr-monitor/watch-lifecycle');
const { maybeTriggerShepherdAfterShip } = require('../../lib/commands/ship');

/** A fake detached child: records unref() and reports a pid. */
function fakeChild(pid = 4242) {
  let unrefd = false;
  return {
    pid,
    unref() { unrefd = true; },
    wasUnrefd() { return unrefd; },
  };
}

function ownerHarness(reservation = {}) {
  const record = {
    repo: 'harshanandak/forge', pr: 42, generation: 'generation-1', phase: 'starting',
    controllerPid: process.pid, watcherPid: null, startedAt: '2026-08-19T12:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z', heartbeatAt: null,
    terminalReceiptId: null, blockReason: null, legacyEvidenceHash: null,
  };
  return {
    readMigrationGate: async () => ({ ok: true, changed: false, reason: 'read', gate: { state: 'complete' } }),
    reserveStarting: async () => ({ ok: true, changed: true, reason: 'acquired', record, ...reservation }),
    abortStarting: async () => ({ ok: true, changed: true, reason: 'aborted', record: null }),
  };
}

describe('startPrWatcherDetached', () => {
  test('spawns a detached, unref\'d `shepherd watch <pr>` without running the loop inline', async () => {
    const calls = [];
    const child = fakeChild(999);
    const start = Date.now();
    const res = await startPrWatcherDetached({
      prNumber: 42,
      cwd: '/repo',
      repository: 'harshanandak/forge',
      owner: ownerHarness(),
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

  test('is a no-op when an owner row already owns the PR (spawn not called)', async () => {
    let spawned = false;
    const res = await startPrWatcherDetached({
      prNumber: 7,
      cwd: '/repo/.worktrees/feature',
      repository: 'harshanandak/forge',
      owner: ownerHarness({ ok: false, changed: false, reason: 'busy', record: { phase: 'running' } }),
      spawn: () => { spawned = true; return fakeChild(); },
    });
    expect(res.started).toBe(false);
    expect(res.reason).toBe('busy');
    expect(spawned).toBe(false);
  });

  test('spawns when the owner reservation succeeds', async () => {
    let spawned = false;
    const res = await startPrWatcherDetached({
      prNumber: 8,
      cwd: '/repo',
      repository: 'harshanandak/forge',
      owner: ownerHarness(),
      spawn: () => { spawned = true; return fakeChild(1234); },
    });
    expect(spawned).toBe(true);
    expect(res.started).toBe(true);
  });

  test('attaches an error listener so an ASYNC spawn error never crashes ship', async () => {
    // spawn() can emit 'error' (ENOENT/EACCES) AFTER returning; on an EventEmitter
    // with no 'error' listener that emit THROWS (would be an unhandled exception in
    // the ship process). The no-op listener we attach must absorb it.
    const child = new EventEmitter();
    child.pid = 555;
    child.unref = () => {};
    let abortRejectionConsumed = false;
    const owner = ownerHarness();
    owner.abortStarting = () => ({
      then(_resolve, reject) {
        abortRejectionConsumed = true;
        reject(new Error('owner authority unavailable'));
      },
    });
    const res = await startPrWatcherDetached({
      prNumber: 3, cwd: '/repo', repository: 'harshanandak/forge', owner, spawn: () => child,
    });
    expect(res.started).toBe(true);
    expect(child.listenerCount('error')).toBe(1);
    // With the listener present, a post-return async error is absorbed, not thrown.
    expect(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(abortRejectionConsumed).toBe(true);
  });

  test('never throws when spawn fails — degrades to not-started', async () => {
    const res = await startPrWatcherDetached({
      prNumber: 9,
      cwd: '/repo',
      repository: 'harshanandak/forge',
      owner: ownerHarness(),
      resolveSlug: () => null,
      spawn: () => { throw new Error('spawn EACCES'); },
    });
    expect(res.started).toBe(false);
    expect(res.reason).toMatch(/spawn EACCES/);
  });

  test('returns not-started (no spawn) when no PR number is given', async () => {
    let spawned = false;
    const res = await startPrWatcherDetached({ prNumber: undefined, spawn: () => { spawned = true; return fakeChild(); } });
    expect(res.started).toBe(false);
    expect(res.reason).toBe('no-pr');
    expect(spawned).toBe(false);
  });
});

describe('defaultResolveSlug', () => {
  test('extracts the canonical repository from an SSH remote url', () => {
    const slug = defaultResolveSlug({ cwd: '/repo', exec: () => 'git@github.com:harshanandak/forge.git\n' });
    expect(slug).toBe('harshanandak/forge');
  });

  test('extracts the canonical repository from an HTTPS remote url', () => {
    const slug = defaultResolveSlug({ cwd: '/repo', exec: () => 'https://github.com/harshanandak/forge\n' });
    expect(slug).toBe('harshanandak/forge');
  });

  test('returns null when the git command fails', () => {
    const slug = defaultResolveSlug({ cwd: '/repo', exec: () => { throw new Error('not a repo'); } });
    expect(slug).toBeNull();
  });
});

describe('maybeTriggerShepherdAfterShip (ship wiring)', () => {
  test('triggers the singleton after a real PR is created', () => {
    const calls = [];
    const res = maybeTriggerShepherdAfterShip({
      dryRun: false, projectRoot: '/repo',
      fireAndForget: (opts) => calls.push(opts),
    });
    expect(res.started).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ projectRoot: '/repo', dryRun: false });
  });

  test('does NOT start on a dry run', () => {
    let called = false;
    const res = maybeTriggerShepherdAfterShip({ dryRun: true, projectRoot: '/repo', fireAndForget: () => { called = true; } });
    expect(called).toBe(false);
    expect(res.started).toBe(false);
  });

  test('does not select a PR before triggering', () => {
    let called = false;
    const res = maybeTriggerShepherdAfterShip({ dryRun: false, projectRoot: '/repo', fireAndForget: () => { called = true; } });
    expect(called).toBe(true);
    expect(res.started).toBe(true);
  });

  test('never fails ship even if the singleton trigger throws', () => {
    const res = maybeTriggerShepherdAfterShip({
      dryRun: false, projectRoot: '/repo',
      fireAndForget: () => { throw new Error('boom'); },
    });
    // Swallowed → ship continues; the throw never propagates.
    expect(res.started).toBe(false);
    expect(res.reason).toMatch(/boom/);
  });
});
