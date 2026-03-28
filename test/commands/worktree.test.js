'use strict';

const { describe, test, expect } = require('bun:test');

// ---------------------------------------------------------------------------
// forge worktree command — test/forge-worktree.test.js
// ---------------------------------------------------------------------------

describe('forge worktree command', () => {
  // (a) Module exports correct shape
  test('exports name, description, usage, flags, and handler', () => {
    const mod = require('../lib/commands/worktree');
    expect(mod.name).toBe('worktree');
    expect(typeof mod.description).toBe('string');
    expect(mod.usage).toBe('forge worktree <create|remove> <slug>');
    expect(mod.flags).toEqual({ '--branch': 'Custom branch name (default: feat/<slug>)' });
    expect(typeof mod.handler).toBe('function');
  });

  // (b) create: calls git worktree add with correct args (new branch)
  test('create calls git worktree add with -b for new branch', async () => {
    const mod = require('../lib/commands/worktree');
    const calls = [];
    const mockExec = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      // git branch --list returns empty => branch does not exist
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--list') {
        return Buffer.from('');
      }
      // bd --version succeeds
      if (cmd === 'bd' && args[0] === '--version') {
        return Buffer.from('beads 1.0.0\n');
      }
      return Buffer.from('');
    };
    const mockSpawn = (_cmd, _args, _opts) => ({ status: 0 });
    const mkdirCalls = [];
    const symlinkCalls = [];
    const mockFs = {
      mkdirSync: (p, opts) => { mkdirCalls.push({ path: p, opts }); },
      existsSync: (p) => {
        // .beads dir exists
        if (p.endsWith('.beads')) return true;
        // worktree path does not exist yet
        return false;
      },
      symlinkSync: (target, dest, type) => { symlinkCalls.push({ target, dest, type }); },
      readdirSync: () => [],
      cpSync: () => {},
    };

    const result = await mod.handler(
      ['create', 'my-feature'], {}, '/fake/root',
      { _exec: mockExec, _spawn: mockSpawn, _fs: mockFs, _platform: 'linux' }
    );

    expect(result.success).toBe(true);
    // Should have called mkdir for .worktrees
    expect(mkdirCalls.some(c => c.path.includes('.worktrees'))).toBe(true);
    // Should have called git worktree add with -b
    const wtAdd = calls.find(c => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(wtAdd).toBeTruthy();
    expect(wtAdd.args).toContain('-b');
    expect(wtAdd.args).toContain('feat/my-feature');
  });

  // (c) create: uses junction symlink on Windows for .beads
  test('create uses junction symlink on Windows', async () => {
    const mod = require('../lib/commands/worktree');
    const calls = [];
    const mockExec = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--list') return Buffer.from('');
      if (cmd === 'bd') return Buffer.from('beads 1.0.0\n');
      return Buffer.from('');
    };
    const mockSpawn = () => ({ status: 0 });
    const symlinkCalls = [];
    const mockFs = {
      mkdirSync: () => {},
      existsSync: (p) => p.endsWith('.beads'),
      symlinkSync: (target, dest, type) => { symlinkCalls.push({ target, dest, type }); },
      readdirSync: () => [],
      cpSync: () => {},
    };

    await mod.handler(
      ['create', 'win-test'], {}, '/fake/root',
      { _exec: mockExec, _spawn: mockSpawn, _fs: mockFs, _platform: 'win32' }
    );

    expect(symlinkCalls.length).toBeGreaterThan(0);
    expect(symlinkCalls[0].type).toBe('junction');
  });

  // (d) create: falls back to copy on EPERM
  test('create falls back to copy when symlink throws EPERM', async () => {
    const mod = require('../lib/commands/worktree');
    let copyCalled = false;
    const mockExec = (cmd, args, _opts) => {
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--list') return Buffer.from('');
      if (cmd === 'bd') return Buffer.from('beads 1.0.0\n');
      return Buffer.from('');
    };
    const mockSpawn = () => ({ status: 0 });
    const mockFs = {
      mkdirSync: () => {},
      existsSync: (p) => p.endsWith('.beads'),
      symlinkSync: () => {
        const err = new Error('Operation not permitted');
        err.code = 'EPERM';
        throw err;
      },
      readdirSync: (_p) => ['issue-abc.json', 'daemon.lock', 'config.json'],
      cpSync: () => { copyCalled = true; },
    };

    const result = await mod.handler(
      ['create', 'perm-test'], {}, '/fake/root',
      { _exec: mockExec, _spawn: mockSpawn, _fs: mockFs, _platform: 'linux' }
    );

    expect(result.success).toBe(true);
    expect(copyCalled).toBe(true);
  });

  // (e) create: skips beads setup when .beads doesn't exist
  test('create skips beads setup when .beads does not exist', async () => {
    const mod = require('../lib/commands/worktree');
    const symlinkCalls = [];
    const mockExec = (cmd, args, _opts) => {
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--list') return Buffer.from('');
      return Buffer.from('');
    };
    const mockSpawn = () => ({ status: 0 });
    const mockFs = {
      mkdirSync: () => {},
      existsSync: () => false, // .beads does not exist, worktree does not exist
      symlinkSync: (target, dest, type) => { symlinkCalls.push({ target, dest, type }); },
      readdirSync: () => [],
      cpSync: () => {},
    };

    const result = await mod.handler(
      ['create', 'no-beads'], {}, '/fake/root',
      { _exec: mockExec, _spawn: mockSpawn, _fs: mockFs, _platform: 'linux' }
    );

    expect(result.success).toBe(true);
    expect(result.beadsWarning).toContain('not installed');
    // Should NOT have attempted symlink
    expect(symlinkCalls.length).toBe(0);
  });

  // (f) create: creates .worktrees dir if missing
  test('create calls mkdirSync with recursive for .worktrees', async () => {
    const mod = require('../lib/commands/worktree');
    const mkdirCalls = [];
    const mockExec = (cmd, args, _opts) => {
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--list') return Buffer.from('');
      return Buffer.from('');
    };
    const mockSpawn = () => ({ status: 0 });
    const mockFs = {
      mkdirSync: (p, opts) => { mkdirCalls.push({ path: p, opts }); },
      existsSync: () => false,
      symlinkSync: () => {},
      readdirSync: () => [],
      cpSync: () => {},
    };

    await mod.handler(
      ['create', 'dir-test'], {}, '/fake/root',
      { _exec: mockExec, _spawn: mockSpawn, _fs: mockFs, _platform: 'linux' }
    );

    const worktreeMkdir = mkdirCalls.find(c => c.path.includes('.worktrees'));
    expect(worktreeMkdir).toBeTruthy();
    expect(worktreeMkdir.opts).toEqual({ recursive: true });
  });

  // (g) create: uses existing branch (no -b) when branch already exists
  test('create omits -b flag when branch already exists', async () => {
    const mod = require('../lib/commands/worktree');
    const calls = [];
    const mockExec = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      // git branch --list returns matching branch => branch exists
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--list') {
        return Buffer.from('  feat/existing\n');
      }
      if (cmd === 'bd') return Buffer.from('beads 1.0.0\n');
      return Buffer.from('');
    };
    const mockSpawn = () => ({ status: 0 });
    const mockFs = {
      mkdirSync: () => {},
      existsSync: (p) => p.endsWith('.beads'),
      symlinkSync: () => {},
      readdirSync: () => [],
      cpSync: () => {},
    };

    await mod.handler(
      ['create', 'existing'], {}, '/fake/root',
      { _exec: mockExec, _spawn: mockSpawn, _fs: mockFs, _platform: 'linux' }
    );

    const wtAdd = calls.find(c => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(wtAdd).toBeTruthy();
    expect(wtAdd.args).not.toContain('-b');
    expect(wtAdd.args).toContain('feat/existing');
  });

  // (h) create: detects worktree already exists and returns reuse message
  test('create returns reuse message when worktree path already exists', async () => {
    const mod = require('../lib/commands/worktree');
    const mockExec = (cmd, args, _opts) => {
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--list') return Buffer.from('');
      return Buffer.from('');
    };
    const mockSpawn = () => ({ status: 0 });
    const mockFs = {
      mkdirSync: () => {},
      existsSync: (p) => {
        // worktree path already exists
        if (p.includes('.worktrees') && !p.endsWith('.worktrees')) return true;
        return false;
      },
      symlinkSync: () => {},
      readdirSync: () => [],
      cpSync: () => {},
    };

    const result = await mod.handler(
      ['create', 'already-exists'], {}, '/fake/root',
      { _exec: mockExec, _spawn: mockSpawn, _fs: mockFs, _platform: 'linux' }
    );

    expect(result.success).toBe(true);
    expect(result.reused).toBe(true);
    expect(result.message).toContain('already exists');
  });

  // (i) remove: calls git worktree remove with correct args
  test('remove calls git worktree remove with correct path', async () => {
    const mod = require('../lib/commands/worktree');
    const calls = [];
    const mockExec = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return Buffer.from('');
    };
    const mockFs = { readFileSync: () => { throw new Error('ENOENT'); } };

    const result = await mod.handler(
      ['remove', 'old-feature'], {}, '/fake/root',
      { _exec: mockExec, _fs: mockFs }
    );

    expect(result.success).toBe(true);
    const wtRemove = calls.find(c => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(wtRemove).toBeTruthy();
    expect(wtRemove.args[2]).toContain('old-feature');
  });

  // (n) remove: calls stopDolt before git worktree remove
  test('remove calls stopDolt before git worktree remove', async () => {
    const mod = require('../lib/commands/worktree');
    const callOrder = [];
    const mockExec = (cmd, args, _opts) => {
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
    const mockFs = { readFileSync: () => { throw new Error('ENOENT'); } };

    await mod.handler(
      ['remove', 'done-feature'], {}, '/fake/root',
      { _exec: mockExec, _fs: mockFs }
    );

    expect(callOrder[0]).toBe('stopDolt');
    expect(callOrder[1]).toBe('worktreeRemove');
  });

  // (j) error: missing slug returns helpful error
  test('returns error when slug is missing', async () => {
    const mod = require('../lib/commands/worktree');
    const result = await mod.handler(['create'], {}, '/fake/root', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('slug');
  });

  // (k) error: missing subcommand returns helpful error
  test('returns error when subcommand is missing', async () => {
    const mod = require('../lib/commands/worktree');
    const result = await mod.handler([], {}, '/fake/root', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('create|remove');
  });

  // (l) create: custom --branch flag overrides default branch name
  test('create uses custom branch name from --branch flag', async () => {
    const mod = require('../lib/commands/worktree');
    const calls = [];
    const mockExec = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--list') return Buffer.from('');
      if (cmd === 'bd') return Buffer.from('beads 1.0.0\n');
      return Buffer.from('');
    };
    const mockSpawn = () => ({ status: 0 });
    const mockFs = {
      mkdirSync: () => {},
      existsSync: (p) => p.endsWith('.beads'),
      symlinkSync: () => {},
      readdirSync: () => [],
      cpSync: () => {},
    };

    await mod.handler(
      ['create', 'custom'], { '--branch': 'fix/custom-branch' }, '/fake/root',
      { _exec: mockExec, _spawn: mockSpawn, _fs: mockFs, _platform: 'linux' }
    );

    const wtAdd = calls.find(c => c.cmd === 'git' && c.args[0] === 'worktree' && c.args[1] === 'add');
    expect(wtAdd).toBeTruthy();
    expect(wtAdd.args).toContain('fix/custom-branch');
  });

  // (m) create: runs package install after worktree creation
  test('create runs package manager install in worktree', async () => {
    const mod = require('../lib/commands/worktree');
    const spawnCalls = [];
    const mockExec = (cmd, args, _opts) => {
      if (cmd === 'git' && args[0] === 'branch' && args[1] === '--list') return Buffer.from('');
      if (cmd === 'bd') return Buffer.from('beads 1.0.0\n');
      return Buffer.from('');
    };
    const mockSpawn = (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return { status: 0 };
    };
    const mockFs = {
      mkdirSync: () => {},
      existsSync: (p) => {
        if (p.endsWith('.beads')) return true;
        // package.json exists for pkg manager detection
        if (p.endsWith('package.json')) return true;
        // bun.lockb exists
        if (p.endsWith('bun.lockb')) return true;
        return false;
      },
      symlinkSync: () => {},
      readdirSync: () => [],
      cpSync: () => {},
    };

    await mod.handler(
      ['create', 'install-test'], {}, '/fake/root',
      { _exec: mockExec, _spawn: mockSpawn, _fs: mockFs, _platform: 'linux' }
    );

    const installCall = spawnCalls.find(c => c.args && c.args[0] === 'install');
    expect(installCall).toBeTruthy();
    expect(installCall.opts.cwd).toContain('install-test');
  });
});
