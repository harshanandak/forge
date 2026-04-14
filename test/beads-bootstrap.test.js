'use strict';

const path = require('node:path');
const { describe, test, expect } = require('bun:test');
const { bootstrapBeads, isRecoverableBeadsError } = require('../lib/beads-bootstrap');

function createMockSafeBeadsInit() {
  return (root, options) => {
    try {
      options.execBdInit(root);
      return { success: true, skipped: false, warnings: [], errors: [] };
    } catch (error) {
      return { success: false, skipped: false, warnings: [], errors: [error.message] };
    }
  };
}

describe('bootstrapBeads', () => {
  test('returns a warning instead of throwing when EPERM fallback cannot run bd init', () => {
    const calls = [];
    const mockExec = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      if (cmd === 'bd' && args[0] === 'init') {
        throw new Error('spawn bd ENOENT');
      }
      if (cmd === 'git' && args[0] === 'rev-parse') {
        return '.git';
      }
      return '';
    };
    const mockFs = {
      existsSync: (targetPath) => targetPath === path.resolve('/main', '.beads'),
      rmSync: () => {},
      symlinkSync: () => {
        const err = new Error('Operation not permitted');
        err.code = 'EPERM';
        throw err;
      },
    };

    const result = bootstrapBeads('/worktree', {
      _exec: mockExec,
      _fs: mockFs,
      _platform: 'linux',
      mainProjectRoot: '/main',
      _safeBeadsInit: createMockSafeBeadsInit(),
    });

    expect(result).toEqual({
      success: false,
      strategy: 'fresh-init-failed',
      warning: 'Beads bootstrap fresh init failed: spawn bd ENOENT'
    });
    expect(calls).toContainEqual({
      cmd: 'bd',
      args: ['init', '--force']
    });
  });

  test('passes metadata-derived database name to bd init during EPERM fallback', () => {
    const calls = [];
    let safeInitCall;
    const mockExec = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'bd' && args[0] === 'init') {
        return '';
      }
      if (cmd === 'git' && args[0] === 'rev-parse') {
        return '.git';
      }
      throw new Error(`unexpected exec ${cmd}`);
    };
    const mockFs = {
      existsSync: (targetPath) => {
        return [
          path.resolve('/main', '.beads'),
          path.resolve('/main', '.beads', 'metadata.json')
        ].includes(targetPath);
      },
      readFileSync: (targetPath) => {
        if (targetPath === path.resolve('/main', '.beads', 'metadata.json')) {
          return JSON.stringify({ dolt_database: 'forge-shared-db' });
        }
        throw new Error(`unexpected read ${targetPath}`);
      },
      readdirSync: () => [],
      rmSync: () => {},
      symlinkSync: () => {
        const err = new Error('Operation not permitted');
        err.code = 'EPERM';
        throw err;
      },
    };

    const result = bootstrapBeads('/worktree', {
      _exec: mockExec,
      _fs: mockFs,
      _platform: 'linux',
      mainProjectRoot: '/main',
      _safeBeadsInit: (root, options) => {
        safeInitCall = { root, options };
        options.execBdInit(root);
        return { success: true, skipped: false, warnings: [], errors: [] };
      }
    });

    expect(result).toEqual({
      success: true,
      strategy: 'fresh-init',
      warning: 'Beads bootstrap initialized fresh (no backup found)'
    });
    expect(safeInitCall.root).toBe('/worktree');
    expect(calls).toContainEqual({
      cmd: 'bd',
      args: ['init', '--force', '--database', 'forge-shared-db']
    });
  });

  test('does not treat metadata.database backend field as the recovery database name', () => {
    const calls = [];
    const mockExec = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'bd' && args[0] === 'init') {
        return '';
      }
      if (cmd === 'git' && args[0] === 'rev-parse') {
        return '.git';
      }
      throw new Error(`unexpected exec ${cmd}`);
    };
    const mockFs = {
      existsSync: (targetPath) => {
        return [
          path.resolve('/main', '.beads'),
          path.resolve('/main', '.beads', 'metadata.json')
        ].includes(targetPath);
      },
      readFileSync: (targetPath) => {
        if (targetPath === path.resolve('/main', '.beads', 'metadata.json')) {
          return JSON.stringify({ database: 'dolt' });
        }
        throw new Error(`unexpected read ${targetPath}`);
      },
      readdirSync: () => [],
      rmSync: () => {},
      symlinkSync: () => {
        const err = new Error('Operation not permitted');
        err.code = 'EPERM';
        throw err;
      },
    };

    const result = bootstrapBeads('/worktree', {
      _exec: mockExec,
      _fs: mockFs,
      _platform: 'linux',
      mainProjectRoot: '/main',
      _safeBeadsInit: (root, options) => {
        options.execBdInit(root);
        return { success: true, skipped: false, warnings: [], errors: [] };
      }
    });

    expect(result).toEqual({
      success: true,
      strategy: 'fresh-init',
      warning: 'Beads bootstrap initialized fresh (no backup found)'
    });
    expect(calls).toContainEqual({
      cmd: 'bd',
      args: ['init', '--force']
    });
    expect(calls).not.toContainEqual({
      cmd: 'bd',
      args: ['init', '--force', '--database', 'dolt']
    });
  });

  test('restores an existing .beads directory when symlink bootstrap fails with a non-EPERM error', () => {
    const calls = [];
    const renames = [];
    const removed = [];
    const backupPath = path.resolve('/worktree', '.beads.bootstrap-backup');
    const mockExec = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'git' && args[0] === 'rev-parse') {
        return '.git';
      }
      throw new Error(`unexpected exec ${cmd}`);
    };
    const existing = new Set([
      path.resolve('/main', '.beads'),
      path.resolve('/worktree', '.beads'),
    ]);
    const mockFs = {
      existsSync: (targetPath) => existing.has(targetPath),
      renameSync: (fromPath, toPath) => {
        renames.push([fromPath, toPath]);
        existing.delete(fromPath);
        existing.add(toPath);
      },
      rmSync: (targetPath) => {
        removed.push(targetPath);
        existing.delete(targetPath);
      },
      symlinkSync: () => {
        const err = new Error('Read-only filesystem');
        err.code = 'EROFS';
        throw err;
      },
    };

    expect(() => bootstrapBeads('/worktree', {
      _exec: mockExec,
      _fs: mockFs,
      _platform: 'linux',
      mainProjectRoot: '/main',
    })).toThrow('Read-only filesystem');

    expect(renames).toEqual([
      [path.resolve('/worktree', '.beads'), backupPath],
      [backupPath, path.resolve('/worktree', '.beads')]
    ]);
    expect(removed).toEqual([]);
    expect(existing.has(path.resolve('/worktree', '.beads'))).toBe(true);
    expect(calls).toEqual([]);
  });

  test('clears a stale bootstrap-backup directory before staging the current .beads state', () => {
    const calls = [];
    const renames = [];
    const removed = [];
    const backupPath = path.resolve('/worktree', '.beads.bootstrap-backup');
    const mockExec = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'git' && args[0] === 'rev-parse') {
        return '.git';
      }
      throw new Error(`unexpected exec ${cmd}`);
    };
    const existing = new Set([
      path.resolve('/main', '.beads'),
      path.resolve('/worktree', '.beads'),
      backupPath,
    ]);
    const mockFs = {
      existsSync: (targetPath) => existing.has(targetPath),
      renameSync: (fromPath, toPath) => {
        renames.push([fromPath, toPath]);
        existing.delete(fromPath);
        existing.add(toPath);
      },
      rmSync: (targetPath) => {
        removed.push(targetPath);
        existing.delete(targetPath);
      },
      symlinkSync: () => {
        const err = new Error('Operation not permitted');
        err.code = 'EPERM';
        throw err;
      },
      readdirSync: () => [],
    };

    const result = bootstrapBeads('/worktree', {
      _exec: mockExec,
      _fs: mockFs,
      _platform: 'linux',
      mainProjectRoot: '/main',
      _safeBeadsInit: () => ({ success: true, skipped: true, warnings: [], errors: [] })
    });

    expect(result).toEqual({
      success: true,
      strategy: 'existing-state',
      warning: 'Beads bootstrap reused existing initialized state'
    });
    expect(removed).toEqual([backupPath]);
    expect(renames).toEqual([
      [path.resolve('/worktree', '.beads'), backupPath],
      [backupPath, path.resolve('/worktree', '.beads')]
    ]);
    expect(calls).toEqual([]);
  });

  test('skips backup restore when safeBeadsInit reports existing initialized state', () => {
    const calls = [];
    const mockExec = (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === 'git' && args[0] === 'rev-parse') {
        return '.git';
      }
      if (cmd === 'bd' && args[0] === 'backup' && args[1] === 'restore') {
        throw new Error('backup restore should not run');
      }
      return '';
    };
    const mockFs = {
      existsSync: (targetPath) => {
        return [
          path.resolve('/main', '.beads'),
          path.resolve('/worktree', '.beads')
        ].includes(targetPath);
      },
      renameSync: () => {},
      rmSync: () => {},
      symlinkSync: () => {
        const err = new Error('Operation not permitted');
        err.code = 'EPERM';
        throw err;
      },
      readdirSync: () => ['issues.jsonl'],
    };

    const result = bootstrapBeads('/worktree', {
      _exec: mockExec,
      _fs: mockFs,
      _platform: 'linux',
      mainProjectRoot: '/main',
      _safeBeadsInit: () => ({ success: true, skipped: true, warnings: [], errors: [] })
    });

    expect(result).toEqual({
      success: true,
      strategy: 'existing-state',
      warning: 'Beads bootstrap reused existing initialized state'
    });
    expect(calls).not.toContainEqual({
      cmd: 'bd',
      args: ['backup', 'restore', path.resolve('/main', '.beads', 'backup')]
    });
  });
});

describe('isRecoverableBeadsError', () => {
  test('matches missing database errors for metadata-driven database prefixes', () => {
    expect(isRecoverableBeadsError(new Error('database forge-shared-db not found'))).toBe(true);
  });
});
