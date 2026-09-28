'use strict';

const { describe, test, expect } = require('bun:test');

function missingLstat() {
  const error = new Error('missing');
  error.code = 'ENOENT';
  throw error;
}

// ---------------------------------------------------------------------------
// forge worktree command — test/forge-worktree.test.js
// ---------------------------------------------------------------------------

describe('forge worktree command', () => {
  // (a) Module exports correct shape
  test('exports name, description, usage, flags, and handler', () => {
    const mod = require('../../lib/commands/worktree');
    expect(mod.name).toBe('worktree');
    expect(typeof mod.description).toBe('string');
    expect(mod.usage).toBe('forge worktree <create|remove|list> <slug>');
    expect(mod.flags).toEqual({
      '--branch': 'Custom branch name (default: feat/<slug>)',
      '--base': 'Base ref a new branch forks from (default: the repo default branch, e.g. origin/main)',
      '--issue': 'Kernel issue id to link this worktree to (records issue → worktree)',
      '--work-folder': 'Repo-relative work-folder this issue owns (records worktree → work-folder + drops a .forge-issue marker)',
    });
    expect(typeof mod.handler).toBe('function');
  });

  test('create returns bare repo error when project root has no working tree', async () => {
    const mod = require('../../lib/commands/worktree');
    const calls = [];
    const mockExec = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-parse' && args[3] === '--show-toplevel') {
        throw new Error('fatal: this operation must be run in a work tree');
      }
      throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
    };
    const mockFs = {
      mkdirSync: () => {
        throw new Error('mkdirSync should not be called for bare repos');
      },
      existsSync: () => false,
    };

    const result = await mod.handler(
      ['create', 'bare-root'], {}, '/fake/bare.git',
      { _exec: mockExec, _fs: mockFs }
    );

    expect(result).toEqual({ success: false, error: 'bare repo detected' });
    expect(calls).toHaveLength(1);
  });

  test('create preserves non-bare rev-parse errors', async () => {
    const mod = require('../../lib/commands/worktree');
    const mockExec = (cmd, args) => {
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'rev-parse' && args[3] === '--show-toplevel') {
        throw new Error('fatal: detected dubious ownership in repository');
      }
      throw new Error(`Unexpected command: ${cmd} ${args.join(' ')}`);
    };
    const mockFs = {
      mkdirSync: () => {
        throw new Error('mkdirSync should not be called after rev-parse failure');
      },
      existsSync: () => false,
    };

    const result = await mod.handler(
      ['create', 'abc'], {}, '/fake/repo',
      { _exec: mockExec, _fs: mockFs }
    );

    expect(result).toEqual({ success: false, error: 'fatal: detected dubious ownership in repository' });
  });

  // (b) create: calls git worktree add with correct args (new branch)
  test('create calls git worktree add with -b for new branch', async () => {
    const mod = require('../../lib/commands/worktree');
    const calls = [];
    const mockExec = (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      // git branch --list returns empty => branch does not exist
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'branch' && args[3] === '--list') {
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
      lstatSync: missingLstat,
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
    const wtAdd = calls.find(c => c.cmd === 'git' && c.args[2] === 'worktree' && c.args[3] === 'add');
    expect(wtAdd).toBeTruthy();
    expect(wtAdd.args).toContain('-b');
    expect(wtAdd.args).toContain('feat/my-feature');
  });

  // (f) create: creates .worktrees dir if missing
  test('create calls mkdirSync with recursive for .worktrees', async () => {
    const mod = require('../../lib/commands/worktree');
    const mkdirCalls = [];
    const mockExec = (cmd, args, _opts) => {
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'branch' && args[3] === '--list') return Buffer.from('');
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
    const mod = require('../../lib/commands/worktree');
    const calls = [];
    const mockExec = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      // git branch --list returns matching branch => branch exists
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'branch' && args[3] === '--list') {
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

    const wtAdd = calls.find(c => c.cmd === 'git' && c.args[2] === 'worktree' && c.args[3] === 'add');
    expect(wtAdd).toBeTruthy();
    expect(wtAdd.args).not.toContain('-b');
    expect(wtAdd.args).toContain('feat/existing');
  });

  // (h) create: detects worktree already exists and returns reuse message
  test('create returns reuse message when worktree path already exists', async () => {
    const mod = require('../../lib/commands/worktree');
    const mockExec = (cmd, args, _opts) => {
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'branch' && args[3] === '--list') return Buffer.from('');
      return Buffer.from('');
    };
    const mockSpawn = () => ({ status: 0 });
    const mockFs = {
      mkdirSync: () => {},
      existsSync: (p) => {
        // worktree path already exists (the dir only: no manifests inside it)
        if (p.endsWith(`${require('node:path').sep}already-exists`)) return true;
        return false;
      },
      lstatSync: missingLstat,
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

  // A readable repo for remove: main worktree only, invoked from its toplevel.
  // remove fails closed without a worktree list, so mocks must supply one.
  function mainOnlyRepoExec(root, onCall) {
    const path = require('node:path');
    const main = path.resolve(root);
    return (cmd, args, opts) => {
      const answer = onCall(cmd, args, opts);
      if (answer !== undefined) return answer;
      if (cmd !== 'git') return Buffer.from('');
      if (args.includes('list')) return [`worktree ${main.replace(/\\/g, '/')}`, 'HEAD 0123', 'branch refs/heads/main', '', ''].join('\0');
      const answers = { '--git-dir': path.join(main, '.git'), '--git-common-dir': path.join(main, '.git'), '--show-toplevel': main };
      if (args.includes('rev-parse')) return args.filter((a) => answers[a]).map((a) => `${answers[a]}\n`).join('');
      if (args.includes('core.worktree')) throw new Error('unset');
      return Buffer.from('');
    };
  }

  // (i) remove: calls git worktree remove with correct args
  test('remove calls git worktree remove with correct path', async () => {
    const mod = require('../../lib/commands/worktree');
    const calls = [];
    const mockExec = mainOnlyRepoExec('/fake/root', (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      return undefined;
    });
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

  // (n) remove: cleanup is pure git — no per-worktree issue-store server to stop
  test('remove uses git worktree remove without stopping any server', async () => {
    const mod = require('../../lib/commands/worktree');
    const callOrder = [];
    const mockExec = mainOnlyRepoExec('/fake/root', (cmd, args, _opts) => {
      if (cmd !== 'git') {
        throw new Error(`unexpected non-git command: ${cmd}`);
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        callOrder.push('worktreeRemove');
        return Buffer.from('');
      }
      return undefined;
    });

    await mod.handler(
      ['remove', 'done-feature'], {}, '/fake/root',
      { _exec: mockExec }
    );

    expect(callOrder).toEqual(['worktreeRemove']);
  });

  // (j) error: missing slug returns helpful error
  test('returns error when slug is missing', async () => {
    const mod = require('../../lib/commands/worktree');
    const result = await mod.handler(['create'], {}, '/fake/root', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('slug');
  });

  // (k) error: missing subcommand returns helpful error
  test('returns error when subcommand is missing', async () => {
    const mod = require('../../lib/commands/worktree');
    const result = await mod.handler([], {}, '/fake/root', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('create|remove');
  });

  // (l) create: custom --branch flag overrides default branch name
  test('create uses custom branch name from --branch flag', async () => {
    const mod = require('../../lib/commands/worktree');
    const calls = [];
    const mockExec = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'branch' && args[3] === '--list') return Buffer.from('');
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

    const wtAdd = calls.find(c => c.cmd === 'git' && c.args[2] === 'worktree' && c.args[3] === 'add');
    expect(wtAdd).toBeTruthy();
    expect(wtAdd.args).toContain('fix/custom-branch');
  });

  test('create parses documented --branch argument syntax from registry args', async () => {
    const mod = require('../../lib/commands/worktree');
    const calls = [];
    const mockExec = (cmd, args, _opts) => {
      calls.push({ cmd, args });
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'branch' && args[3] === '--list') return Buffer.from('');
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
      ['create', 'custom', '--branch', 'fix/custom-branch'], {}, '/fake/root',
      { _exec: mockExec, _spawn: mockSpawn, _fs: mockFs, _platform: 'linux' }
    );

    const wtAdd = calls.find(c => c.cmd === 'git' && c.args[2] === 'worktree' && c.args[3] === 'add');
    expect(wtAdd).toBeTruthy();
    expect(wtAdd.args).toContain('fix/custom-branch');
    expect(wtAdd.args).not.toContain('feat/custom');
  });

  test('create returns an error when --branch is missing a value', async () => {
    const mod = require('../../lib/commands/worktree');
    const result = await mod.handler(['create', 'custom', '--branch'], {}, '/fake/root', {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing value for --branch');
  });

  // (m) create: runs package install after worktree creation
  test('create runs package manager install in worktree', async () => {
    const mod = require('../../lib/commands/worktree');
    const spawnCalls = [];
    const mockExec = (cmd, args, _opts) => {
      if (cmd === 'git' && args[0] === '-C' && args[2] === 'branch' && args[3] === '--list') return Buffer.from('');
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
      lstatSync: missingLstat,
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

// ---------------------------------------------------------------------------
// Regression (issue 7910146e): `forge worktree create` run from INSIDE a linked
// worktree must place the new worktree under the MAIN repository root's
// .worktrees/, never nested under <linked-worktree>/.worktrees/ (which blew the
// Windows path limit on removal: "Filename too long").
// ---------------------------------------------------------------------------
describe('forge worktree create/remove resolve the main worktree', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const { afterEach } = require('bun:test');
  const tempDirs = [];
  let previousCwd = null;

  function git(cwd, ...args) {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  }

  function tempDir(prefix) {
    const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    tempDirs.push(dir);
    return dir;
  }

  // Same fixture shape as worktree-base.test.js: init, local identity, one commit.
  function seedRepo(dir, initArgs = []) {
    fs.mkdirSync(dir, { recursive: true });
    git(dir, 'init', '-b', 'main', ...initArgs);
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-m', 'seed');
    return dir;
  }

  const stubOpts = () => ({
    _spawn: () => ({ status: 0 }),
    _platform: process.platform,
    _kernelDriver: { listWorktrees: () => [], getWorktree: () => null, upsertWorktree: () => {} },
    _kernelBroker: {},
    _ensureBackingIssue: async () => null,
  });

  afterEach(() => {
    if (previousCwd) { process.chdir(previousCwd); previousCwd = null; }
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
  });

  test('creates the new worktree under the main root .worktrees, not the linked worktree', async () => {
    const mod = require('../../lib/commands/worktree');
    const mainRoot = seedRepo(tempDir('forge-wt-root-'));
    const linkedPath = path.join(mainRoot, '.worktrees', 'linked');
    git(mainRoot, 'worktree', 'add', linkedPath, '-b', 'feat/linked');

    const result = await mod.handler(['create', 'nested', '--base', 'main'], {}, linkedPath, stubOpts());

    expect(result.success).toBe(true);
    const expected = path.join(mainRoot, '.worktrees', 'nested');
    expect(path.resolve(result.worktreePath)).toBe(path.resolve(expected));
    expect(fs.existsSync(path.join(expected, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(linkedPath, '.worktrees', 'nested'))).toBe(false);
  }, 30000);

  test('separate-git-dir layout: creates under the checkout, not beside the external git dir', async () => {
    const mod = require('../../lib/commands/worktree');
    const base = tempDir('forge-wt-sepgit-');
    const checkout = path.join(base, 'src', 'app');
    fs.mkdirSync(path.join(base, 'gitdirs'), { recursive: true });
    seedRepo(checkout, ['--separate-git-dir', path.join(base, 'gitdirs', 'app.git')]);

    const result = await mod.handler(['create', 'sep', '--base', 'main'], {}, checkout, stubOpts());

    expect(result.success).toBe(true);
    expect(path.resolve(result.worktreePath)).toBe(path.resolve(checkout, '.worktrees', 'sep'));
    expect(fs.existsSync(path.join(base, 'gitdirs', '.worktrees'))).toBe(false);
  }, 30000);

  test('separate-git-dir layout from a linked worktree: fails clearly instead of guessing', async () => {
    const mod = require('../../lib/commands/worktree');
    const base = tempDir('forge-wt-sepgit-linked-');
    const checkout = path.join(base, 'src', 'app');
    fs.mkdirSync(path.join(base, 'gitdirs'), { recursive: true });
    seedRepo(checkout, ['--separate-git-dir', path.join(base, 'gitdirs', 'app.git')]);
    const linkedPath = path.join(base, 'wt-linked');
    git(checkout, 'worktree', 'add', linkedPath, '-b', 'feat/linked');

    const result = await mod.handler(['create', 'lost', '--base', 'main'], {}, linkedPath, stubOpts());

    expect(result.success).toBe(false);
    expect(result.error).toContain('main worktree location unknown');
    expect(fs.existsSync(path.join(base, 'gitdirs', '.worktrees'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'gitdirs', 'app.git', '.worktrees'))).toBe(false);
  }, 30000);

  test('bare main worktree: create and remove fail clearly instead of guessing a root', async () => {
    const mod = require('../../lib/commands/worktree');
    const base = tempDir('forge-wt-bare-');
    const src = seedRepo(path.join(base, 'src'));
    const bare = path.join(base, 'app.git');
    git(base, 'clone', '--bare', src, bare);
    const linkedPath = path.join(base, 'wt-linked');
    git(bare, 'worktree', 'add', linkedPath, '-b', 'feat/linked', 'main');

    const created = await mod.handler(['create', 'guess', '--base', 'main'], {}, linkedPath, stubOpts());
    expect(created).toEqual({ success: false, error: 'bare repo detected' });
    expect(fs.existsSync(path.join(base, '.worktrees'))).toBe(false);

    const removed = await mod.handler(['remove', 'guess'], {}, linkedPath, {});
    expect(removed).toEqual({ success: false, error: 'bare repo detected' });
  }, 30000);

  test('remove falls back to a single registered legacy nested worktree with the slug', async () => {
    const mod = require('../../lib/commands/worktree');
    const mainRoot = seedRepo(tempDir('forge-wt-legacy-'));
    const linkedPath = path.join(mainRoot, '.worktrees', 'linked');
    git(mainRoot, 'worktree', 'add', linkedPath, '-b', 'feat/linked');
    // Legacy layout from the old bug: <linked>/.worktrees/<slug>.
    const nestedPath = path.join(linkedPath, '.worktrees', 'old');
    git(linkedPath, 'worktree', 'add', nestedPath, '-b', 'feat/old');

    previousCwd = process.cwd();
    process.chdir(linkedPath);
    const result = await mod.handler(['remove', 'old'], {}, linkedPath, {});

    expect(result.success).toBe(true);
    expect(path.resolve(result.removed)).toBe(path.resolve(nestedPath));
    expect(fs.existsSync(nestedPath)).toBe(false);
  }, 30000);

  function toplevelFailsStub(mainRoot, calls) {
    const target = path.join(mainRoot, '.worktrees', 'foo');
    return (cmd, args) => {
      calls.push(args.join(' '));
      if (cmd !== 'git') throw new Error(`unexpected ${cmd}`);
      if (args.includes('list')) {
        return [`worktree ${mainRoot.replace(/\\/g, '/')}`, 'HEAD 0123', 'branch refs/heads/main', '',
          `worktree ${target.replace(/\\/g, '/')}`, 'HEAD 0123', 'branch refs/heads/feat/foo', '', ''].join('\0');
      }
      if (args.includes('--show-toplevel')) throw new Error('ETIMEDOUT');
      const answers = { '--git-dir': path.join(mainRoot, '.git', 'worktrees', 'foo'), '--git-common-dir': path.join(mainRoot, '.git') };
      if (args.includes('rev-parse')) return args.filter((a) => answers[a]).map((a) => `${answers[a]}\n`).join('');
      if (args.includes('core.worktree')) throw new Error('unset');
      return '';
    };
  }

  test('remove refuses when the invoking checkout cannot be resolved (show-toplevel fails)', async () => {
    const mod = require('../../lib/commands/worktree');
    const mainRoot = path.resolve('/fake/main');
    const calls = [];
    const result = await mod.handler(['remove', 'foo'], {}, path.join(mainRoot, '.worktrees', 'foo', 'sub'),
      { _exec: toplevelFailsStub(mainRoot, calls) });

    expect(result.success).toBe(false);
    expect(result.error).toContain('invoking checkout');
    expect(calls.some((c) => c.includes('worktree remove'))).toBe(false);
  });

  test('remove refuses a worktree that CONTAINS the invoking checkout (legacy nested A/.worktrees/B)', async () => {
    const mod = require('../../lib/commands/worktree');
    const mainRoot = seedRepo(tempDir('forge-wt-ancestor-'));
    // Like this repo: .worktrees/ is ignored, so git would not refuse on B's files.
    fs.writeFileSync(path.join(mainRoot, '.gitignore'), '.worktrees/\n');
    git(mainRoot, 'add', '.gitignore');
    git(mainRoot, 'commit', '-m', 'ignore worktrees');
    const aPath = path.join(mainRoot, '.worktrees', 'A');
    git(mainRoot, 'worktree', 'add', aPath, '-b', 'feat/a');
    const bPath = path.join(aPath, '.worktrees', 'B');
    git(aPath, 'worktree', 'add', bPath, '-b', 'feat/b');
    const bWip = path.join(bPath, 'wip.txt');
    fs.writeFileSync(bWip, 'uncommitted work\n');

    previousCwd = process.cwd();
    process.chdir(bPath);
    let result;
    try {
      result = await mod.handler(['remove', 'A'], {}, bPath, {});
    } catch (error) {
      result = { success: 'threw', error: error.message };
    }

    expect(result.success).toBe(false);
    expect(result.error).toContain('nested inside it');
    expect(fs.existsSync(aPath)).toBe(true);
    expect(fs.existsSync(bPath)).toBe(true);
    expect(fs.existsSync(bWip)).toBe(true);
  }, 30000);

  function nestedLayout(prefix) {
    const mainRoot = seedRepo(tempDir(prefix));
    // Like this repo: .worktrees/ is ignored, so git would not refuse on B's files.
    fs.writeFileSync(path.join(mainRoot, '.gitignore'), '.worktrees/\n');
    git(mainRoot, 'add', '.gitignore');
    git(mainRoot, 'commit', '-m', 'ignore worktrees');
    const aPath = path.join(mainRoot, '.worktrees', 'A');
    git(mainRoot, 'worktree', 'add', aPath, '-b', 'feat/a');
    const bPath = path.join(aPath, '.worktrees', 'B');
    git(aPath, 'worktree', 'add', bPath, '-b', 'feat/b');
    const bWip = path.join(bPath, 'wip.txt');
    fs.writeFileSync(bWip, 'uncommitted work\n');
    const cPath = path.join(mainRoot, '.worktrees', 'C');
    git(mainRoot, 'worktree', 'add', cPath, '-b', 'feat/c');
    return { mainRoot, aPath, bPath, bWip, cPath };
  }

  test('remove refuses A from sibling C while a registered worktree B is nested inside A', async () => {
    const mod = require('../../lib/commands/worktree');
    const { mainRoot, aPath, bPath, bWip, cPath } = nestedLayout('forge-wt-nested-sibling-');

    previousCwd = process.cwd();
    process.chdir(cPath);
    let result;
    try {
      result = await mod.handler(['remove', 'A'], {}, cPath, {});
    } catch (error) {
      result = { success: 'threw', error: error.message };
    }

    expect(result.success).toBe(false);
    expect(result.error).toContain('nested inside it');
    expect(result.error).toContain(path.basename(bPath));
    expect(fs.existsSync(aPath)).toBe(true);
    expect(fs.existsSync(bWip)).toBe(true);
    const list = git(mainRoot, 'worktree', 'list', '--porcelain');
    expect(list).toContain(bPath.replace(/\\/g, '/'));
    expect(list).not.toContain('prunable');
  }, 30000);

  test('remove A is NOT blocked by a sibling worktree AB sharing its name prefix', async () => {
    const mod = require('../../lib/commands/worktree');
    const mainRoot = seedRepo(tempDir('forge-wt-prefix-'));
    const aPath = path.join(mainRoot, '.worktrees', 'A');
    const abPath = path.join(mainRoot, '.worktrees', 'AB');
    git(mainRoot, 'worktree', 'add', aPath, '-b', 'feat/a');
    git(mainRoot, 'worktree', 'add', abPath, '-b', 'feat/ab');

    previousCwd = process.cwd();
    process.chdir(mainRoot);
    const result = await mod.handler(['remove', 'A'], {}, mainRoot, {});

    expect(result.success).toBe(true);
    expect(fs.existsSync(aPath)).toBe(false);
    expect(fs.existsSync(abPath)).toBe(true);
  }, 30000);

  test('remove fails closed when the registered worktree list cannot be read', async () => {
    const mod = require('../../lib/commands/worktree');
    const calls = [];
    const result = await mod.handler(['remove', 'foo'], {}, path.resolve('/fake/root'), {
      _exec: (cmd, args) => {
        calls.push(args.join(' '));
        if (args.includes('list')) throw new Error('git worktree list failed');
        return '';
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('worktree list');
    expect(calls.some((c) => c.includes('worktree remove'))).toBe(false);
  });

  test('remove refuses to remove the checkout it is invoked from (even from a subdirectory)', async () => {
    const mod = require('../../lib/commands/worktree');
    const mainRoot = seedRepo(tempDir('forge-wt-self-remove-'));
    const targetPath = path.join(mainRoot, '.worktrees', 'foo');
    git(mainRoot, 'worktree', 'add', targetPath, '-b', 'feat/foo');
    const subdir = path.join(targetPath, 'sub');
    fs.mkdirSync(subdir, { recursive: true });

    previousCwd = process.cwd();
    process.chdir(subdir);
    let result;
    try {
      result = await mod.handler(['remove', 'foo'], {}, subdir, {});
    } catch (error) {
      result = { success: 'threw', error: error.message };
    }

    expect(result.success).toBe(false);
    expect(result.error).toContain('run remove from another checkout');
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(git(mainRoot, 'worktree', 'list', '--porcelain')).toContain(targetPath.replace(/\\/g, '/'));
  }, 30000);
});
