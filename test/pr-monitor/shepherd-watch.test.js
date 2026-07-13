'use strict';

const { describe, test, expect } = require('bun:test');

const shepherd = require('../../lib/commands/shepherd');

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

  test('rejects a missing PR argument with a usage error', async () => {
    const res = await shepherd.handleWatch(['watch'], '/repo', {});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Usage: forge shepherd watch/);
  });
});
