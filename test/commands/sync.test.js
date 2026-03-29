'use strict';

const { describe, test, expect } = require('bun:test');

// ---------------------------------------------------------------------------
// forge sync command — test/forge-sync.test.js
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

  // (b) Happy path: bd exists, dolt pull + push succeed
  test('returns { success: true, synced: true } when bd and dolt succeed', async () => {
    const mod = require('../../lib/commands/sync');
    const mockExec = (_cmd, args, _opts) => {
      if (args[0] === '--version') return Buffer.from('beads 1.0.0\n');
      if (args[0] === 'dolt' && args[1] === 'pull') return Buffer.from('ok\n');
      if (args[0] === 'dolt' && args[1] === 'push') return Buffer.from('ok\n');
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const result = await mod.handler([], {}, '/fake/root', { _exec: mockExec });
    expect(result).toEqual({ success: true, synced: true });
  });

  // (c) bd not found: execFileSync throws ENOENT on bd --version
  test('returns graceful skip when bd is not installed', async () => {
    const mod = require('../../lib/commands/sync');
    const mockExec = (_cmd, args, _opts) => {
      if (args[0] === '--version') {
        const err = new Error('spawn bd ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const result = await mod.handler([], {}, '/fake/root', { _exec: mockExec });
    expect(result.success).toBe(true);
    expect(result.synced).toBe(false);
    expect(result.message).toContain('not installed');
  });

  // (d) dolt pull fails: returns { success: false } with error containing 'pull'
  test('returns failure when dolt pull fails', async () => {
    const mod = require('../../lib/commands/sync');
    const mockExec = (_cmd, args, _opts) => {
      if (args[0] === '--version') return Buffer.from('beads 1.0.0\n');
      if (args[0] === 'dolt' && args[1] === 'pull') {
        throw new Error('dolt pull failed: connection refused');
      }
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const result = await mod.handler([], {}, '/fake/root', { _exec: mockExec });
    expect(result.success).toBe(false);
    expect(result.synced).toBe(false);
    expect(result.error).toContain('pull');
  });

  // (e) dolt push fails: returns { success: false } with error containing 'push'
  test('returns failure when dolt push fails', async () => {
    const mod = require('../../lib/commands/sync');
    const mockExec = (_cmd, args, _opts) => {
      if (args[0] === '--version') return Buffer.from('beads 1.0.0\n');
      if (args[0] === 'dolt' && args[1] === 'pull') return Buffer.from('ok\n');
      if (args[0] === 'dolt' && args[1] === 'push') {
        throw new Error('dolt push failed: auth error');
      }
      throw new Error(`unexpected call: ${args.join(' ')}`);
    };
    const result = await mod.handler([], {}, '/fake/root', { _exec: mockExec });
    expect(result.success).toBe(false);
    expect(result.synced).toBe(false);
    expect(result.error).toContain('push');
  });
});
