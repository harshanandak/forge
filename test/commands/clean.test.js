'use strict';

const path = require('node:path');
const { describe, test, expect } = require('bun:test');

// ---------------------------------------------------------------------------
// forge clean command — test/forge-clean.test.js
// ---------------------------------------------------------------------------

describe('forge clean command', () => {
  // (a) Module exports correct shape
  test('exports name, description, usage, flags, and handler', () => {
    const mod = require('../../lib/commands/clean');
    expect(mod.name).toBe('clean');
    expect(typeof mod.description).toBe('string');
    expect(typeof mod.usage).toBe('string');
    expect(mod.flags).toHaveProperty('--dry-run');
    expect(typeof mod.handler).toBe('function');
  });

  // (b) Scans .worktrees/ directory
  test('scans .worktrees/ directory for worktree dirs', async () => {
    const mod = require('../../lib/commands/clean');
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
    const mod = require('../../lib/commands/clean');
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

  // (d) Cleanup is pure git — no per-worktree issue-store server to stop
  test('removes merged worktrees with pure git (no server-stop step)', async () => {
    const mod = require('../../lib/commands/clean');
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
      if (cmd !== 'git') {
        throw new Error(`unexpected non-git command: ${cmd}`);
      }
      if (args[0] === 'branch' && args[1] === '--merged') {
        return Buffer.from('  feat/done-feature\n');
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        const wtPath = path.resolve('/fake/root', '.worktrees', 'done-feature');
        return Buffer.from(`worktree ${wtPath}\nbranch refs/heads/feat/done-feature\n\n`);
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        callOrder.push('worktreeRemove');
        return Buffer.from('');
      }
      return Buffer.from('');
    };

    await mod.handler([], {}, '/fake/root', { _exec: mockExec, _fs: mockFs });
    expect(callOrder).toEqual(['worktreeRemove']);
  });

  // (e) --dry-run reports without removing
  test('--dry-run lists what would be cleaned without removing', async () => {
    const mod = require('../../lib/commands/clean');
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
    const mod = require('../../lib/commands/clean');
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
    const mod = require('../../lib/commands/clean');
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
    const mod = require('../../lib/commands/clean');
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

// ---------------------------------------------------------------------------
// Squash-merge awareness + Windows-robust removal + master auto-update
// ---------------------------------------------------------------------------

const ROOT = '/fake/root';
const wt = (name) => path.resolve(ROOT, '.worktrees', name);
const noopSync = async () => ({ attempted: false });

/** fs mock exposing a single .worktrees dir listing. */
function fsWith(names, over = {}) {
  return {
    existsSync: () => true,
    readdirSync: (_p, opts) =>
      (opts && opts.withFileTypes) ? names.map(n => ({ name: n, isDirectory: () => true })) : [],
    readFileSync: () => '',
    ...over,
  };
}

describe('forge clean — squash-merge aware detection', () => {
  test('removes a squash-merged worktree missed by git branch --merged', async () => {
    const mod = require('../../lib/commands/clean');
    const removed = [];
    const mockExec = (cmd, args) => {
      if (cmd === 'gh') return Buffer.from('[]'); // no PR signal
      if (cmd !== 'git') return Buffer.from('');
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return Buffer.from('origin/main');
      // Ancestry check does NOT list the squash-merged branch (only main).
      if (args[0] === 'branch' && args[1] === '--merged') return Buffer.from('  main\n');
      if (args[0] === 'worktree' && args[1] === 'list') {
        return Buffer.from(`worktree ${wt('sq')}\nbranch refs/heads/feat/sq\n\n`);
      }
      // Squash patch-equivalence path.
      if (args[0] === 'merge-base') return Buffer.from('basesha\n');
      if (args[0] === 'rev-parse' && String(args[1]).endsWith('^{tree}')) return Buffer.from('treesha\n');
      if (args[0] === 'commit-tree') return Buffer.from('synthsha\n');
      if (args[0] === 'cherry') return Buffer.from('- 1234567 squashed change\n'); // equivalent exists
      if (args[0] === 'worktree' && args[1] === 'remove') { removed.push(args[2]); return Buffer.from(''); }
      return Buffer.from('');
    };
    const result = await mod.handler([], {}, ROOT, { _exec: mockExec, _fs: fsWith(['sq']), _syncMaster: noopSync });
    expect(result.cleaned).toBe(1);
    expect(result.active).toBe(0);
    expect(removed[0]).toBe(wt('sq'));
  });

  test('keeps an unmerged branch (cherry shows a new commit)', async () => {
    const mod = require('../../lib/commands/clean');
    const removed = [];
    const mockExec = (cmd, args) => {
      if (cmd === 'gh') return Buffer.from('[]');
      if (cmd !== 'git') return Buffer.from('');
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return Buffer.from('origin/main');
      if (args[0] === 'branch' && args[1] === '--merged') return Buffer.from('  main\n');
      if (args[0] === 'worktree' && args[1] === 'list') {
        return Buffer.from(`worktree ${wt('wip')}\nbranch refs/heads/feat/wip\n\n`);
      }
      if (args[0] === 'merge-base') return Buffer.from('basesha\n');
      if (args[0] === 'rev-parse' && String(args[1]).endsWith('^{tree}')) return Buffer.from('treesha\n');
      if (args[0] === 'commit-tree') return Buffer.from('synthsha\n');
      if (args[0] === 'cherry') return Buffer.from('+ 89abcde new work\n'); // NOT merged
      if (args[0] === 'worktree' && args[1] === 'remove') { removed.push(args[2]); return Buffer.from(''); }
      return Buffer.from('');
    };
    const result = await mod.handler([], {}, ROOT, { _exec: mockExec, _fs: fsWith(['wip']), _syncMaster: noopSync });
    expect(result.cleaned).toBe(0);
    expect(result.active).toBe(1);
    expect(removed.length).toBe(0);
  });

  test('removes a branch reported merged by gh even without ancestry/cherry signal', async () => {
    const mod = require('../../lib/commands/clean');
    const removed = [];
    const mockExec = (cmd, args) => {
      if (cmd === 'gh') return Buffer.from(JSON.stringify([{ headRefName: 'feat/pr' }]));
      if (cmd !== 'git') return Buffer.from('');
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return Buffer.from('origin/main');
      if (args[0] === 'branch' && args[1] === '--merged') return Buffer.from('  main\n');
      if (args[0] === 'worktree' && args[1] === 'list') {
        return Buffer.from(`worktree ${wt('pr')}\nbranch refs/heads/feat/pr\n\n`);
      }
      if (args[0] === 'merge-base') return Buffer.from(''); // no squash signal
      if (args[0] === 'worktree' && args[1] === 'remove') { removed.push(args[2]); return Buffer.from(''); }
      return Buffer.from('');
    };
    const result = await mod.handler([], {}, ROOT, { _exec: mockExec, _fs: fsWith(['pr']), _syncMaster: noopSync });
    expect(result.cleaned).toBe(1);
    expect(removed[0]).toBe(wt('pr'));
  });

  test('_internals.isSquashMerged returns true only when cherry emits a "-" line', () => {
    const { _internals } = require('../../lib/commands/clean');
    const runMerged = (cmd, args) => {
      if (args[0] === 'merge-base') return Buffer.from('base');
      if (args[0] === 'rev-parse') return Buffer.from('tree');
      if (args[0] === 'commit-tree') return Buffer.from('synth');
      if (args[0] === 'cherry') return Buffer.from('- deadbee equiv');
      return Buffer.from('');
    };
    const runNot = (cmd, args) => (args[0] === 'cherry' ? Buffer.from('+ deadbee new') : runMerged(cmd, args));
    expect(_internals.isSquashMerged('feat/x', 'main', runMerged)).toBe(true);
    expect(_internals.isSquashMerged('feat/x', 'main', runNot)).toBe(false);
  });
});

describe('forge clean — Windows-robust removal', () => {
  test('falls back to --force after plain remove fails, still counts as cleaned', async () => {
    const mod = require('../../lib/commands/clean');
    let plainTries = 0;
    let forced = false;
    const mockExec = (cmd, args) => {
      if (cmd === 'gh') return Buffer.from('[]');
      if (cmd !== 'git') return Buffer.from('');
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return Buffer.from('origin/main');
      if (args[0] === 'branch' && args[1] === '--merged') return Buffer.from('  feat/done\n  main\n');
      if (args[0] === 'worktree' && args[1] === 'list') {
        return Buffer.from(`worktree ${wt('done')}\nbranch refs/heads/feat/done\n\n`);
      }
      if (args[0] === 'worktree' && args[1] === 'remove') {
        if (args[2] === '--force') { forced = true; return Buffer.from(''); }
        plainTries++;
        const e = new Error('fatal: cannot remove: Directory not empty');
        throw e;
      }
      return Buffer.from('');
    };
    const result = await mod.handler([], {}, ROOT, {
      _exec: mockExec, _fs: fsWith(['done']), _syncMaster: noopSync,
      _sleep: async () => {}, _maxTries: 2,
    });
    expect(plainTries).toBe(2);      // retried up to maxTries
    expect(forced).toBe(true);       // then forced
    expect(result.cleaned).toBe(1);
    expect(result.survivors.length).toBe(0);
  });

  test('reports survivors (never silently) when even force + prune fail', async () => {
    const mod = require('../../lib/commands/clean');
    const mockExec = (cmd, args) => {
      if (cmd === 'gh') return Buffer.from('[]');
      if (cmd !== 'git') return Buffer.from('');
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return Buffer.from('origin/main');
      if (args[0] === 'branch' && args[1] === '--merged') return Buffer.from('  feat/stuck\n  main\n');
      if (args[0] === 'worktree' && args[1] === 'list') {
        return Buffer.from(`worktree ${wt('stuck')}\nbranch refs/heads/feat/stuck\n\n`);
      }
      if (args[0] === 'worktree' && args[1] === 'remove') { throw new Error('EPERM: operation not permitted'); }
      return Buffer.from('');
    };
    // existsSync stays true → manual rm cannot confirm removal.
    const fsMock = fsWith(['stuck'], { rmSync: () => { /* locked, no-op */ } });
    const result = await mod.handler([], {}, ROOT, {
      _exec: mockExec, _fs: fsMock, _syncMaster: noopSync, _sleep: async () => {}, _maxTries: 1,
    });
    expect(result.cleaned).toBe(0);
    expect(result.survivors.length).toBe(1);
    expect(result.survivors[0].path).toBe(wt('stuck'));
    expect(result.output).toContain('WARNING');
  });

  test('skips a dirty merged worktree instead of destroying uncommitted work', async () => {
    const mod = require('../../lib/commands/clean');
    const removed = [];
    const mockExec = (cmd, args) => {
      if (cmd === 'gh') return Buffer.from('[]');
      if (cmd !== 'git') return Buffer.from('');
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return Buffer.from('origin/main');
      if (args[0] === 'branch' && args[1] === '--merged') return Buffer.from('  feat/dirty\n  main\n');
      if (args[0] === 'worktree' && args[1] === 'list') {
        return Buffer.from(`worktree ${wt('dirty')}\nbranch refs/heads/feat/dirty\n\n`);
      }
      if (args[0] === '-C' && args[2] === 'status') return Buffer.from(' M lib/thing.js\n'); // dirty
      if (args[0] === 'worktree' && args[1] === 'remove') { removed.push(args[2]); return Buffer.from(''); }
      return Buffer.from('');
    };
    const result = await mod.handler([], {}, ROOT, { _exec: mockExec, _fs: fsWith(['dirty']), _syncMaster: noopSync });
    expect(removed.length).toBe(0);
    expect(result.cleaned).toBe(0);
    expect(result.dirty.length).toBe(1);
    expect(result.output.toLowerCase()).toContain('dirty');
  });
});

describe('forge clean — master auto-update', () => {
  function syncExec(behindCount, aheadCount, mainBranch, extra = {}) {
    return (cmd, args) => {
      if (cmd === 'gh') return Buffer.from('[]');
      if (cmd !== 'git') return Buffer.from('');
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return Buffer.from('origin/main');
      if (args[0] === 'branch' && args[1] === '--merged') return Buffer.from('  main\n');
      if (args[0] === 'worktree' && args[1] === 'list') {
        return Buffer.from(
          `worktree /main\nHEAD abc\nbranch refs/heads/${mainBranch}\n\n` +
          `worktree ${wt('done')}\nbranch refs/heads/feat/done\n\n`
        );
      }
      if (args[0] === '-C' && args[2] === 'rev-list') {
        const range = args[4];
        if (range === 'main..origin/main') return Buffer.from(String(behindCount));
        if (range === 'origin/main..main') return Buffer.from(String(aheadCount));
        return Buffer.from('0');
      }
      if (extra.onExec) extra.onExec(cmd, args);
      return Buffer.from('');
    };
  }

  test('fast-forwards the checked-out default branch when behind', async () => {
    const mod = require('../../lib/commands/clean');
    let ffCalled = false;
    const exec = syncExec(3, 0, 'main', {
      onExec: (cmd, args) => {
        if (args[0] === '-C' && args[2] === 'merge' && args[3] === '--ff-only') ffCalled = true;
      },
    });
    const result = await mod.handler([], {}, ROOT, { _exec: exec, _fs: fsWith([]) });
    expect(ffCalled).toBe(true);
    expect(result.masterSync.synced).toBe(true);
    expect(result.masterSync.behind).toBe(3);
    expect(result.output).toContain('Fast-forwarded');
  });

  test('does NOT touch a diverged default branch (behind AND ahead)', async () => {
    const mod = require('../../lib/commands/clean');
    let ffCalled = false;
    const exec = syncExec(3, 2, 'main', {
      onExec: (cmd, args) => {
        if (args[0] === '-C' && args[3] === 'merge') ffCalled = true;
      },
    });
    const result = await mod.handler([], {}, ROOT, { _exec: exec, _fs: fsWith([]) });
    expect(ffCalled).toBe(false);
    expect(result.masterSync.synced).toBe(false);
    expect(result.masterSync.reason).toBe('diverged');
  });

  test('--no-master-sync disables the fast-forward step', async () => {
    const mod = require('../../lib/commands/clean');
    let ffCalled = false;
    const exec = syncExec(3, 0, 'main', {
      onExec: (cmd, args) => { if (args[0] === '-C' && args[2] === 'merge') ffCalled = true; },
    });
    const result = await mod.handler([], { '--no-master-sync': true }, ROOT, { _exec: exec, _fs: fsWith([]) });
    expect(ffCalled).toBe(false);
    expect(result.masterSync).toBeNull();
  });

  test('dry-run performs no master sync', async () => {
    const mod = require('../../lib/commands/clean');
    let ffCalled = false;
    const exec = syncExec(3, 0, 'main', {
      onExec: (cmd, args) => { if (args[0] === '-C' && args[2] === 'merge') ffCalled = true; },
    });
    const result = await mod.handler([], { '--dry-run': true }, ROOT, { _exec: exec, _fs: fsWith([]) });
    expect(ffCalled).toBe(false);
    expect(result.masterSync).toBeNull();
  });

  test('_internals.parseUntrackedOverwrites extracts the blocked files', () => {
    const { _internals } = require('../../lib/commands/clean');
    const stderr = [
      'error: The following untracked working tree files would be overwritten by merge:',
      '\tdocs/new.md',
      '\tlib/added.js',
      'Please move or remove them before you merge.',
      'Aborting',
    ].join('\n');
    expect(_internals.parseUntrackedOverwrites(stderr)).toEqual(['docs/new.md', 'lib/added.js']);
  });
});
