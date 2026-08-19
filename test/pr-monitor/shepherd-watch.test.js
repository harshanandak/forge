'use strict';

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shepherd = require('../../lib/commands/shepherd');
const executor = require('../../lib/pr-monitor/reconcile-executor');
const journal = require('../../lib/pr-monitor/journal');

describe('forge shepherd watch <pr>', () => {
  test('routes `watch <pr>` to the watch loop and forwards its summary', async () => {
    let seen = null;
    const deps = {
      dir: '/tmp/journal-x',
      gather: async () => ({ prState: 'OPEN' }),
      enrich: () => {},
      emit: () => {},
      signal: { aborted: false }, // suppress real SIGINT/SIGTERM handlers
      maxPasses: 2,
      watchLoop: async (ctx) => { seen = ctx; return { started: true, passes: 2, stopped: true }; },
    };
    const res = await shepherd.handleWatch(['watch', '123'], '/repo', deps);
    expect(res.success).toBe(true);
    expect(res.started).toBe(true);
    expect(res.passes).toBe(2);
    expect(res.stopped).toBe(true);
    // No `output` field: the loop streams live to stdout (returning output double-prints).
    expect(res.output).toBeUndefined();
    // Context threaded straight through to the loop.
    expect(seen.dir).toBe('/tmp/journal-x');
    expect(seen.emit).toBe(deps.emit);
    expect(seen.signal).toBe(deps.signal);
    expect(typeof seen.gather).toBe('function');
    expect(await seen.terminalCleanupEvidence()).toEqual({ complete: false });
  });

  test('the top-level handler dispatches `watch` to handleWatch', async () => {
    const deps = {
      dir: '/tmp/journal-y',
      gather: async () => ({ prState: 'OPEN' }),
      signal: { aborted: false },
      watchLoop: async () => ({ started: true, passes: 1, stopped: false }),
    };
    const res = await shepherd.handler(['watch', '77'], {}, '/repo', deps);
    expect(res.success).toBe(true);
    expect(res.passes).toBe(1);
  });

  test('surfaces a reason when a live watcher already owns the PR', async () => {
    const deps = {
      dir: '/tmp/journal-z',
      gather: async () => ({ prState: 'OPEN' }),
      signal: { aborted: false },
      watchLoop: async () => ({ started: false, passes: 0, stopped: false, reason: 'watcher-already-running' }),
    };
    const res = await shepherd.handleWatch(['watch', '5'], '/repo', deps);
    expect(res.success).toBe(true);
    expect(res.started).toBe(false);
    expect(res.reason).toBe('watcher-already-running');
  });

  test('persists direct-watch generation cleanup that an absent-lease handoff accepts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-direct-watch-'));
    const gitCommonDir = path.join(root, '.git');
    const repo = 'owner/forge';
    const pr = 42;
    const startedAt = '2026-08-19T01:02:03.004Z';
    const dir = journal.journalDir({ root, gitCommonDir, repo, pr });
    const res = await shepherd.handleWatch(['watch', String(pr), '--started-at', startedAt], root, {
      dir,
      gather: async () => ({ prState: 'OPEN' }),
      context: { owner: 'owner', repo: 'forge', pr: String(pr) },
      gitCommonDir,
      signal: { aborted: false },
      now: () => Date.parse('2026-08-19T01:03:03.004Z'),
      watchLoop: async (ctx) => {
        expect(ctx.beforeClaim()).toBe(true);
        expect(executor.readClaimMarker(root, repo, pr, gitCommonDir)).toEqual({
          status: 'present', value: startedAt,
        });
        expect(await ctx.onTerminal()).toBe(true);
        expect(executor.readClaimMarker(root, repo, pr, gitCommonDir)).toMatchObject({ status: 'present' });
        expect(await ctx.releaseAuthority()).toBe(true);
        return { started: true, passes: 1, stopped: true, cleanupPersisted: true };
      },
    });
    expect(res.cleanupPersisted).toBe(true);
    expect(executor.readClaimMarker(root, repo, pr, gitCommonDir)).toEqual({ status: 'absent' });
    expect(await shepherd.terminalCleanupEvidence({
      owner: 'owner', repo: 'forge', pr, dir, projectRoot: root, gitCommonDir,
    }, {
      watcherRunning: () => false,
      inspectLease: () => ({ status: 'absent' }),
    })).toMatchObject({ complete: true, leaseCleanup: { status: 'released' } });
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('retains direct-watch authority when terminal cleanup proof cannot persist', async () => {
    const startedAt = '2026-08-19T01:02:03.004Z';
    let marker = null;
    let removed = false;
    await shepherd.handleWatch(['watch', '42', '--started-at', startedAt], '/repo', {
      dir: '/journal',
      gather: async () => ({ prState: 'OPEN' }),
      context: { owner: 'owner', repo: 'forge', pr: '42' },
      gitCommonDir: '/repo/.git',
      signal: { aborted: false },
      writeClaim: (_root, _repo, _pr, stamp) => { marker = stamp; return true; },
      writeCleanup: () => false,
      removeClaim: () => { removed = true; },
      watchLoop: async (ctx) => {
        expect(ctx.beforeClaim()).toBe(true);
        expect(await ctx.onTerminal()).toBe(false);
        return { started: true, passes: 1, stopped: true, cleanupPersisted: false };
      },
    });
    expect(marker).toBe(startedAt);
    expect(removed).toBe(false);
  });

  test('rejects a missing PR argument with a usage error', async () => {
    const res = await shepherd.handleWatch(['watch'], '/repo', {});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Usage: forge shepherd watch/);
  });
});
