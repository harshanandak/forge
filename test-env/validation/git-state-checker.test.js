// Test: Git State Checker Validation Helper
// Tests for git repository state validation

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
// SECURITY: Using execSync with HARDCODED git commands only (no user input)
// Follows pattern from bin/forge.js:2381
const { execSync } = require('node:child_process');

// Module under test
const {
  checkGitState,
  isDetachedHead,
  hasUncommittedChanges,
  hasMergeConflict
} = require('./git-state-checker.js');

let testDir;

before(() => {
  // Create temp directory for tests
  testDir = mkdtempSync(path.join(tmpdir(), 'forge-test-git-state-'));
});

after(() => {
  // Cleanup
  rmSync(testDir, { recursive: true, force: true });
});

// Helper: Initialize a git repository in a directory
// SECURITY: All git commands are hardcoded strings (no user input)
function setupGitRepo(directory) {
  try {
    execSync('git init', { cwd: directory, stdio: 'pipe' });
    execSync('git config user.email "test@example.com"', { cwd: directory, stdio: 'pipe' });
    execSync('git config user.name "Test User"', { cwd: directory, stdio: 'pipe' });

    // Create initial commit
    const testFile = path.join(directory, 'README.md');
    fs.writeFileSync(testFile, '# Test Repository');
    execSync('git add README.md', { cwd: directory, stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { cwd: directory, stdio: 'pipe' });
  } catch (error) {
    throw new Error(`Failed to setup git repo: ${error.message}`);
  }
}

// Helper: Create a merge conflict scenario
// SECURITY: All git commands are hardcoded strings (no user input)
function createMergeConflict(directory) {
  try {
    // Create a branch with conflicting changes
    execSync('git checkout -b feature-branch', { cwd: directory, stdio: 'pipe' });
    const testFile = path.join(directory, 'README.md');
    fs.writeFileSync(testFile, '# Feature Branch');
    execSync('git add README.md', { cwd: directory, stdio: 'pipe' });
    execSync('git commit -m "Feature change"', { cwd: directory, stdio: 'pipe' });

    // Switch back to main/master and make conflicting change
    execSync('git checkout -', { cwd: directory, stdio: 'pipe' });
    fs.writeFileSync(testFile, '# Main Branch');
    execSync('git add README.md', { cwd: directory, stdio: 'pipe' });
    execSync('git commit -m "Main change"', { cwd: directory, stdio: 'pipe' });

    // Try to merge - this will create a conflict
    try {
      execSync('git merge feature-branch', { cwd: directory, stdio: 'pipe' });
    } catch (_error) {
      // Expected - merge conflict
    }
  } catch (error) {
    throw new Error(`Failed to create merge conflict: ${error.message}`);
  }
}

describe('git-state-checker', () => {
  describe('checkGitState()', () => {
    test('should pass for clean git repository', () => {
      const repoDir = path.join(testDir, 'clean-repo');
      fs.mkdirSync(repoDir, { recursive: true });
      setupGitRepo(repoDir);

      const result = checkGitState(repoDir);

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.failures.length, 0);
      assert.strictEqual(typeof result.coverage, 'number');
    });

    test('should detect missing .git directory', () => {
      const nonGitDir = path.join(testDir, 'non-git-dir');
      fs.mkdirSync(nonGitDir, { recursive: true });

      const result = checkGitState(nonGitDir);

      assert.strictEqual(result.passed, false);
      assert.ok(result.failures.length > 0);
      assert.match(result.failures[0].reason, /not a git repository/i);
    });

    test('should detect detached HEAD state', () => {
      const detachedDir = path.join(testDir, 'detached-head');
      fs.mkdirSync(detachedDir, { recursive: true });
      setupGitRepo(detachedDir);

      // Create detached HEAD
      execSync('git checkout --detach', { cwd: detachedDir, stdio: 'pipe' });

      const result = checkGitState(detachedDir);

      // Detached HEAD is a warning, not a failure (passed = true, but has findings)
      assert.ok(result.failures.some(f => /detached HEAD/i.test(f.reason)));
    });

    test('should detect uncommitted changes', () => {
      const dirtyDir = path.join(testDir, 'dirty-repo');
      fs.mkdirSync(dirtyDir, { recursive: true });
      setupGitRepo(dirtyDir);

      // Create uncommitted change
      const newFile = path.join(dirtyDir, 'uncommitted.txt');
      fs.writeFileSync(newFile, 'uncommitted content');

      const result = checkGitState(dirtyDir);

      assert.ok(result.failures.some(f => /uncommitted changes/i.test(f.reason)));
    });

    test('should detect merge conflicts', () => {
      const conflictDir = path.join(testDir, 'conflict-repo');
      fs.mkdirSync(conflictDir, { recursive: true });
      setupGitRepo(conflictDir);
      createMergeConflict(conflictDir);

      const result = checkGitState(conflictDir);

      assert.strictEqual(result.passed, false);
      assert.ok(result.failures.some(f => /merge conflict/i.test(f.reason)));
    });

    test('should return unified interface format', () => {
      const formatDir = path.join(testDir, 'format-check');
      fs.mkdirSync(formatDir, { recursive: true });
      setupGitRepo(formatDir);

      const result = checkGitState(formatDir);

      // Check interface structure
      assert.ok('passed' in result);
      assert.ok('failures' in result);
      assert.ok('coverage' in result);

      assert.strictEqual(typeof result.passed, 'boolean');
      assert.ok(Array.isArray(result.failures));
      assert.strictEqual(typeof result.coverage, 'number');
      assert.ok(result.coverage >= 0 && result.coverage <= 1);
    });
  });

  describe('isDetachedHead()', () => {
    test('should return false for normal branch', () => {
      const normalDir = path.join(testDir, 'normal-branch');
      fs.mkdirSync(normalDir, { recursive: true });
      setupGitRepo(normalDir);

      const result = isDetachedHead(normalDir);

      assert.strictEqual(result.detached, false);
    });

    test('should return true for detached HEAD', () => {
      const detachedDir = path.join(testDir, 'detached-check');
      fs.mkdirSync(detachedDir, { recursive: true });
      setupGitRepo(detachedDir);
      execSync('git checkout --detach', { cwd: detachedDir, stdio: 'pipe' });

      const result = isDetachedHead(detachedDir);

      assert.strictEqual(result.detached, true);
      assert.strictEqual(result.branch, null);
    });
  });

  describe('hasUncommittedChanges()', () => {
    test('should return false for clean working tree', () => {
      const cleanDir = path.join(testDir, 'clean-tree');
      fs.mkdirSync(cleanDir, { recursive: true });
      setupGitRepo(cleanDir);

      const result = hasUncommittedChanges(cleanDir);

      assert.strictEqual(result.hasChanges, false);
      assert.strictEqual(result.files.length, 0);
    });

    test('should return true with uncommitted changes', () => {
      const dirtyDir = path.join(testDir, 'dirty-tree');
      fs.mkdirSync(dirtyDir, { recursive: true });
      setupGitRepo(dirtyDir);

      // Create uncommitted file
      const newFile = path.join(dirtyDir, 'new-file.txt');
      fs.writeFileSync(newFile, 'content');

      const result = hasUncommittedChanges(dirtyDir);

      assert.strictEqual(result.hasChanges, true);
      assert.ok(result.files.length > 0);
    });
  });

  describe('hasMergeConflict()', () => {
    test('should return false for normal state', () => {
      const normalDir = path.join(testDir, 'no-conflict');
      fs.mkdirSync(normalDir, { recursive: true });
      setupGitRepo(normalDir);

      const result = hasMergeConflict(normalDir);

      assert.strictEqual(result.hasConflict, false);
      assert.strictEqual(result.conflictedFiles.length, 0);
    });

    test('should return true for active merge conflict', () => {
      const conflictDir = path.join(testDir, 'has-conflict');
      fs.mkdirSync(conflictDir, { recursive: true });
      setupGitRepo(conflictDir);
      createMergeConflict(conflictDir);

      const result = hasMergeConflict(conflictDir);

      assert.strictEqual(result.hasConflict, true);
    });
  });
});
