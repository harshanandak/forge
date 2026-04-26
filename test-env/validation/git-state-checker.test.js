// Test: Git State Checker Validation Helper
// Tests for git repository state validation

import { describe, test, beforeAll, afterAll, setDefaultTimeout, expect } from 'bun:test';
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
const sanitizedGitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);
const gitExecOptions = {
  stdio: 'pipe',
  env: {
    ...sanitizedGitEnv,
    LEFTHOOK: '0',
  },
};

setDefaultTimeout(15000);

beforeAll(() => {
  // Create temp directory for tests
  testDir = mkdtempSync(path.join(tmpdir(), 'forge-test-git-state-'));
});

afterAll(() => {
  // Cleanup
  rmSync(testDir, { recursive: true, force: true });
});

// Helper: Initialize a git repository in a directory
// SECURITY: All git commands are hardcoded strings (no user input)
function setupGitRepo(directory) {
  try {
    execSync('git init', { cwd: directory, ...gitExecOptions });
    execSync('git config user.email "test@example.com"', { cwd: directory, ...gitExecOptions });
    execSync('git config user.name "Test User"', { cwd: directory, ...gitExecOptions });
    fs.mkdirSync(path.join(directory, '.git', 'hooks-empty'), { recursive: true });
    execSync('git config core.hooksPath .git/hooks-empty', { cwd: directory, ...gitExecOptions });

    // Create initial commit
    const testFile = path.join(directory, 'README.md');
    fs.writeFileSync(testFile, '# Test Repository');
    execSync('git add README.md', { cwd: directory, ...gitExecOptions });
    execSync('git commit -m "Initial commit"', { cwd: directory, ...gitExecOptions });
  } catch (error) {
    throw new Error(`Failed to setup git repo: ${error.message}`);
  }
}

// Helper: Create a merge conflict scenario
// SECURITY: All git commands are hardcoded strings (no user input)
// SECURITY: All git commands below are hardcoded strings — no user input or
// runtime-derived values are interpolated into any command.
function createMergeConflict(directory) {
  const execOpts = { cwd: directory, timeout: 10000, ...gitExecOptions };
  try {
    // Create a named branch so we can switch back with a hardcoded name
    // SECURITY: Hardcoded branch names only
    execSync('git branch initial-branch', execOpts);
    execSync('git checkout -b feature-branch', execOpts);
    const testFile = path.join(directory, 'README.md');
    fs.writeFileSync(testFile, '# Feature Branch');
    execSync('git add README.md', execOpts);
    execSync('git commit -m "Feature change"', execOpts);

    // Switch back using hardcoded branch name (no dynamic variables)
    execSync('git checkout initial-branch', execOpts);
    fs.writeFileSync(testFile, '# Main Branch');
    execSync('git add README.md', execOpts);
    execSync('git commit -m "Main change"', execOpts);

    // Try to merge — this will create a conflict
    try {
      execSync('git merge feature-branch --no-edit', execOpts);
    } catch (_error) {
      // Expected — merge conflict
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

      expect(result.passed).toBe(true);
      expect(result.failures.length).toBe(0);
      expect(typeof result.coverage).toBe('number');
    });

    test('should detect missing .git directory', () => {
      const nonGitDir = path.join(testDir, 'non-git-dir');
      fs.mkdirSync(nonGitDir, { recursive: true });

      const result = checkGitState(nonGitDir);

      expect(result.passed).toBe(false);
      expect(result.failures.length > 0).toBeTruthy();
      expect(result.failures[0].reason).toMatch(/not a git repository/i);
    });

    test('should detect detached HEAD state', () => {
      const detachedDir = path.join(testDir, 'detached-head');
      fs.mkdirSync(detachedDir, { recursive: true });
      setupGitRepo(detachedDir);

      // Create detached HEAD
      execSync('git checkout --detach', { cwd: detachedDir, ...gitExecOptions });

      const result = checkGitState(detachedDir);

      // Detached HEAD is a warning, not a failure (passed = true, but has findings)
      expect(result.failures.some(f => /detached HEAD/i.test(f.reason))).toBeTruthy();
    });

    test('should detect uncommitted changes', () => {
      const dirtyDir = path.join(testDir, 'dirty-repo');
      fs.mkdirSync(dirtyDir, { recursive: true });
      setupGitRepo(dirtyDir);

      // Create uncommitted change
      const newFile = path.join(dirtyDir, 'uncommitted.txt');
      fs.writeFileSync(newFile, 'uncommitted content');

      const result = checkGitState(dirtyDir);

      expect(result.failures.some(f => /uncommitted changes/i.test(f.reason))).toBeTruthy();
    });

    test('should detect merge conflicts', () => {
      const conflictDir = path.join(testDir, 'conflict-repo');
      fs.mkdirSync(conflictDir, { recursive: true });
      setupGitRepo(conflictDir);
      createMergeConflict(conflictDir);

      const result = checkGitState(conflictDir);

      expect(result.passed).toBe(false);
      expect(result.failures.some(f => /merge conflict/i.test(f.reason))).toBeTruthy();
    });

    test('should return unified interface format', () => {
      const formatDir = path.join(testDir, 'format-check');
      fs.mkdirSync(formatDir, { recursive: true });
      setupGitRepo(formatDir);

      const result = checkGitState(formatDir);

      // Check interface structure
      expect('passed' in result).toBeTruthy();
      expect('failures' in result).toBeTruthy();
      expect('coverage' in result).toBeTruthy();

      expect(typeof result.passed).toBe('boolean');
      expect(Array.isArray(result.failures)).toBeTruthy();
      expect(typeof result.coverage).toBe('number');
      expect(result.coverage >= 0 && result.coverage <= 1).toBeTruthy();
    });
  });

  describe('isDetachedHead()', () => {
    test('should return false for normal branch', () => {
      const normalDir = path.join(testDir, 'normal-branch');
      fs.mkdirSync(normalDir, { recursive: true });
      setupGitRepo(normalDir);

      const result = isDetachedHead(normalDir);

      expect(result.detached).toBe(false);
    });

    test('should return true for detached HEAD', () => {
      const detachedDir = path.join(testDir, 'detached-check');
      fs.mkdirSync(detachedDir, { recursive: true });
      setupGitRepo(detachedDir);
      execSync('git checkout --detach', { cwd: detachedDir, ...gitExecOptions });

      const result = isDetachedHead(detachedDir);

      expect(result.detached).toBe(true);
      expect(result.branch).toBe(null);
    });
  });

  describe('hasUncommittedChanges()', () => {
    test('should return false for clean working tree', () => {
      const cleanDir = path.join(testDir, 'clean-tree');
      fs.mkdirSync(cleanDir, { recursive: true });
      setupGitRepo(cleanDir);

      const result = hasUncommittedChanges(cleanDir);

      expect(result.hasChanges).toBe(false);
      expect(result.files.length).toBe(0);
    });

    test('should return true with uncommitted changes', () => {
      const dirtyDir = path.join(testDir, 'dirty-tree');
      fs.mkdirSync(dirtyDir, { recursive: true });
      setupGitRepo(dirtyDir);

      // Create uncommitted file
      const newFile = path.join(dirtyDir, 'new-file.txt');
      fs.writeFileSync(newFile, 'content');

      const result = hasUncommittedChanges(dirtyDir);

      expect(result.hasChanges).toBe(true);
      expect(result.files.length > 0).toBeTruthy();
    });
  });

  describe('hasMergeConflict()', () => {
    test('should return false for normal state', () => {
      const normalDir = path.join(testDir, 'no-conflict');
      fs.mkdirSync(normalDir, { recursive: true });
      setupGitRepo(normalDir);

      const result = hasMergeConflict(normalDir);

      expect(result.hasConflict).toBe(false);
      expect(result.conflictedFiles.length).toBe(0);
    });

    test('should return true for active merge conflict', () => {
      const conflictDir = path.join(testDir, 'has-conflict');
      fs.mkdirSync(conflictDir, { recursive: true });
      setupGitRepo(conflictDir);
      createMergeConflict(conflictDir);

      const result = hasMergeConflict(conflictDir);

      expect(result.hasConflict).toBe(true);
    });
  });
});
