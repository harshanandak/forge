const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { describe, test, expect, beforeEach, afterEach } = require('bun:test');

// Module under test
const {
  writeFreshnessToken,
  readFreshnessToken,
  isStale
} = require('../lib/freshness-token');

/**
 * Returns a sanitized env object with git hook variables removed.
 * When tests run inside pre-push hooks, git sets GIT_DIR etc. which
 * causes child `git` processes to operate on the real worktree instead
 * of the temp directory — creating rogue commits that delete everything.
 */
function cleanGitEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.GIT_INDEX_FILE;
  delete env.GIT_OBJECT_DIRECTORY;
  delete env.GIT_ALTERNATE_OBJECT_DIRECTORIES;
  delete env.GIT_QUARANTINE_PATH;
  return env;
}

/**
 * Creates a temporary git repo with a commit on main and a feature branch.
 * Returns { dir, cleanup }.
 */
function createTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-freshness-'));
  const opts = { cwd: dir, env: cleanGitEnv() };

  // Initialize repo with 'main' as default branch
  execFileSync('git', ['init', '--initial-branch', 'main'], opts);
  execFileSync('git', ['config', 'user.email', 'test@test.com'], opts);
  execFileSync('git', ['config', 'user.name', 'Test'], opts);

  // Create initial commit on main
  fs.writeFileSync(path.join(dir, 'README.md'), 'init');
  execFileSync('git', ['add', '.'], opts);
  execFileSync('git', ['commit', '-m', 'initial commit'], opts);

  // Create and switch to feature branch
  execFileSync('git', ['checkout', '-b', 'feat/test-feature'], opts);

  // Add a commit on the feature branch so HEAD differs from main
  fs.writeFileSync(path.join(dir, 'feature.txt'), 'feature work');
  execFileSync('git', ['add', '.'], opts);
  execFileSync('git', ['commit', '-m', 'feature commit'], opts);

  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { dir, cleanup };
}

describe('freshness-token', () => {
  let repo;

  beforeEach(() => {
    repo = createTempGitRepo();
  });

  afterEach(() => {
    repo.cleanup();
  });

  describe('writeFreshnessToken / readFreshnessToken roundtrip', () => {
    test('write then read returns correct token data', () => {
      const written = writeFreshnessToken(repo.dir);

      expect(written).toBeDefined();
      expect(typeof written.timestamp).toBe('number');
      expect(written.branch).toBe('feat/test-feature');
      expect(typeof written.baseCommit).toBe('string');
      expect(written.baseCommit.length).toBeGreaterThan(0);

      const read = readFreshnessToken(repo.dir);

      expect(read).not.toBeNull();
      expect(read.timestamp).toBe(written.timestamp);
      expect(read.branch).toBe(written.branch);
      expect(read.baseCommit).toBe(written.baseCommit);
    });

    test('token file is written to .forge-freshness in projectRoot', () => {
      writeFreshnessToken(repo.dir);

      const tokenPath = path.join(repo.dir, '.forge-freshness');
      expect(fs.existsSync(tokenPath)).toBe(true);

      // Should be valid JSON
      const content = fs.readFileSync(tokenPath, 'utf8');
      const parsed = JSON.parse(content);
      expect(parsed.branch).toBe('feat/test-feature');
    });
  });

  describe('isStale', () => {
    test('returns false when base commit is unchanged', () => {
      const token = writeFreshnessToken(repo.dir);
      const stale = isStale(token, repo.dir);

      expect(stale).toBe(false);
    });

    test('returns true when base commit differs (rebased onto new main)', () => {
      const token = writeFreshnessToken(repo.dir);
      const opts = { cwd: repo.dir, env: cleanGitEnv() };

      // Add a new commit to main
      execFileSync('git', ['checkout', 'main'], opts);
      fs.writeFileSync(path.join(repo.dir, 'new-on-main.txt'), 'new stuff');
      execFileSync('git', ['add', '.'], opts);
      execFileSync('git', ['commit', '-m', 'main moved forward'], opts);

      // Rebase feature branch onto new main tip — this changes merge-base
      execFileSync('git', ['checkout', 'feat/test-feature'], opts);
      execFileSync('git', ['rebase', 'main'], opts);

      const stale = isStale(token, repo.dir);
      expect(stale).toBe(true);
    });

    test('returns true when token is null', () => {
      const stale = isStale(null, repo.dir);
      expect(stale).toBe(true);
    });
  });

  describe('readFreshnessToken edge cases', () => {
    test('returns null for missing token file', () => {
      const result = readFreshnessToken(repo.dir);
      expect(result).toBeNull();
    });

    test('returns null for corrupted (non-JSON) token file', () => {
      const tokenPath = path.join(repo.dir, '.forge-freshness');
      fs.writeFileSync(tokenPath, 'this is not valid json!!!');

      const result = readFreshnessToken(repo.dir);
      expect(result).toBeNull();
    });

    test('returns null for empty token file', () => {
      const tokenPath = path.join(repo.dir, '.forge-freshness');
      fs.writeFileSync(tokenPath, '');

      const result = readFreshnessToken(repo.dir);
      expect(result).toBeNull();
    });
  });

  describe('writeFreshnessToken error handling', () => {
    test('throws descriptive error when git merge-base fails', () => {
      // Create a repo with no common ancestor to main (orphan branch)
      const orphanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-freshness-orphan-'));
      const opts = { cwd: orphanDir, env: cleanGitEnv() };
      execFileSync('git', ['init', '--initial-branch', 'main'], opts);
      execFileSync('git', ['config', 'user.email', 'test@test.com'], opts);
      execFileSync('git', ['config', 'user.name', 'Test'], opts);

      // Create initial commit on main
      fs.writeFileSync(path.join(orphanDir, 'README.md'), 'init');
      execFileSync('git', ['add', '.'], opts);
      execFileSync('git', ['commit', '-m', 'initial'], opts);

      // Create orphan branch (no common ancestor with main)
      execFileSync('git', ['checkout', '--orphan', 'orphan-branch'], opts);
      fs.writeFileSync(path.join(orphanDir, 'orphan.txt'), 'orphan');
      execFileSync('git', ['add', '.'], opts);
      execFileSync('git', ['commit', '-m', 'orphan commit'], opts);

      try {
        expect(() => writeFreshnessToken(orphanDir)).toThrow();
      } finally {
        fs.rmSync(orphanDir, { recursive: true, force: true });
      }
    });
  });

  describe('isStale error handling', () => {
    test('returns true when git merge-base fails during staleness check', () => {
      // Create a token with a fake baseCommit
      const token = {
        timestamp: Date.now(),
        branch: 'feat/test-feature',
        baseCommit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
      };

      // isStale should return true when merge-base fails (can't verify)
      const stale = isStale(token, repo.dir);
      expect(stale).toBe(true);
    });
  });

  describe('.gitignore entry', () => {
    test('.gitignore in the real project contains .forge-freshness', () => {
      // Check the actual project .gitignore, not the temp repo
      const projectRoot = path.resolve(__dirname, '..');
      const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8');

      expect(gitignore).toContain('.forge-freshness');
    });
  });
});
