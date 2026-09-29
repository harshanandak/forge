const { describe, test, expect, afterEach } = require('bun:test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('node:child_process');

const {
  createEvalWorktree,
  destroyEvalWorktree,
  parseWorktreeListPaths,
} = require('../../scripts/lib/eval-runner');

const T = 30000;
const NUL = String.fromCharCode(0);
const isWin = process.platform === 'win32';
const EVAL_RUNNER = path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'eval-runner.js');

const originalCwd = process.cwd();
const tempRoots = [];

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
}

// Build a throwaway repo at <tmp>/<dirName> and chdir into it (eval-runner
// resolves the repo root from process.cwd()).
function makeRepo(dirName) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-eval-safety-'));
  tempRoots.push(base);
  const repo = path.join(base, dirName);
  fs.mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'eval@example.com']);
  git(repo, ['config', 'user.name', 'Eval Test']);
  git(repo, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'eval\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-q', '-m', 'init']);
  process.chdir(repo);
  return { base, repo };
}

afterEach(() => {
  process.chdir(originalCwd);
  while (tempRoots.length > 0) {
    fs.rmSync(tempRoots.pop(), { recursive: true, force: true });
  }
});

describe('eval-runner shell safety (CodeQL #137, #138)', () => {
  test('no execSync( call with a template literal or string concatenation remains', () => {
    const src = fs.readFileSync(EVAL_RUNNER, 'utf-8');
    expect(src).not.toMatch(/\bexecSync\(\s*`/);
    expect(src).not.toMatch(/\bexecSync\([^,)]*\+/);
    expect(src).not.toMatch(/\bexecSync\b/);
  });

  test.skipIf(isWin)('a main dir containing $(touch HACKED) creates and destroys an eval worktree without running it', async () => {
    const { base, repo } = makeRepo('main$(touch HACKED)');
    const wt = await createEvalWorktree();
    expect(fs.existsSync(wt.path)).toBe(true);
    await destroyEvalWorktree(wt.path);
    expect(fs.existsSync(wt.path)).toBe(false);
    expect(git(repo, ['branch', '--list', wt.branch]).trim()).toBe('');
    expect(fs.existsSync(path.join(repo, 'HACKED'))).toBe(false);
    expect(fs.existsSync(path.join(base, 'HACKED'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.worktrees', 'HACKED'))).toBe(false);
  }, T);

  test.skipIf(isWin)('a newline in the repo path does not delete a registered eval worktree', async () => {
    makeRepo('repo\nsplit');
    const first = await createEvalWorktree();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await createEvalWorktree();
    expect(fs.existsSync(first.path)).toBe(true);
    expect(fs.existsSync(second.path)).toBe(true);
    await destroyEvalWorktree(second.path);
    await destroyEvalWorktree(first.path);
  }, T);
});

describe('parseWorktreeListPaths (NUL-separated porcelain)', () => {
  test('returns every worktree path, including one containing a newline', () => {
    const raw = [
      'worktree /tmp/repo\nsplit', 'HEAD 1111111111111111111111111111111111111111', 'branch refs/heads/master', '',
      'worktree /tmp/repo\nsplit/.worktrees/eval-1', 'HEAD 2222222222222222222222222222222222222222', 'branch refs/heads/eval-1', '',
      'worktree C:\\repo\\.worktrees\\eval-2', 'HEAD 3333333333333333333333333333333333333333', 'detached', '',
    ].join(NUL);
    expect(parseWorktreeListPaths(raw)).toEqual([
      '/tmp/repo\nsplit',
      '/tmp/repo\nsplit/.worktrees/eval-1',
      'C:/repo/.worktrees/eval-2',
    ]);
  });

  test('empty output yields no paths', () => {
    expect(parseWorktreeListPaths('')).toEqual([]);
  });
});
