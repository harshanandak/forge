'use strict';

const path = require('node:path');
const { describe, test, expect } = require('bun:test');
const { bootstrapBeads } = require('../lib/beads-bootstrap');

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
});
