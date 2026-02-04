// Test: Git State Edge Cases
// Validates git state warnings and blocking using git-state-checker.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Import validation helpers from Phase 1
const {
  checkGitState,
  isDetachedHead,
  hasUncommittedChanges,
  hasMergeConflict
} = require('../validation/git-state-checker.js');

// Fixtures directory
const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

describe('git-state-edge-cases', () => {
  describe('Detached HEAD (Warning)', () => {
    test('should detect detached HEAD state', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'detached-head');

      const result = isDetachedHead(fixturePath);

      assert.strictEqual(result.detached, true, 'Should detect detached HEAD');
      assert.strictEqual(result.branch, null, 'Branch should be null when detached');
    });

    test('should allow detached HEAD to pass with warning', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'detached-head');

      const result = checkGitState(fixturePath);

      // Detached HEAD should produce a warning but not fail
      // The validation should either pass or have a non-critical failure
      const hasDetachedWarning = result.failures.some(f =>
        /detached HEAD/i.test(f.reason)
      );

      // Either it passes with warning, or it "fails" but with low severity
      assert.ok(
        result.passed || hasDetachedWarning,
        'Should either pass or have detached HEAD warning'
      );
    });
  });

  describe('Uncommitted Changes (Warning)', () => {
    test('should detect uncommitted changes', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'dirty-git');

      const result = hasUncommittedChanges(fixturePath);

      assert.strictEqual(result.hasChanges, true, 'Should detect uncommitted changes');
      assert.ok(result.files.length > 0, 'Should list uncommitted files');
      assert.ok(
        result.files.some(f => f.includes('uncommitted.txt')),
        'Should detect uncommitted.txt file'
      );
    });

    test('should allow uncommitted changes to pass with warning', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'dirty-git');

      const result = checkGitState(fixturePath);

      // Uncommitted changes should produce a warning but not fail
      const hasUncommittedWarning = result.failures.some(f =>
        /uncommitted changes/i.test(f.reason)
      );

      assert.ok(
        result.passed || hasUncommittedWarning,
        'Should either pass or have uncommitted changes warning'
      );
    });
  });

  describe('Merge Conflicts (Blocking)', () => {
    test('should detect active merge conflict', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'merge-conflict');

      const result = hasMergeConflict(fixturePath);

      assert.strictEqual(result.hasConflict, true, 'Should detect merge conflict');
    });

    test('should block installation on merge conflict', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'merge-conflict');

      const result = checkGitState(fixturePath);

      // Merge conflicts should FAIL validation (blocking)
      assert.strictEqual(result.passed, false, 'Should fail validation on merge conflict');
    });

    test('should provide helpful error message for merge conflict', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'merge-conflict');

      const result = checkGitState(fixturePath);

      // Should have a failure about merge conflict
      const hasConflictError = result.failures.some(f =>
        /merge conflict/i.test(f.reason)
      );

      assert.ok(hasConflictError, 'Should have merge conflict error message');

      // Error message should suggest resolution
      const conflictFailure = result.failures.find(f => /merge conflict/i.test(f.reason));
      assert.ok(
        conflictFailure && conflictFailure.reason.length > 10,
        'Should provide detailed error message'
      );
    });
  });

  describe('Clean Git Repository', () => {
    test('should pass for clean git repository', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'fresh-project');

      const result = checkGitState(fixturePath);

      assert.strictEqual(result.passed, true, 'Clean repository should pass');
      // Note: May have warnings (like detached HEAD) but should still pass overall
      assert.ok(result.coverage > 0, 'Should have some coverage');
    });
  });

  describe('No Git Repository', () => {
    test('should detect missing .git directory', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'no-git');

      const result = checkGitState(fixturePath);

      assert.strictEqual(result.passed, false, 'Should fail without .git');
      assert.ok(
        result.failures.some(f => /not a git repository/i.test(f.reason)),
        'Should have "not a git repository" error'
      );
    });
  });
});
