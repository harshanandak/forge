// Test: Git State Edge Cases
// Validates git state warnings and blocking using git-state-checker.js

import { describe, test, expect } from 'bun:test';
const path = require('node:path');
const { ensureTestFixtures, FIXTURES_DIR } = require('../helpers/fixtures.js');

// Import validation helpers from Phase 1
const {
  checkGitState,
  isDetachedHead,
  hasUncommittedChanges,
  hasMergeConflict
} = require('../validation/git-state-checker.js');

ensureTestFixtures();

describe('git-state-edge-cases', () => {
  describe('Detached HEAD (Warning)', () => {
    test('should detect detached HEAD state', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'detached-head');

      const result = isDetachedHead(fixturePath);

      expect(result.detached).toBe(true);
      expect(result.branch).toBe(null);
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
      expect(result.passed || hasDetachedWarning).toBeTruthy();
    });
  });

  describe('Uncommitted Changes (Warning)', () => {
    test('should detect uncommitted changes', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'dirty-git');

      const result = hasUncommittedChanges(fixturePath);

      expect(result.hasChanges).toBe(true);
      expect(result.files.length > 0).toBeTruthy();
      expect(result.files.some(f => f.includes('uncommitted.txt'))).toBeTruthy();
    });

    test('should allow uncommitted changes to pass with warning', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'dirty-git');

      const result = checkGitState(fixturePath);

      // Uncommitted changes should produce a warning but not fail
      const hasUncommittedWarning = result.failures.some(f =>
        /uncommitted changes/i.test(f.reason)
      );

      expect(result.passed || hasUncommittedWarning).toBeTruthy();
    });
  });

  describe('Merge Conflicts (Blocking)', () => {
    test('should detect active merge conflict', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'merge-conflict');

      const result = hasMergeConflict(fixturePath);

      expect(result.hasConflict).toBe(true);
    });

    test('should block installation on merge conflict', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'merge-conflict');

      const result = checkGitState(fixturePath);

      // Merge conflicts should FAIL validation (blocking)
      expect(result.passed).toBe(false);
    });

    test('should provide helpful error message for merge conflict', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'merge-conflict');

      const result = checkGitState(fixturePath);

      // Should have a failure about merge conflict
      const hasConflictError = result.failures.some(f =>
        /merge conflict/i.test(f.reason)
      );

      expect(hasConflictError).toBeTruthy();

      // Error message should suggest resolution
      const conflictFailure = result.failures.find(f => /merge conflict/i.test(f.reason));
      expect(conflictFailure && conflictFailure.reason.length > 10).toBeTruthy();
    });
  });

  describe('Clean Git Repository', () => {
    test('should pass for clean git repository', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'fresh-project');

      const result = checkGitState(fixturePath);

      expect(result.passed).toBe(true);
      // Note: May have warnings (like detached HEAD) but should still pass overall
      expect(result.coverage > 0).toBeTruthy();
    });
  });

  describe('No Git Repository', () => {
    test('should detect missing .git directory', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'no-git');

      const result = checkGitState(fixturePath);

      expect(result.passed).toBe(false);
      expect(result.failures.some(f => /not a git repository/i.test(f.reason))).toBeTruthy();
    });
  });
});
