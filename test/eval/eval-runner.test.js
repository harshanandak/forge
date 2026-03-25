const { describe, test, expect, afterAll } = require('bun:test');
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

// Track worktrees created during tests for cleanup
const createdWorktrees = [];

afterAll(() => {
  // Cleanup any worktrees that tests didn't destroy
  for (const wt of createdWorktrees) {
    // Extract branch name from worktree path for cleanup
    const branchName = path.basename(wt);
    try {
      // execSync is safe here — paths are generated internally, not from user input
      execSync(`git worktree remove --force "${wt}"`, {
        cwd: WORKTREE_ROOT,
        stdio: 'pipe',
      });
    } catch (_err) {
      // already removed — ignore
    }
    // Delete the eval branch (worktree removal doesn't clean up branches)
    if (branchName.startsWith('eval-')) {
      try {
        execSync(`git branch -D "${branchName}"`, {
          cwd: WORKTREE_ROOT,
          stdio: 'pipe',
        });
      } catch (_err) {
        // already deleted — ignore
      }
    }
  }
  // Prune stale worktree references
  try {
    execSync('git worktree prune', { cwd: WORKTREE_ROOT, stdio: 'pipe' });
  } catch (_err) {
    // ignore
  }
});

describe('eval-runner', () => {
  // ── createEvalWorktree ──────────────────────────────────────────────

  describe('createEvalWorktree', () => {
    test('creates a worktree and returns { path, branch }', async () => {
      const result = await createEvalWorktree();
      createdWorktrees.push(result.path);

      expect(result).toBeDefined();
      expect(typeof result.path).toBe('string');
      expect(typeof result.branch).toBe('string');

      // Path should exist on disk
      expect(fs.existsSync(result.path)).toBe(true);

      // Branch name should include eval- prefix
      expect(result.branch).toMatch(/^eval-/);
    });

    test('worktree name includes timestamp pattern', async () => {
      const result = await createEvalWorktree();
      createdWorktrees.push(result.path);

      const dirName = path.basename(result.path);
      // Should match eval-<timestamp>-<pid> pattern
      expect(dirName).toMatch(/^eval-\d+-\d+$/);
    });

    test('worktree is a valid git worktree', async () => {
      const result = await createEvalWorktree();
      createdWorktrees.push(result.path);

      // Should be recognized as a git repo
      const gitDir = execSync('git rev-parse --git-dir', {
        cwd: result.path,
        encoding: 'utf-8',
      }).trim();
      expect(gitDir).toBeTruthy();
    });
  });

  // ── destroyEvalWorktree ─────────────────────────────────────────────

  describe('destroyEvalWorktree', () => {
    test('removes worktree and branch', async () => {
      const wt = await createEvalWorktree();
      const wtPath = wt.path;
      const wtBranch = wt.branch;

      // Worktree exists
      expect(fs.existsSync(wtPath)).toBe(true);

      await destroyEvalWorktree(wtPath);

      // Directory should be gone
      expect(fs.existsSync(wtPath)).toBe(false);

      // Branch should be deleted
      const branches = execSync('git branch --list', {
        cwd: WORKTREE_ROOT,
        encoding: 'utf-8',
      });
      expect(branches).not.toContain(wtBranch);
    });

    test('succeeds even if worktree is in dirty state', async () => {
      const wt = await createEvalWorktree();
      createdWorktrees.push(wt.path);

      // Make the worktree dirty by creating an untracked file
      fs.writeFileSync(path.join(wt.path, 'dirty-file.txt'), 'dirty');

      // Should not throw
      await destroyEvalWorktree(wt.path);
      expect(fs.existsSync(wt.path)).toBe(false);

      // Remove from cleanup list since we already destroyed it
      const idx = createdWorktrees.indexOf(wt.path);
      if (idx !== -1) createdWorktrees.splice(idx, 1);
    });
  });

  // ── resetWorktree ───────────────────────────────────────────────────

  describe('resetWorktree', () => {
    test('removes untracked files after reset', async () => {
      const wt = await createEvalWorktree();
      createdWorktrees.push(wt.path);

      // Create an untracked file
      const untrackedFile = path.join(wt.path, 'untracked-test-file.txt');
      fs.writeFileSync(untrackedFile, 'should be removed');
      expect(fs.existsSync(untrackedFile)).toBe(true);

      await resetWorktree(wt.path);

      // Untracked file should be gone
      expect(fs.existsSync(untrackedFile)).toBe(false);
    });

    test('restores modified tracked files after reset', async () => {
      const wt = await createEvalWorktree();
      createdWorktrees.push(wt.path);

      // Find a tracked file to modify
      const pkgJsonPath = path.join(wt.path, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        const original = fs.readFileSync(pkgJsonPath, 'utf-8');
        fs.writeFileSync(pkgJsonPath, '{"modified": true}');

        await resetWorktree(wt.path);

        const restored = fs.readFileSync(pkgJsonPath, 'utf-8');
        expect(restored).toBe(original);
      }
    });
  });

  // ── executeCommand — environment setup ──────────────────────────────

  describe('executeCommand', () => {
    test('sets FORGE_EVAL=1 in subprocess environment', async () => {
      const wt = await createEvalWorktree();
      createdWorktrees.push(wt.path);

      const result = await executeCommand(
        '/test',
        'dummy',
        wt.path,
        10000,
        // Override: use node to print env instead of claude
        ['node', '-e', 'console.log(JSON.stringify({ FORGE_EVAL: process.env.FORGE_EVAL }))']
      );

      expect(result.exitCode).toBe(0);
      const env = JSON.parse(result.stdout.trim());
      expect(env.FORGE_EVAL).toBe('1');
    });

    test('strips CLAUDECODE env var from subprocess', async () => {
      // Set CLAUDECODE in current process temporarily
      const original = process.env.CLAUDECODE;
      process.env.CLAUDECODE = 'should-be-stripped';

      const wt = await createEvalWorktree();
      createdWorktrees.push(wt.path);

      try {
        const result = await executeCommand(
          '/test',
          'dummy',
          wt.path,
          10000,
          ['node', '-e', 'console.log(JSON.stringify({ CLAUDECODE: process.env.CLAUDECODE || "undefined" }))']
        );

        expect(result.exitCode).toBe(0);
        const env = JSON.parse(result.stdout.trim());
        expect(env.CLAUDECODE).toBe('undefined');
      } finally {
        // Restore
        if (original !== undefined) {
          process.env.CLAUDECODE = original;
        } else {
          delete process.env.CLAUDECODE;
        }
      }
    });

    test('returns stdout, stderr, exitCode, timedOut for successful command', async () => {
      const wt = await createEvalWorktree();
      createdWorktrees.push(wt.path);

      const result = await executeCommand(
        '/test',
        'dummy',
        wt.path,
        10000,
        ['node', '-e', 'process.stdout.write("hello"); process.stderr.write("world")']
      );

      expect(result.stdout).toBe('hello');
      expect(result.stderr).toBe('world');
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    });

    test('returns non-zero exitCode for failing command', async () => {
      const wt = await createEvalWorktree();
      createdWorktrees.push(wt.path);

      const result = await executeCommand(
        '/test',
        'dummy',
        wt.path,
        10000,
        ['node', '-e', 'process.exit(42)']
      );

      expect(result.exitCode).toBe(42);
      expect(result.timedOut).toBe(false);
    });

    test('kills process and returns timedOut=true when timeout exceeded', async () => {
      const wt = await createEvalWorktree();
      createdWorktrees.push(wt.path);

      const start = Date.now();
      const result = await executeCommand(
        '/test',
        'dummy',
        wt.path,
        1000, // 1 second timeout
        ['node', '-e', 'setTimeout(() => {}, 30000)'] // hangs for 30s
      );
      const elapsed = Date.now() - start;

      expect(result.timedOut).toBe(true);
      // Should have been killed well before 30 seconds
      expect(elapsed).toBeLessThan(10000);
    });

    test('uses worktree path as cwd for subprocess', async () => {
      const wt = await createEvalWorktree();
      createdWorktrees.push(wt.path);

      const result = await executeCommand(
        '/test',
        'dummy',
        wt.path,
        10000,
        ['node', '-e', 'console.log(process.cwd())']
      );

      expect(result.exitCode).toBe(0);
      // Normalize paths for comparison (Windows path variations)
      const cwd = result.stdout.trim().replace(/\\/g, '/');
      const expected = wt.path.replace(/\\/g, '/');
      expect(cwd).toBe(expected);
    });
  });
});
