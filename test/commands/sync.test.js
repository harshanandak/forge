'use strict';

const { describe, test, expect } = require('bun:test');

// ---------------------------------------------------------------------------
// forge sync command — test/commands/sync.test.js
//
// `forge sync` routes through the SyncBackend seam (lib/sync-backend.js). The
// default backend is `local-noop`: the local kernel is single-machine
// authority, so sync is a graceful no-op that names the model. These tests
// cover the command wiring, not the (future) git-jsonl/server transports.
// ---------------------------------------------------------------------------

describe('forge sync command', () => {
  // (a) Module exports correct shape
  test('exports name, description, usage, flags, and handler', () => {
    const mod = require('../../lib/commands/sync');
    expect(mod.name).toBe('sync');
    expect(typeof mod.description).toBe('string');
    expect(mod.usage).toBe('forge sync');
    expect(mod.flags).toEqual({});
    expect(typeof mod.handler).toBe('function');
  });

  // (b) Default local-noop: graceful no-op that names the model
  test('returns a graceful no-op by default (local-noop)', async () => {
    const mod = require('../../lib/commands/sync');
    const result = await mod.handler([], {}, '/fake/root');
    expect(result.success).toBe(true);
    expect(result.synced).toBe(false);
    expect(result.message).toContain('single-machine authority');
  });

  // (c) Delegates to the resolved/injected backend and returns its result
  test('returns the backend.sync() result verbatim', async () => {
    const mod = require('../../lib/commands/sync');
    const fakeBackend = {
      name: 'fake',
      async sync(opts) {
        return { success: true, synced: true, message: `synced ${opts.projectRoot}` };
      },
    };
    const result = await mod.handler([], {}, '/fake/root', { _backend: fakeBackend });
    expect(result).toEqual({ success: true, synced: true, message: 'synced /fake/root' });
  });

  // (d) A throwing backend is reported as a failure, never a crash
  test('returns { success: false } when the backend throws', async () => {
    const mod = require('../../lib/commands/sync');
    const fakeBackend = {
      name: 'fake',
      async sync() {
        throw new Error('transport exploded');
      },
    };
    const result = await mod.handler([], {}, '/fake/root', { _backend: fakeBackend });
    expect(result.success).toBe(false);
    expect(result.synced).toBe(false);
    expect(result.error).toContain('transport exploded');
  });

  // (e) Selecting an unimplemented backend surfaces an honest error
  test('returns a clear error when an unimplemented backend is selected', async () => {
    const mod = require('../../lib/commands/sync');
    const result = await mod.handler([], {}, '/fake/root', {
      deps: { syncBackend: 'git-jsonl' },
    });
    expect(result.success).toBe(false);
    expect(result.synced).toBe(false);
    expect(result.error).toContain('not implemented');
  });
});
