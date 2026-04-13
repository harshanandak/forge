'use strict';

const path = require('node:path');
const { describe, test, expect } = require('bun:test');
const { bootstrapBeads, isRecoverableBeadsError } = require('../lib/beads-bootstrap');

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
});

describe('isRecoverableBeadsError', () => {
  test('matches missing database errors for metadata-driven database prefixes', () => {
    expect(isRecoverableBeadsError(new Error('database forge-shared-db not found'))).toBe(true);
  });
});
