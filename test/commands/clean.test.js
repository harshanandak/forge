'use strict';

const path = require('node:path');
const { describe, test, expect } = require('bun:test');

// ---------------------------------------------------------------------------
// forge clean command — test/forge-clean.test.js
// ---------------------------------------------------------------------------

describe('forge clean command', () => {
  // (a) Module exports correct shape
  test('exports name, description, usage, flags, and handler', () => {
    const mod = require('../lib/commands/clean');
    expect(mod.name).toBe('clean');
    expect(typeof mod.description).toBe('string');
    expect(typeof mod.usage).toBe('string');
    expect(mod.flags).toHaveProperty('--dry-run');
    expect(typeof mod.handler).toBe('function');
  });

  // (b) Scans .worktrees/ directory
  test('scans .worktrees/ directory for worktree dirs', async () => {
    const mod = require('../lib/commands/clean');
    let readdirPath = null;
    const mockFs = {
      existsSync: (p) => p.includes('.worktrees'),
      readdirSync: (p, _opts) => {
        readdirPath = p;
        return []; // no worktrees
      },
    };
    const mockExec = () => Buffer.from('');

    await mod.handler([], {}, '/fake/root', { _exec: mockExec, _fs: mockFs });
    expect(readdirPath).toBe(path.resolve('/fake/root', '.worktrees'));
  });

  // (c) Identifies merged branches correctly
  test('identifies merged branches and marks them for cleaning', async () => {
    const mod = require('../lib/commands/clean');
    const removedPaths = [];
    const mockFs = {
      existsSync: () => true,
      readdirSync: (p, opts) => {
        if (opts && opts.withFileTypes) {
          return [
            { name: 'merged-feature', isDirectory: () => true },
            { name: 'active-feature', isDirectory: () => true },
          ];
        }
        return [];
      },
      readFileSync: () => '',
    };
    const mockExec = (cmd, args, _opts) => {
      // git branch --merged main returns only merged-feature's branch
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--merged') {
        return Buffer.from('  feat/merged-feature\n  main\n');
      }
      // git worktree list --porcelain returns branch info
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        const mergedPath = path.resolve('/fake/root', '.worktrees', 'merged-feature');
        const activePath = path.resolve('/fake/root', '.worktrees', 'active-feature');
        return Buffer.from(
          `worktree ${mergedPath}\nbranch refs/heads/feat/merged-feature\n\n` +
          `worktree ${activePath}\nbranch refs/heads/feat/active-feature\n\n`
        );
      }
      // bd dolt stop succeeds
      if (cmd === 'bd') return Buffer.from('');
      // git worktree remove
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        removedPaths.push(args[2]);
        return Buffer.from('');
      }
      return Buffer.from('');
    };

    const result = await mod.handler([], {}, '/fake/root', { _exec: mockExec, _fs: mockFs });
    expect(result.success).toBe(true);
    expect(result.cleaned).toBe(1);
    expect(result.active).toBe(1);
    expect(removedPaths.length).toBe(1);
    expect(removedPaths[0]).toContain('merged-feature');
  });

  // (d) Calls stopDolt before removing worktree
  test('calls stopDolt before removing each merged worktree', async () => {
    const mod = require('../lib/commands/clean');
    const callOrder = [];
    const mockFs = {
      existsSync: () => true,
      readdirSync: (p, opts) => {
        if (opts && opts.withFileTypes) {
          return [{ name: 'done-feature', isDirectory: () => true }];
        }
        return [];
      },
      readFileSync: () => '',
    };
    const mockExec = (cmd, args, _opts) => {
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--merged') {
        return Buffer.from('  feat/done-feature\n');
      }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        const wtPath = path.resolve('/fake/root', '.worktrees', 'done-feature');
        return Buffer.from(`worktree ${wtPath}\nbranch refs/heads/feat/done-feature\n\n`);
      }
      if (cmd === 'bd' && args[0] === 'dolt' && args[1] === 'stop') {
        callOrder.push('stopDolt');
        return Buffer.from('');
      }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        callOrder.push('worktreeRemove');
        return Buffer.from('');
      }
      return Buffer.from('');
    };

    await mod.handler([], {}, '/fake/root', { _exec: mockExec, _fs: mockFs });
    expect(callOrder).toEqual(['stopDolt', 'worktreeRemove']);
  });

  // (e) --dry-run reports without removing
  test('--dry-run lists what would be cleaned without removing', async () => {
    const mod = require('../lib/commands/clean');
    const removeCalls = [];
    const mockFs = {
      existsSync: () => true,
      readdirSync: (p, opts) => {
        if (opts && opts.withFileTypes) {
          return [{ name: 'merged-feature', isDirectory: () => true }];
        }
        return [];
      },
      readFileSync: () => '',
    };
    const mockExec = (cmd, args, _opts) => {
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--merged') {
        return Buffer.from('  feat/merged-feature\n');
      }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        const wtPath = path.resolve('/fake/root', '.worktrees', 'merged-feature');
        return Buffer.from(`worktree ${wtPath}\nbranch refs/heads/feat/merged-feature\n\n`);
      }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        removeCalls.push(args);
        return Buffer.from('');
      }
      return Buffer.from('');
    };

    const result = await mod.handler([], { '--dry-run': true }, '/fake/root', { _exec: mockExec, _fs: mockFs });
    expect(result.success).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.cleaned).toBe(1);
    // Should NOT have called git worktree remove
    expect(removeCalls.length).toBe(0);
  });

  // (f) Skips active (unmerged) worktrees
  test('skips worktrees whose branches are not merged', async () => {
    const mod = require('../lib/commands/clean');
    const removeCalls = [];
    const mockFs = {
      existsSync: () => true,
      readdirSync: (p, opts) => {
        if (opts && opts.withFileTypes) {
          return [{ name: 'wip-feature', isDirectory: () => true }];
        }
        return [];
      },
      readFileSync: () => '',
    };
    const mockExec = (cmd, args, _opts) => {
      // No branches are merged (only main returned)
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--merged') {
        return Buffer.from('  main\n');
      }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'list') {
        const wtPath = path.resolve('/fake/root', '.worktrees', 'wip-feature');
        return Buffer.from(`worktree ${wtPath}\nbranch refs/heads/feat/wip-feature\n\n`);
      }
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') {
        removeCalls.push(args);
        return Buffer.from('');
      }
      return Buffer.from('');
    };

    const result = await mod.handler([], {}, '/fake/root', { _exec: mockExec, _fs: mockFs });
    expect(result.success).toBe(true);
    expect(result.cleaned).toBe(0);
    expect(result.active).toBe(1);
    expect(removeCalls.length).toBe(0);
  });

  // (g) Returns correct result shape
  test('returns { success, cleaned, active, dryRun }', async () => {
    const mod = require('../lib/commands/clean');
    const mockFs = {
      existsSync: () => false,
      readdirSync: () => [],
    };
    const mockExec = () => Buffer.from('');

    const result = await mod.handler([], {}, '/fake/root', { _exec: mockExec, _fs: mockFs });
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('cleaned');
    expect(result).toHaveProperty('active');
    expect(result).toHaveProperty('dryRun');
  });

  // (h) Returns success with zeros when .worktrees does not exist
  test('returns zeros when .worktrees directory does not exist', async () => {
    const mod = require('../lib/commands/clean');
    const mockFs = {
      existsSync: () => false,
      readdirSync: () => [],
    };
    const mockExec = () => Buffer.from('');

    const result = await mod.handler([], {}, '/fake/root', { _exec: mockExec, _fs: mockFs });
    expect(result.success).toBe(true);
    expect(result.cleaned).toBe(0);
    expect(result.active).toBe(0);
  });
});
