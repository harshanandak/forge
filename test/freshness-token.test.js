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

// Counter for unique branch names across test runs (avoids collision in CI)
let branchCounter = 0;

function git(repoDir, args) {
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

/**
 * Creates a temporary git repo with a commit on main and a feature branch.
 * Uses a unique branch name per invocation to prevent collisions when
 * git state from a previous test run leaks (e.g., during CI push).
 * Returns { dir, cleanup, branchName }.
 */
function createTempGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-freshness-'));
  const branchName = `feat/test-feature-${Date.now()}-${++branchCounter}`;

  // Initialize repo with 'main' as default branch
  git(dir, ['init', '--initial-branch', 'main']);
  git(dir, ['config', 'user.email', 'test@test.com']);
  git(dir, ['config', 'user.name', 'Test']);

  // Create initial commit on main
  fs.writeFileSync(path.join(dir, 'README.md'), 'init');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial commit']);

  // Create and switch to feature branch (unique name per test)
  git(dir, ['checkout', '-b', branchName]);

  // Add a commit on the feature branch so HEAD differs from main
  fs.writeFileSync(path.join(dir, 'feature.txt'), 'feature work');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'feature commit']);

  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
  };

  return { dir, cleanup, branchName };
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
      expect(written.branch).toBe(repo.branchName);
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
      expect(parsed.branch).toBe(repo.branchName);
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

      // Add a new commit to main
      git(repo.dir, ['checkout', 'main']);
      fs.writeFileSync(path.join(repo.dir, 'new-on-main.txt'), 'new stuff');
      git(repo.dir, ['add', '.']);
      git(repo.dir, ['commit', '-m', 'main moved forward']);

      // Rebase feature branch onto new main tip — this changes merge-base
      git(repo.dir, ['checkout', repo.branchName]);
      git(repo.dir, ['rebase', 'main']);

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
      git(orphanDir, ['init', '--initial-branch', 'main']);
      git(orphanDir, ['config', 'user.email', 'test@test.com']);
      git(orphanDir, ['config', 'user.name', 'Test']);

      // Create initial commit on main
      fs.writeFileSync(path.join(orphanDir, 'README.md'), 'init');
      git(orphanDir, ['add', '.']);
      git(orphanDir, ['commit', '-m', 'initial']);

      // Create orphan branch (no common ancestor with main)
      git(orphanDir, ['checkout', '--orphan', 'orphan-branch']);
      fs.writeFileSync(path.join(orphanDir, 'orphan.txt'), 'orphan');
      git(orphanDir, ['add', '.']);
      git(orphanDir, ['commit', '-m', 'orphan commit']);

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
        branch: repo.branchName,
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
