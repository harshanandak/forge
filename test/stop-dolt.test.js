'use strict';

const { describe, test, expect } = require('bun:test');

// ---------------------------------------------------------------------------
// stopDolt utility — test/stop-dolt.test.js
// ---------------------------------------------------------------------------

describe('stopDolt utility', () => {
  // (a) Tries bd dolt stop first
  test('tries bd dolt stop as first method', () => {
    const { stopDolt } = require('../lib/commands/worktree');
    const calls = [];
    const mockExec = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      return Buffer.from('');
    };
    const mockFs = { readFileSync: () => '' };

    const result = stopDolt('/fake/worktree', { _exec: mockExec, _fs: mockFs });
    expect(result.stopped).toBe(true);
    expect(result.method).toBe('bd-dolt-stop');
    expect(calls[0].cmd).toBe('bd');
    expect(calls[0].args).toEqual(['dolt', 'stop']);
  });

  // (b) Falls back to PID kill from lock file when bd fails
  test('falls back to PID kill from lock file when bd dolt stop fails', () => {
    const { stopDolt } = require('../lib/commands/worktree');
    const calls = [];
    const originalKill = process.kill;
    const killedPids = [];

    // Mock process.kill for non-Windows
    process.kill = (pid, signal) => { killedPids.push({ pid, signal }); };

    try {
      const mockExec = (cmd, args, _opts) => {
        calls.push({ cmd, args });
        if (cmd === 'bd') throw new Error('bd not found');
        return Buffer.from('');
      };
      const mockFs = {
        readFileSync: (p, _enc) => {
          if (p.includes('dolt-server.lock')) return '12345';
          throw new Error('ENOENT');
        },
      };

      const result = stopDolt('/fake/worktree', {
        _exec: mockExec,
        _fs: mockFs,
        _platform: 'linux',
      });
      expect(result.stopped).toBe(true);
      expect(result.method).toBe('pid-kill');
      expect(result.pid).toBe(12345);
      expect(killedPids[0]).toEqual({ pid: 12345, signal: 'SIGTERM' });
    } finally {
      process.kill = originalKill;
    }
  });

  // (c) Windows uses taskkill for PID kill
  test('uses taskkill on Windows for PID-based kill', () => {
    const { stopDolt } = require('../lib/commands/worktree');
    const calls = [];
    const mockExec = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      if (cmd === 'bd') throw new Error('bd not found');
      return Buffer.from('');
    };
    const mockFs = {
      readFileSync: (p, _enc) => {
        if (p.includes('dolt-server.lock')) return '9999';
        throw new Error('ENOENT');
      },
    };

    const result = stopDolt('/fake/worktree', {
      _exec: mockExec,
      _fs: mockFs,
      _platform: 'win32',
    });
    expect(result.stopped).toBe(true);
    expect(result.method).toBe('pid-kill');
    expect(result.pid).toBe(9999);
    // Should have called taskkill, not process.kill
    const taskkillCall = calls.find(c => c.cmd === 'taskkill');
    expect(taskkillCall).toBeTruthy();
    expect(taskkillCall.args).toEqual(['/F', '/PID', '9999']);
  });

  // (d) Returns { stopped: false, method: 'none' } when nothing works
  test('returns stopped false when all methods fail', () => {
    const { stopDolt } = require('../lib/commands/worktree');
    const mockExec = () => { throw new Error('fail'); };
    const mockFs = {
      readFileSync: () => { throw new Error('ENOENT'); },
    };

    const result = stopDolt('/fake/worktree', {
      _exec: mockExec,
      _fs: mockFs,
      _platform: 'linux',
    });
    expect(result.stopped).toBe(false);
    expect(result.method).toBe('none');
  });

  // (e) Returns correct shape { stopped, method }
  test('returns correct shape with stopped and method properties', () => {
    const { stopDolt } = require('../lib/commands/worktree');
    const mockExec = () => Buffer.from('');
    const mockFs = { readFileSync: () => '' };

    const result = stopDolt('/fake/worktree', { _exec: mockExec, _fs: mockFs });
    expect(result).toHaveProperty('stopped');
    expect(result).toHaveProperty('method');
    expect(typeof result.stopped).toBe('boolean');
    expect(typeof result.method).toBe('string');
  });

  // (f) Tries daemon.lock as fallback when dolt-server.lock is missing
  test('tries daemon.lock when dolt-server.lock is not found', () => {
    const { stopDolt } = require('../lib/commands/worktree');
    const calls = [];
    const originalKill = process.kill;
    const killedPids = [];
    process.kill = (pid, signal) => { killedPids.push({ pid, signal }); };

    try {
      const mockExec = (cmd, _args, _opts) => {
        calls.push(cmd);
        if (cmd === 'bd') throw new Error('bd not found');
        return Buffer.from('');
      };
      const mockFs = {
        readFileSync: (p, _enc) => {
          if (p.includes('dolt-server.lock')) throw new Error('ENOENT');
          if (p.includes('daemon.lock')) return '54321';
          throw new Error('ENOENT');
        },
      };

      const result = stopDolt('/fake/worktree', {
        _exec: mockExec,
        _fs: mockFs,
        _platform: 'linux',
      });
      expect(result.stopped).toBe(true);
      expect(result.pid).toBe(54321);
    } finally {
      process.kill = originalKill;
    }
  });

  // (g) Ignores NaN PID values in lock file
  test('ignores lock file with non-numeric content', () => {
    const { stopDolt } = require('../lib/commands/worktree');
    const mockExec = () => { throw new Error('fail'); };
    const mockFs = {
      readFileSync: (p, _enc) => {
        if (p.includes('dolt-server.lock')) return 'not-a-number';
        if (p.includes('daemon.lock')) return 'also-not-a-number';
        throw new Error('ENOENT');
      },
    };

    const result = stopDolt('/fake/worktree', {
      _exec: mockExec,
      _fs: mockFs,
      _platform: 'linux',
    });
    expect(result.stopped).toBe(false);
    expect(result.method).toBe('none');
  });
});
