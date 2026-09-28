'use strict';

// Regression (issue 720eda2b, PR #582): worktrees share the main checkout's
// node_modules through a link (a junction on Windows). `git worktree remove`
// (and `--force`) follows a junction and empties the linked target, so both
// `forge worktree remove` and `forge clean` must detach the link first, never
// follow it, and refuse the removal when it cannot be detached.

const { describe, test, expect } = require('bun:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const worktree = require('../../lib/commands/worktree');
const clean = require('../../lib/commands/clean');

const LINK_ERRORS = new Set(['EPERM', 'EACCES', 'ENOSYS', 'UV_EPERM']);
const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir';

// Real temp dirs: a sentinel "shared install" and a worktree whose node_modules
// links to it. Returns null when this host cannot create links.
function makeFixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-wt-rm-link-'));
  const mainRoot = path.join(tmp, 'main');
  const sentinel = path.join(mainRoot, 'node_modules');
  const worktreePath = path.join(mainRoot, '.worktrees', 'linked');
  fs.mkdirSync(path.join(sentinel, 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(sentinel, 'left-pad', 'package.json'), '{"name":"left-pad"}');
  fs.mkdirSync(worktreePath, { recursive: true });
  fs.writeFileSync(path.join(worktreePath, 'README.md'), 'wt');
  try {
    fs.symlinkSync(sentinel, path.join(worktreePath, 'node_modules'), LINK_TYPE);
  } catch (error) {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (LINK_ERRORS.has(error.code)) return null;
    throw error;
  }
  return { tmp, mainRoot, sentinel, worktreePath };
}

// Emulates the observed git behaviour: removal walks INTO a still-attached
// node_modules link and deletes the target's contents, then drops the tree.
function followingRemove(wtPath) {
  const modules = path.join(wtPath, 'node_modules');
  if (fs.existsSync(modules)) {
    for (const entry of fs.readdirSync(modules)) fs.rmSync(path.join(modules, entry), { recursive: true, force: true });
  }
  fs.rmSync(wtPath, { recursive: true, force: true });
}

function sentinelIntact(f) {
  return fs.existsSync(path.join(f.sentinel, 'left-pad', 'package.json'));
}

function repoExec(mainRoot, onRemove) {
  const main = path.resolve(mainRoot);
  return (cmd, args) => {
    if (cmd !== 'git') return Buffer.from('');
    if (args.includes('worktree') && args.includes('remove')) return onRemove(args[args.length - 1]);
    if (args.includes('list')) return [`worktree ${main.replace(/\\/g, '/')}`, 'HEAD 0123', 'branch refs/heads/main', '', ''].join('\0');
    const answers = { '--git-dir': path.join(main, '.git'), '--git-common-dir': path.join(main, '.git'), '--show-toplevel': main };
    if (args.includes('rev-parse')) return args.filter((a) => answers[a]).map((a) => `${answers[a]}\n`).join('');
    if (args.includes('core.worktree')) throw new Error('unset');
    return Buffer.from('');
  };
}

describe('worktree removal never follows a shared node_modules link', () => {
  test('forge worktree remove detaches the link first; the linked target is intact', async () => {
    const f = makeFixture();
    if (!f) return;
    try {
      const result = await worktree.handler(['remove', 'linked'], {}, f.mainRoot, {
        _exec: repoExec(f.mainRoot, (wtPath) => { followingRemove(wtPath); return Buffer.from(''); }),
      });

      expect(result.success).toBe(true);
      expect(fs.existsSync(f.worktreePath)).toBe(false);
      expect(sentinelIntact(f)).toBe(true);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  }, 20000);

  test('forge worktree remove refuses when the link cannot be detached', async () => {
    const f = makeFixture();
    if (!f) return;
    try {
      let removeCalled = false;
      const result = await worktree.handler(['remove', 'linked'], {}, f.mainRoot, {
        _exec: repoExec(f.mainRoot, () => { removeCalled = true; return Buffer.from(''); }),
        _fs: {
          ...fs,
          unlinkSync: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; },
          rmdirSync: () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; },
        },
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/node_modules/);
      expect(removeCalled).toBe(false);
      expect(sentinelIntact(f)).toBe(true);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  }, 20000);

  test('forge clean removal detaches the link first; the linked target is intact', async () => {
    const f = makeFixture();
    if (!f) return;
    try {
      const runFile = (cmd, args) => {
        if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'remove') followingRemove(args[args.length - 1]);
        return Buffer.from('');
      };
      const outcome = await clean._internals.removeWorktreeRobust(f.worktreePath, runFile, fs, { _sleep: async () => {} });

      expect(outcome.removed).toBe(true);
      expect(fs.existsSync(f.worktreePath)).toBe(false);
      expect(sentinelIntact(f)).toBe(true);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  }, 20000);

  test('forge clean refuses the removal when the link cannot be detached', async () => {
    const f = makeFixture();
    if (!f) return;
    try {
      const gitCalls = [];
      const runFile = (cmd, args) => { gitCalls.push(args); return Buffer.from(''); };
      const busy = () => { const e = new Error('busy'); e.code = 'EBUSY'; throw e; };
      const outcome = await clean._internals.removeWorktreeRobust(
        f.worktreePath, runFile, { ...fs, unlinkSync: busy, rmdirSync: busy, rmSync: busy }, { _sleep: async () => {} },
      );

      expect(outcome.removed).toBe(false);
      expect(outcome.error).toMatch(/node_modules/);
      expect(gitCalls).toHaveLength(0);
      expect(sentinelIntact(f)).toBe(true);
    } finally {
      fs.rmSync(f.tmp, { recursive: true, force: true });
    }
  }, 20000);
});
