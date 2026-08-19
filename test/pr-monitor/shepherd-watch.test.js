'use strict';

const { describe, test, expect } = require('bun:test');

const shepherd = require('../../lib/commands/shepherd');

function authorityDeps(overrides = {}) {
  const { owner: ownerOverrides = {}, ...rest } = overrides;
  const owner = {
    readMigrationGate: async () => ({ ok: true, changed: false, reason: 'read', gate: { state: 'complete' } }),
    reserveStarting: async () => ({
      ok: true,
      changed: true,
      reason: 'acquired',
      record: { generation: 'generation-1', startedAt: '2026-08-19T12:00:00.000Z' },
    }),
    ...ownerOverrides,
  };
  return {
    repository: 'acme/forge',
    dir: '/tmp/watch',
    gather: async () => ({ prState: 'OPEN' }),
    enrich: () => {},
    store: {},
    ownerOptions: { driver: {} },
    ...rest,
    owner,
  };
}

describe('forge shepherd watch <pr>', () => {
  test('routes `watch <pr>` to the watch loop and forwards its summary', async () => {
    let seen = null;
    const deps = authorityDeps({
      dir: '/tmp/journal-x',
      gather: async () => ({ prState: 'OPEN' }),
      enrich: () => {},
      emit: () => {},
      signal: { aborted: false }, // suppress real SIGINT/SIGTERM handlers
      maxPasses: 2,
      watchLoop: async (ctx) => { seen = ctx; return { started: true, passes: 2, stopped: true }; },
    });
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
    const deps = authorityDeps({
      dir: '/tmp/journal-y',
      gather: async () => ({ prState: 'OPEN' }),
      signal: { aborted: false },
      watchLoop: async () => ({ started: true, passes: 1, stopped: false }),
    });
    const res = await shepherd.handler(['watch', '77'], {}, '/repo', deps);
    expect(res.success).toBe(true);
    expect(res.passes).toBe(1);
  });

  test('surfaces a reason when a live watcher already owns the PR', async () => {
    const deps = authorityDeps({
      dir: '/tmp/journal-z',
      gather: async () => ({ prState: 'OPEN' }),
      signal: { aborted: false },
      owner: { reserveStarting: async () => ({ ok: false, changed: false, reason: 'busy', record: null }) },
      watchLoop: async () => { throw new Error('loop must not run'); },
    });
    const res = await shepherd.handleWatch(['watch', '5'], '/repo', deps);
    expect(res.success).toBe(true);
    expect(res.started).toBe(false);
    expect(res.reason).toBe('busy');
  });

  test('reopens a completed owner only from provider OPEN evidence', async () => {
    let reopened;
    const deps = authorityDeps({
      prState: 'OPEN',
      signal: { aborted: false },
      owner: {
        reserveStarting: async () => ({
          ok: false,
          reason: 'complete',
          record: { phase: 'complete', generation: 'old-generation', terminalReceiptId: 'receipt-1' },
        }),
        reserveReopened: async (identity, input) => {
          reopened = { identity, input };
          return { ok: true, record: { generation: 'new-generation' } };
        },
      },
      watchLoop: async (ctx) => ({
        started: true, passes: 0, stopped: false, generation: ctx.generation,
      }),
    });

    const res = await shepherd.handleWatch(['watch', '42'], '/repo', deps);

    expect(reopened.identity).toEqual({ repo: 'acme/forge', pr: 42 });
    expect(reopened.input).toEqual(expect.objectContaining({
      generation: 'old-generation',
      expectedReceiptId: 'receipt-1',
      providerEvidence: { state: 'OPEN' },
    }));
    expect(res.started).toBe(true);
  });

  test('a detached child binds the supplied reservation without reserving again', async () => {
    let seen;
    const deps = authorityDeps({
      signal: { aborted: false },
      owner: {
        reserveStarting: async () => { throw new Error('must not reserve in child'); },
      },
      watchLoop: async (ctx) => { seen = ctx; return { started: true, passes: 0, stopped: false }; },
    });

    const res = await shepherd.handleWatch([
      'watch', '42', '--repo', 'acme/forge', '--generation', 'generation-1',
      '--controller-pid', '101', '--started-at', '2026-08-19T12:00:00.000Z',
    ], '/repo', deps);

    expect(res.started).toBe(true);
    expect(seen).toEqual(expect.objectContaining({
      repo: 'acme/forge', pr: 42, generation: 'generation-1', controllerPid: 101,
    }));
  });

  test('rejects a missing PR argument with a usage error', async () => {
    const res = await shepherd.handleWatch(['watch'], '/repo', {});
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Usage: forge shepherd watch/);
  });
});
