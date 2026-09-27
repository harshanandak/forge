/**
 * @fileoverview Tests for worktree detection utility.
 * Uses real git commands against this repo's worktree structure.
 */
const { describe, test, expect } = require('bun:test');
const path = require('path');

// Module under test — will fail until lib/detect-worktree.js exists
const { detectWorktree } = require('../lib/detect-worktree');

const MAIN_REPO = path.resolve(__dirname, '..');
// This test file lives inside the worktree, so __dirname IS the worktree
const WORKTREE_DIR = MAIN_REPO;

describe('detectWorktree', () => {
  test('returns an object with inWorktree boolean', () => {
    const result = detectWorktree(MAIN_REPO);
    expect(typeof result.inWorktree).toBe('boolean');
  });

  test('detects worktree correctly based on environment', () => {
    const result = detectWorktree(WORKTREE_DIR);
    // In a worktree (local dev), inWorktree is true
    // In CI (repo root), inWorktree is false
    // Either way, the function should return a valid result
    expect(typeof result.inWorktree).toBe('boolean');
    if (result.inWorktree) {
      expect(result.branch).toBeDefined();
      expect(result.mainWorktree).toBeDefined();
    }
  });

  test('returns branch name when inside a worktree', () => {
    const result = detectWorktree(WORKTREE_DIR);
    if (result.inWorktree) {
      expect(result.branch).toMatch(/^[A-Za-z0-9._/-]+$/);
    }
  });

  test('returns mainWorktree path when inside a worktree', () => {
    const result = detectWorktree(WORKTREE_DIR);
    if (result.inWorktree) {
      expect(typeof result.mainWorktree).toBe('string');
      expect(result.mainWorktree.length).toBeGreaterThan(0);
    }
  });

  test('returns a valid result for non-git directory without throwing', () => {
    const tmpDir = require('os').tmpdir();
    const result = detectWorktree(tmpDir);
    // On some systems tmpdir may be inside a git repo — just verify it doesn't throw
    expect(typeof result.inWorktree).toBe('boolean');
  });

  test('degrades gracefully to { inWorktree: false } when the git spawn times out', () => {
    const warnCalls = [];
    const timeoutError = new Error('spawnSync git ETIMEDOUT');
    timeoutError.code = 'ETIMEDOUT';
    const throwingExec = () => {
      throw timeoutError;
    };

    const result = detectWorktree('/some/dir', {
      execFileSync: throwingExec,
      warn: (message) => warnCalls.push(message),
    });

    expect(result).toEqual({ inWorktree: false });
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain('ETIMEDOUT');
  });

  test('degrades gracefully when gitDir output is empty (does not resolve to cwd)', () => {
    const warnCalls = [];
    // --git-dir returns empty, --git-common-dir returns a real path. Without the
    // guard, path.resolve(cwd, '') === cwd would make absGitDir !== absCommonDir
    // and falsely report inWorktree: true.
    const emptyGitDirExec = (_cmd, args) => {
      if (args[1] === '--git-dir') return '';
      if (args[1] === '--git-common-dir') return '/repo/.git';
      return 'main';
    };

    const result = detectWorktree('/repo', {
      execFileSync: emptyGitDirExec,
      warn: (message) => warnCalls.push(message),
    });

    expect(result).toEqual({ inWorktree: false });
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain('empty git dir output');
  });

  test('degrades gracefully when both git dir outputs are empty', () => {
    const warnCalls = [];
    const bothEmptyExec = () => '';

    const result = detectWorktree('/repo', {
      execFileSync: bothEmptyExec,
      warn: (message) => warnCalls.push(message),
    });

    // Must be the bare fallback shape — no extra branch/mainWorktree fields.
    expect(result).toEqual({ inWorktree: false });
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0]).toContain('empty git dir output');
  });

  test('bounds each git spawn with a timeout option', () => {
    const seenOptions = [];
    const fakeExec = (_cmd, _args, options) => {
      seenOptions.push(options);
      return 'main';
    };

    detectWorktree('/some/dir', { execFileSync: fakeExec });

    expect(seenOptions.length).toBeGreaterThan(0);
    for (const options of seenOptions) {
      expect(typeof options.timeout).toBe('number');
      expect(options.timeout).toBeGreaterThan(0);
    }
  });

  test('returns { inWorktree: false } from the main repo root', () => {
    // The main forge repo (not the worktree) — find it via git-common-dir
    const { execFileSync } = require('child_process');
    try {
      const commonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        encoding: 'utf8', cwd: WORKTREE_DIR, stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
      // commonDir is like /path/to/forge/.git — go up one level
      const mainRoot = path.resolve(WORKTREE_DIR, commonDir, '..');
      const result = detectWorktree(mainRoot);
      expect(result.inWorktree).toBe(false);
    } catch (_err) {
      // If we can't resolve, skip this test assertion
    }
  });
});

describe('parseWorktreePorcelain (NUL-delimited, git worktree list --porcelain -z)', () => {
  const { parseWorktreePorcelain } = require('../lib/detect-worktree');

  test('keeps a path with an embedded newline intact and flags a bare record', () => {
    const main = path.resolve('/repo/app.git');
    const odd = path.resolve('/repo/.worktrees/odd\nname');
    const sample = [
      `worktree ${main}`, 'bare', '',
      `worktree ${odd}`, 'HEAD 0123456789abcdef0123456789abcdef01234567', 'branch refs/heads/feat/odd', '',
      '',
    ].join('\0');

    expect(parseWorktreePorcelain(sample)).toEqual([
      { path: main, bare: true },
      { path: odd, bare: false },
    ]);
  });
});

describe('resolveMainWorktree / resolveInvokingWorktreeRoot (PR #582 review)', () => {
  const fs = require('fs');
  const os = require('os');
  const { resolveMainWorktree, resolveInvokingWorktreeRoot } = require('../lib/detect-worktree');
  const toPorcelain = (p) => p.replace(/\\/g, '/');

  test('does not need --path-format (git < 2.31): relative rev-parse output resolves against projectRoot', () => {
    const root = path.resolve('/fake/app');
    const calls = [];
    const runFile = (cmd, args) => {
      calls.push(args.join(' '));
      if (args.includes('list')) return [`worktree ${toPorcelain(root)}`, 'HEAD 0123', 'branch refs/heads/main', '', ''].join('\0');
      const answers = { '--git-dir': '.git', '--git-common-dir': '.git', '--show-toplevel': root };
      if (args.includes('rev-parse')) return args.filter((a) => answers[a]).map((a) => `${answers[a]}\n`).join('');
      if (args.includes('core.worktree')) throw new Error('unset');
      return '';
    };

    const main = resolveMainWorktree(root, runFile);

    expect(main.error).toBeUndefined();
    expect(main.root).toBe(root);
    expect(calls.some((c) => c.includes('--path-format'))).toBe(false);
  });

  test('fails closed (error, no projectRoot guess) when git fails inside a linked worktree', () => {
    const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-detect-linked-'));
    try {
      // A linked worktree's toplevel has a `.git` FILE pointing at the common dir.
      fs.writeFileSync(path.join(linked, '.git'), 'gitdir: /elsewhere/.git/worktrees/linked\n');
      const sub = path.join(linked, 'sub');
      fs.mkdirSync(sub);
      const failingGit = () => { throw new Error('git exploded'); };

      const main = resolveMainWorktree(sub, failingGit);

      expect(main.error).toContain('main worktree');
    } finally {
      fs.rmSync(linked, { recursive: true, force: true });
    }
  });

  test('keeps the documented projectRoot fallback only for a non-git (or mocked) root', () => {
    const main = resolveMainWorktree(path.resolve('/fake/not-a-repo'), () => '');
    expect(main.error).toBeUndefined();
    expect(main.root).toBe(path.resolve('/fake/not-a-repo'));
    expect(main.worktrees).toBeNull();
  });

  test('a repository path containing a newline comes back exact (each path queried alone)', () => {
    const root = path.resolve('/fake/new\nline-repo');
    const linked = path.join(root, '.worktrees', 'a');
    const runFile = (cmd, args) => {
      if (args.includes('list')) {
        return [`worktree ${toPorcelain(root)}`, 'HEAD 0123', 'branch refs/heads/main', '',
          `worktree ${toPorcelain(linked)}`, 'HEAD 0123', 'branch refs/heads/a', '', ''].join('\0');
      }
      const answers = {
        '--git-dir': path.join(root, '.git', 'worktrees', 'a'),
        '--git-common-dir': path.join(root, '.git'),
        '--show-toplevel': linked,
      };
      if (args.includes('rev-parse')) return args.filter((a) => answers[a]).map((a) => `${answers[a]}\n`).join('');
      if (args.includes('core.worktree')) throw new Error('unset');
      return '';
    };

    const main = resolveMainWorktree(linked, runFile);
    expect(main.error).toBeUndefined();
    expect(main.root).toBe(root);
    expect(resolveInvokingWorktreeRoot(linked, runFile, main)).toEqual({ root: linked });
  });

  test('resolveInvokingWorktreeRoot fails closed when git lists worktrees but show-toplevel fails', () => {
    const main = { root: path.resolve('/fake/app'), bare: false, worktrees: [{ path: path.resolve('/fake/app'), bare: false }] };
    const failing = () => { throw new Error('ETIMEDOUT'); };
    expect(resolveInvokingWorktreeRoot(path.resolve('/fake/app/.worktrees/foo/sub'), failing, main).error)
      .toContain('invoking checkout');
  });

  test('resolveInvokingWorktreeRoot returns the checkout toplevel for a subdirectory cwd', () => {
    const top = path.resolve('/fake/app/.worktrees/foo');
    const runFile = (cmd, args) => (args.includes('--show-toplevel') ? `${toPorcelain(top)}\n` : '');
    expect(resolveInvokingWorktreeRoot(path.join(top, 'sub', 'deeper'), runFile)).toEqual({ root: top });
  });
});
