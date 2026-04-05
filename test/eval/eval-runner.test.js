const { describe, test, expect, beforeAll, afterAll } = require('bun:test');
const path = require('path');
const fs = require('fs');
const { execSync } = require('node:child_process');

const {
  createEvalWorktree,
  destroyEvalWorktree,
  resetWorktree,
  executeCommand,
} = require('../../scripts/lib/eval-runner');

// Root of the worktree we're running in
const WORKTREE_ROOT = path.resolve(__dirname, '..', '..');

// Single shared worktree for all tests that just need a cwd
let sharedWorktree = null;

beforeAll(async () => {
  sharedWorktree = await createEvalWorktree();
});

afterAll(async () => {
  if (sharedWorktree) {
    try {
      await destroyEvalWorktree(sharedWorktree.path);
    } catch (_err) {
      // Best-effort cleanup
      const branchName = path.basename(sharedWorktree.path);
      try {
        // execSync is safe here — paths are generated internally, not from user input
        execSync(`git worktree remove --force "${sharedWorktree.path}"`, {
          cwd: WORKTREE_ROOT, stdio: 'pipe',
        });
      } catch (_e) { /* ignore */ }
      if (branchName.startsWith('eval-')) {
        try {
          execSync(`git branch -D "${branchName}"`, {
            cwd: WORKTREE_ROOT, stdio: 'pipe',
          });
        } catch (_e) { /* ignore */ }
      }
    }
  }
  try {
    execSync('git worktree prune', { cwd: WORKTREE_ROOT, stdio: 'pipe' });
  } catch (_err) { /* ignore */ }
});

describe('eval-runner', () => {
  // ── createEvalWorktree ──────────────────────────────────────────────

  describe('createEvalWorktree', () => {
    test('creates a worktree and returns { path, branch }', () => {
      // Validated via the shared worktree created in beforeAll
      expect(sharedWorktree).toBeDefined();
      expect(typeof sharedWorktree.path).toBe('string');
      expect(typeof sharedWorktree.branch).toBe('string');
      expect(fs.existsSync(sharedWorktree.path)).toBe(true);
      expect(sharedWorktree.branch).toMatch(/^eval-/);
    });

    test('worktree name includes timestamp pattern', () => {
      const dirName = path.basename(sharedWorktree.path);
      expect(dirName).toMatch(/^eval-\d+-\d+$/);
    });

    test('worktree is a valid git worktree', () => {
      const gitDir = execSync('git rev-parse --git-dir', {
        cwd: sharedWorktree.path,
        encoding: 'utf-8',
      }).trim();
      expect(gitDir).toBeTruthy();
    });
  });

  // ── destroyEvalWorktree ─────────────────────────────────────────────

  describe('destroyEvalWorktree', () => {
    test('removes worktree and branch', async () => {
      // Create a dedicated worktree just for this destruction test
      const wt = await createEvalWorktree();
      const wtPath = wt.path;

      expect(fs.existsSync(wtPath)).toBe(true);
      await destroyEvalWorktree(wtPath);
      expect(fs.existsSync(wtPath)).toBe(false);
    });

    test('succeeds even if worktree is in dirty state', async () => {
      const wt = await createEvalWorktree();
      fs.writeFileSync(path.join(wt.path, 'dirty-file.txt'), 'dirty');

      await destroyEvalWorktree(wt.path);
      expect(fs.existsSync(wt.path)).toBe(false);
    });
  });

  // ── resetWorktree ───────────────────────────────────────────────────

  describe('resetWorktree', () => {
    test('removes untracked files after reset', async () => {
      const untrackedFile = path.join(sharedWorktree.path, 'untracked-test-file.txt');
      fs.writeFileSync(untrackedFile, 'should be removed');
      expect(fs.existsSync(untrackedFile)).toBe(true);

      await resetWorktree(sharedWorktree.path);
      expect(fs.existsSync(untrackedFile)).toBe(false);
    });

    test('restores modified tracked files after reset', async () => {
      const pkgJsonPath = path.join(sharedWorktree.path, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        const original = fs.readFileSync(pkgJsonPath, 'utf-8');
        fs.writeFileSync(pkgJsonPath, '{"modified": true}');

        await resetWorktree(sharedWorktree.path);

        const restored = fs.readFileSync(pkgJsonPath, 'utf-8');
        expect(restored).toBe(original);
      }
    });
  });

  // ── executeCommand — environment setup ──────────────────────────────

  describe('executeCommand', () => {
    test('sets FORGE_EVAL=1 in subprocess environment', async () => {
      const result = await executeCommand(
        '/test', 'dummy', sharedWorktree.path, 10000,
        ['node', '-e', 'console.log(JSON.stringify({ FORGE_EVAL: process.env.FORGE_EVAL }))']
      );

      expect(result.exitCode).toBe(0);
      const env = JSON.parse(result.stdout.trim());
      expect(env.FORGE_EVAL).toBe('1');
    });

    test('strips CLAUDECODE env var from subprocess', async () => {
      const original = process.env.CLAUDECODE;
      process.env.CLAUDECODE = 'should-be-stripped';

      try {
        const result = await executeCommand(
          '/test', 'dummy', sharedWorktree.path, 10000,
          ['node', '-e', 'console.log(JSON.stringify({ CLAUDECODE: process.env.CLAUDECODE || "undefined" }))']
        );

        expect(result.exitCode).toBe(0);
        const env = JSON.parse(result.stdout.trim());
        expect(env.CLAUDECODE).toBe('undefined');
      } finally {
        if (original !== undefined) {
          process.env.CLAUDECODE = original;
        } else {
          delete process.env.CLAUDECODE;
        }
      }
    });

    test('returns stdout, stderr, exitCode, timedOut for successful command', async () => {
      const result = await executeCommand(
        '/test', 'dummy', sharedWorktree.path, 10000,
        ['node', '-e', 'process.stdout.write("hello"); process.stderr.write("world")']
      );

      expect(result.stdout).toBe('hello');
      expect(result.stderr).toBe('world');
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    });

    test('returns non-zero exitCode for failing command', async () => {
      const result = await executeCommand(
        '/test', 'dummy', sharedWorktree.path, 10000,
        ['node', '-e', 'process.exit(42)']
      );

      expect(result.exitCode).toBe(42);
      expect(result.timedOut).toBe(false);
    });

    test('kills process and returns timedOut=true when timeout exceeded', async () => {
      const start = Date.now();
      const result = await executeCommand(
        '/test', 'dummy', sharedWorktree.path, 1000,
        ['node', '-e', 'setTimeout(() => {}, 30000)']
      );
      const elapsed = Date.now() - start;

      expect(result.timedOut).toBe(true);
      expect(elapsed).toBeLessThan(10000);
    });

    test('uses worktree path as cwd for subprocess', async () => {
      const result = await executeCommand(
        '/test', 'dummy', sharedWorktree.path, 10000,
        ['node', '-e', 'console.log(process.cwd())']
      );

      expect(result.exitCode).toBe(0);
      const cwd = result.stdout.trim().replace(/\\/g, '/');
      const expected = sharedWorktree.path.replace(/\\/g, '/');
      expect(cwd).toBe(expected);
    });
  });
});
