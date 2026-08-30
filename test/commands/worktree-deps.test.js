'use strict';

// Regression coverage for `forge worktree create` dependency setup.
//
// Root cause fixed here: `handleCreate` only ran `<pkgManager> install` and
// swallowed its exit code, so a fresh worktree ended up with no usable
// node_modules (and any install failure was silent). The established pattern for
// this repo's own worktrees is a node_modules link to the main repo's shared
// install (junction on Windows, directory symlink on POSIX) — fast, no reinstall.
//
// These tests assert: (1) the link is created with the right target/type per
// platform, (2) install failures are SURFACED (not swallowed), and (3) a real
// `forge worktree create` yields a usable node_modules (skipped gracefully where
// the OS/user cannot create links).

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mod = require('../../lib/commands/worktree');

// Non-throwing git stub: satisfies the bare-repo guard (`rev-parse
// --show-toplevel`), the branch-existence probe, and `git worktree add`.
function gitStub(calls = []) {
  return (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === 'git' && args.includes('--show-toplevel')) return Buffer.from('/fake/root\n');
    if (cmd === 'git' && args[0] === 'branch' && args[1] === '--list') return Buffer.from('');
    return Buffer.from('');
  };
}

describe('forge worktree create — node_modules link to shared install', () => {
  function runLinkScenario() {
    const projectRoot = '/fake/root';
    const worktreePath = path.resolve(projectRoot, '.worktrees', 'linkme');
    const srcModules = path.join(projectRoot, 'node_modules');
    const destModules = path.join(worktreePath, 'node_modules');

    const symlinkCalls = [];
    const spawnCalls = [];
    const mockFs = {
      mkdirSync: () => {},
      // Main repo has node_modules; the new worktree does not yet.
      existsSync: (p) => p === srcModules,
      symlinkSync: (target, dest, type) => { symlinkCalls.push({ target, dest, type }); },
      readdirSync: () => [],
      cpSync: () => {},
    };
    const mockSpawn = (cmd, args, opts) => { spawnCalls.push({ cmd, args, opts }); return { status: 0 }; };

    return { projectRoot, srcModules, destModules, symlinkCalls, spawnCalls, mockFs, mockSpawn };
  }

  test('links node_modules with a junction on Windows', async () => {
    const s = runLinkScenario();
    const result = await mod.handler(
      ['create', 'linkme'], {}, s.projectRoot,
      { _exec: gitStub(), _spawn: s.mockSpawn, _fs: s.mockFs, _platform: 'win32' },
    );

    expect(result.success).toBe(true);
    expect(s.symlinkCalls).toHaveLength(1);
    expect(s.symlinkCalls[0].target).toBe(s.srcModules);
    expect(s.symlinkCalls[0].dest).toBe(s.destModules);
    expect(s.symlinkCalls[0].type).toBe('junction');
    // Fast path linked — no package install was spawned.
    expect(s.spawnCalls.find(c => c.args && c.args[0] === 'install')).toBeFalsy();
  });

  test('links node_modules with a directory symlink on POSIX', async () => {
    const s = runLinkScenario();
    const result = await mod.handler(
      ['create', 'linkme'], {}, s.projectRoot,
      { _exec: gitStub(), _spawn: s.mockSpawn, _fs: s.mockFs, _platform: 'linux' },
    );

    expect(result.success).toBe(true);
    expect(s.symlinkCalls).toHaveLength(1);
    expect(s.symlinkCalls[0].type).toBe('dir');
    expect(s.symlinkCalls[0].target).toBe(s.srcModules);
  });
});

describe('forge worktree create — surfaces dependency failures', () => {
  test('a non-zero install exit is reported, not swallowed', async () => {
    const projectRoot = '/fake/root';
    // No main node_modules to link → falls back to install, which "fails".
    const mockFs = {
      mkdirSync: () => {},
      existsSync: (p) => p.endsWith('package.json') || p.endsWith('bun.lock'),
      symlinkSync: () => {},
      readdirSync: () => [],
      cpSync: () => {},
    };
    const failingSpawn = () => ({ status: 1 });

    const result = await mod.handler(
      ['create', 'install-fails'], {}, projectRoot,
      { _exec: gitStub(), _spawn: failingSpawn, _fs: mockFs, _platform: 'linux' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/install/i);
  });

  test('a spawn error (package manager missing) is reported, not swallowed', async () => {
    const projectRoot = '/fake/root';
    const mockFs = {
      mkdirSync: () => {},
      existsSync: (p) => p.endsWith('package.json'),
      symlinkSync: () => {},
      readdirSync: () => [],
      cpSync: () => {},
    };
    const erroringSpawn = () => ({ error: new Error('spawn npm ENOENT') });

    const result = await mod.handler(
      ['create', 'no-pkg-mgr'], {}, projectRoot,
      { _exec: gitStub(), _spawn: erroringSpawn, _fs: mockFs, _platform: 'linux' },
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/install|ENOENT/i);
  });
});

describe('forge worktree create — verifies the install and self-heals a stale store', () => {
  const { setupWorktreeDeps } = mod._internal;

  // Real files under a tmp dir; only the package manager is stubbed. Declares a
  // direct dependency so the install has something verifiable to produce.
  function makeFixture(lockfile = 'bun.lock') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-wt-heal-'));
    const projectRoot = path.join(tmp, 'main');
    const worktreePath = path.join(projectRoot, '.worktrees', 'healme');
    fs.mkdirSync(worktreePath, { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({ name: 'main' }));
    fs.writeFileSync(path.join(projectRoot, lockfile), '');
    fs.writeFileSync(path.join(worktreePath, 'package.json'), JSON.stringify({ name: 'wt', dependencies: { 'left-pad': '^1.0.0' } }));
    return { tmp, projectRoot, worktreePath };
  }

  function populate(worktreePath) {
    const pkgDir = path.join(worktreePath, 'node_modules', 'left-pad');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'left-pad' }));
  }

  function makeWorkspaceFixture(lockfile = 'bun.lock') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-wt-workspace-heal-'));
    const projectRoot = path.join(tmp, 'main');
    const worktreePath = path.join(projectRoot, '.worktrees', 'heal-workspace');
    const rootPackage = JSON.stringify({ name: 'root', workspaces: ['packages/*'] });
    const workspacePackage = JSON.stringify({ name: '@forge/skills', dependencies: { chalk: '^6.0.0' } });

    for (const root of [projectRoot, worktreePath]) {
      fs.mkdirSync(path.join(root, 'packages', 'skills'), { recursive: true });
      fs.writeFileSync(path.join(root, 'package.json'), rootPackage);
      fs.writeFileSync(path.join(root, 'packages', 'skills', 'package.json'), workspacePackage);
    }
    fs.writeFileSync(path.join(projectRoot, lockfile), '');
    fs.mkdirSync(path.join(projectRoot, 'node_modules', '.bun'), { recursive: true });

    const fsApi = {
      ...fs,
      symlinkSync: (_target, dest) => fs.mkdirSync(dest, { recursive: true }),
      unlinkSync: dest => fs.rmSync(dest, { recursive: true }),
    };
    return { tmp, projectRoot, worktreePath, fsApi };
  }

  function populateWorkspaceDependency(worktreePath) {
    const pkgDir = path.join(worktreePath, 'packages', 'skills', 'node_modules', 'chalk');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'chalk' }));
  }

  // Plain install exits 0 without writing anything (the "no changes" stale-store
  // symptom); only --force actually repopulates the tree.
  function staleStoreSpawn(worktreePath, calls) {
    return (cmd, args) => {
      calls.push({ cmd, args });
      if (args.includes('--force')) populate(worktreePath);
      return { status: 0 };
    };
  }

  test('reruns the install with --force when the tree is missing a declared dependency', () => {
    const f = makeFixture();
    try {
      const calls = [];
      const result = setupWorktreeDeps(f.worktreePath, f.projectRoot, {
        spawnFn: staleStoreSpawn(f.worktreePath, calls),
        fsApi: fs,
        platform: 'linux',
      });

      expect(result.installed).toBe(true);
      expect(result.healed).toBe(true);
      expect(calls).toHaveLength(2);
      expect(calls[0].args).toEqual(['install']);
      expect(calls[1].args).toEqual(['install', '--force']);
      expect(fs.existsSync(path.join(f.worktreePath, 'node_modules', 'left-pad', 'package.json'))).toBe(true);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  });

  test('does not rerun when the plain install produced a complete tree', () => {
    const f = makeFixture();
    try {
      const calls = [];
      const result = setupWorktreeDeps(f.worktreePath, f.projectRoot, {
        spawnFn: (cmd, args) => { calls.push({ cmd, args }); populate(f.worktreePath); return { status: 0 }; },
        fsApi: fs,
        platform: 'linux',
      });

      expect(result.installed).toBe(true);
      expect(result.healed).toBe(false);
      expect(calls).toHaveLength(1);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  });

  test('installs a missing Bun-isolated workspace dependency after linking the shared root store', () => {
    const f = makeWorkspaceFixture();
    try {
      const calls = [];
      const result = setupWorktreeDeps(f.worktreePath, f.projectRoot, {
        spawnFn: (cmd, args) => {
          calls.push({ cmd, args });
          populateWorkspaceDependency(f.worktreePath);
          return { status: 0 };
        },
        fsApi: f.fsApi,
        platform: 'linux',
      });

      expect(result).toEqual({ linked: false, installed: true, healed: false });
      expect(calls.map(({ args }) => args)).toEqual([['install']]);
      expect(fs.existsSync(path.join(f.worktreePath, 'packages', 'skills', 'node_modules', 'chalk', 'package.json'))).toBe(true);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  });

  test('detaches a newly-created root modules link before installing workspace dependencies', () => {
    const f = makeWorkspaceFixture();
    try {
      const destModules = path.join(f.worktreePath, 'node_modules');
      let linkWasDetached = false;
      let result;
      try {
        result = setupWorktreeDeps(f.worktreePath, f.projectRoot, {
          spawnFn: () => {
            linkWasDetached = !fs.existsSync(destModules);
            fs.mkdirSync(destModules, { recursive: true });
            populateWorkspaceDependency(f.worktreePath);
            return { status: 0 };
          },
          fsApi: fs,
          platform: process.platform,
        });
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOSYS', 'UV_EPERM'].includes(error.code)) return;
        throw error;
      }

      expect(linkWasDetached).toBe(true);
      expect(result).toEqual({ linked: false, installed: true, healed: false });
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  });

  test('detaches an existing root modules link before installing workspace dependencies', () => {
    const f = makeWorkspaceFixture();
    try {
      const srcModules = path.join(f.projectRoot, 'node_modules');
      const destModules = path.join(f.worktreePath, 'node_modules');
      try {
        fs.symlinkSync(srcModules, destModules, process.platform === 'win32' ? 'junction' : 'dir');
      } catch (error) {
        if (['EPERM', 'EACCES', 'ENOSYS', 'UV_EPERM'].includes(error.code)) return;
        throw error;
      }
      let linkWasDetached = false;
      const result = setupWorktreeDeps(f.worktreePath, f.projectRoot, {
        spawnFn: () => {
          linkWasDetached = !fs.existsSync(destModules);
          fs.mkdirSync(destModules, { recursive: true });
          populateWorkspaceDependency(f.worktreePath);
          return { status: 0 };
        },
        fsApi: fs,
        platform: process.platform,
      });

      expect(linkWasDetached).toBe(true);
      expect(result).toEqual({ linked: false, installed: true, healed: false });
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  });

  test('preserves an existing real modules directory before installing workspace dependencies', () => {
    const f = makeWorkspaceFixture();
    try {
      const destModules = path.join(f.worktreePath, 'node_modules');
      fs.mkdirSync(destModules, { recursive: true });
      let realDirectoryWasPreserved = false;
      const result = setupWorktreeDeps(f.worktreePath, f.projectRoot, {
        spawnFn: () => {
          realDirectoryWasPreserved = fs.existsSync(destModules) && !fs.lstatSync(destModules).isSymbolicLink();
          populateWorkspaceDependency(f.worktreePath);
          return { status: 0 };
        },
        fsApi: fs,
        platform: process.platform,
      });

      expect(realDirectoryWasPreserved).toBe(true);
      expect(result).toEqual({ linked: false, installed: true, healed: false });
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  });

  test('does not treat a coincidental root package as a Bun-isolated workspace dependency', () => {
    const f = makeWorkspaceFixture();
    try {
      const rootChalk = path.join(f.projectRoot, 'node_modules', 'chalk');
      fs.mkdirSync(rootChalk, { recursive: true });
      fs.writeFileSync(path.join(rootChalk, 'package.json'), JSON.stringify({ name: 'chalk' }));
      f.fsApi.symlinkSync = (target, dest) => fs.cpSync(target, dest, { recursive: true });
      const calls = [];
      const result = setupWorktreeDeps(f.worktreePath, f.projectRoot, {
        spawnFn: (cmd, args) => {
          calls.push({ cmd, args });
          populateWorkspaceDependency(f.worktreePath);
          return { status: 0 };
        },
        fsApi: f.fsApi,
        platform: 'linux',
      });

      expect(result).toEqual({ linked: false, installed: true, healed: false });
      expect(calls.map(({ args }) => args)).toEqual([['install']]);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  });

  test('accepts a valid root-hoisted npm workspace dependency without installing', () => {
    const f = makeWorkspaceFixture('package-lock.json');
    try {
      const rootChalk = path.join(f.projectRoot, 'node_modules', 'chalk');
      fs.mkdirSync(rootChalk, { recursive: true });
      fs.writeFileSync(path.join(rootChalk, 'package.json'), JSON.stringify({ name: 'chalk' }));
      f.fsApi.symlinkSync = (target, dest) => fs.cpSync(target, dest, { recursive: true });
      const calls = [];
      const result = setupWorktreeDeps(f.worktreePath, f.projectRoot, {
        spawnFn: (cmd, args) => { calls.push({ cmd, args }); return { status: 0 }; },
        fsApi: f.fsApi,
        platform: 'linux',
      });

      expect(result).toEqual({ linked: true, installed: false, healed: false });
      expect(calls).toHaveLength(0);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  });

  test('fails closed when install and heal leave a Bun-isolated workspace dependency missing', () => {
    const f = makeWorkspaceFixture();
    try {
      const calls = [];
      expect(() => setupWorktreeDeps(f.worktreePath, f.projectRoot, {
        spawnFn: (cmd, args) => { calls.push({ cmd, args }); return { status: 0 }; },
        fsApi: f.fsApi,
        platform: 'linux',
      })).toThrow(/bun install --force/);
      expect(calls.map(({ args }) => args)).toEqual([['install'], ['install', '--force']]);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  });

  test('a missing workspace base does not hide a missing root dependency', () => {
    const f = makeFixture();
    try {
      fs.writeFileSync(path.join(f.worktreePath, 'package.json'), JSON.stringify({
        name: 'wt',
        workspaces: ['packages/*'],
        dependencies: { 'left-pad': '^1.0.0' },
      }));
      const calls = [];
      expect(() => setupWorktreeDeps(f.worktreePath, f.projectRoot, {
        spawnFn: (cmd, args) => { calls.push({ cmd, args }); return { status: 0 }; },
        fsApi: fs,
        platform: 'linux',
      })).toThrow(/bun install --force/);
      expect(calls.map(({ args }) => args)).toEqual([['install'], ['install', '--force']]);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  });

  test('throws naming the manual command when the forced install still leaves the tree broken', () => {
    const f = makeFixture();
    try {
      expect(() => setupWorktreeDeps(f.worktreePath, f.projectRoot, {
        spawnFn: () => ({ status: 0 }), // never populates
        fsApi: fs,
        platform: 'linux',
      })).toThrow(/bun install --force/);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  });

  test('skips the probe for yarn (probe-less manager) instead of forcing a reinstall', () => {
    const f = makeFixture('yarn.lock');
    try {
      const calls = [];
      const result = setupWorktreeDeps(f.worktreePath, f.projectRoot, {
        spawnFn: (cmd, args) => { calls.push({ cmd, args }); return { status: 0 }; },
        fsApi: fs,
        platform: 'linux',
      });

      expect(result.healed).toBe(false);
      expect(calls).toHaveLength(1);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  });

  // A killed child reports status null with a signal set. Probe-less yarn has no
  // verification behind it, so a swallowed kill would return installed: true.
  test('a signal-killed install throws instead of reporting a successful install', () => {
    const f = makeFixture('yarn.lock');
    try {
      expect(() => setupWorktreeDeps(f.worktreePath, f.projectRoot, {
        spawnFn: () => ({ status: null, signal: 'SIGTERM' }),
        fsApi: fs,
        platform: 'linux',
      })).toThrow(/SIGTERM/);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  });

  test('install failure messages carry the stderr detail', () => {
    const f = makeFixture();
    try {
      expect(() => setupWorktreeDeps(f.worktreePath, f.projectRoot, {
        spawnFn: () => ({ status: 1, stderr: Buffer.from('error: lockfile had changes, but lockfile is frozen\n') }),
        fsApi: fs,
        platform: 'linux',
      })).toThrow(/lockfile is frozen/);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  });

  test('surfaces the heal in the create output so it is not silent', async () => {
    const f = makeFixture();
    try {
      // handleCreate reuses an existing worktree dir, so let the git stub create
      // it the way `git worktree add` would.
      fs.rmSync(f.worktreePath, { recursive: true, force: true });
      const gitCalls = [];
      const addingGitStub = (cmd, args) => {
        gitCalls.push({ cmd, args: [...args] });
        if (cmd === 'git' && args.includes('--show-toplevel')) return Buffer.from(`${f.projectRoot}\n`);
        const rooted = cmd === 'git' && args[0] === '-C' && args[1] === f.projectRoot;
        if (rooted && args[2] === 'branch' && args[3] === '--list') return Buffer.from('');
        const worktreeIndex = args.indexOf('worktree');
        if (rooted && worktreeIndex >= 0 && args[worktreeIndex + 1] === 'add') {
          fs.mkdirSync(f.worktreePath, { recursive: true });
          fs.writeFileSync(path.join(f.worktreePath, 'package.json'), JSON.stringify({ name: 'wt', dependencies: { 'left-pad': '^1.0.0' } }));
        }
        return Buffer.from('');
      };

      const result = await mod.handler(
        ['create', 'healme'], {}, f.projectRoot,
        { _exec: addingGitStub, _spawn: staleStoreSpawn(f.worktreePath, []), _fs: fs, _platform: 'linux' },
      );

      expect(result.success).toBe(true);
      expect(result.depsHealed).toBe(true);
      expect(result.output).toMatch(/healed dependencies \(store was stale\)/i);
      expect(gitCalls.some(({ cmd, args }) => cmd === 'git'
        && args[0] === '-C' && args[1] === f.projectRoot
        && args[2] === 'branch' && args[3] === '--list')).toBe(true);
      expect(gitCalls.some(({ cmd, args }) => cmd === 'git'
        && args[0] === '-C' && args[1] === f.projectRoot
        && args.includes('worktree') && args.includes('add'))).toBe(true);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  });
});

describe('forge worktree create — real filesystem link', () => {
  // Exercises the real link on disk (no git — a real `git worktree add` would
  // register against the shared repo in some CI/hook environments). This proves a
  // freshly-created worktree gets a *usable* node_modules reaching the shared
  // install's packages. Skipped gracefully where the OS/user cannot create links,
  // mirroring the file-checker symlink test.
  const { setupWorktreeDeps } = mod._internal;

  test('links the worktree node_modules to the shared install so packages resolve', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-wt-link-'));
    try {
      const projectRoot = path.join(tmp, 'main');
      const worktreePath = path.join(tmp, 'main', '.worktrees', 'deps-e2e');
      fs.mkdirSync(worktreePath, { recursive: true });

      // Real shared install with a sentinel package we can require through the link.
      fs.mkdirSync(path.join(projectRoot, 'node_modules', '.marker-pkg'), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, 'node_modules', '.marker-pkg', 'index.js'), 'module.exports = 42;\n');

      let result;
      try {
        result = setupWorktreeDeps(worktreePath, projectRoot, {
          spawnFn: () => ({ status: 0 }),
          fsApi: fs,
          platform: process.platform,
        });
      } catch (error) {
        // No privilege to create links on this host → skip (not a fix failure).
        if (['EPERM', 'EACCES', 'ENOSYS', 'UV_EPERM'].includes(error.code)) return;
        throw error;
      }

      expect(result.linked).toBe(true);
      const marker = path.join(worktreePath, 'node_modules', '.marker-pkg', 'index.js');
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.readFileSync(marker, 'utf8')).toContain('42');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 20000);
});
