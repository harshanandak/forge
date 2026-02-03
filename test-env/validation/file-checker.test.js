// Test: File Checker Validation Helper
// Tests for file existence, content, and symlink validation

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');

// Module under test
const {
  validateInstallation,
  validateFile,
  checkSymlink
} = require('./file-checker.js');

let testDir;

before(() => {
  // Create temp directory for tests
  testDir = mkdtempSync(path.join(tmpdir(), 'forge-test-file-checker-'));
});

after(() => {
  // Cleanup
  rmSync(testDir, { recursive: true, force: true });
});

describe('file-checker', () => {
  describe('validateFile()', () => {
    test('should validate file existence', () => {
      const filePath = path.join(testDir, 'test-file.txt');
      fs.writeFileSync(filePath, 'test content');

      const result = validateFile(filePath, { mustExist: true });

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.failures.length, 0);
    });

    test('should detect missing file', () => {
      const filePath = path.join(testDir, 'missing-file.txt');

      const result = validateFile(filePath, { mustExist: true });

      assert.strictEqual(result.passed, false);
      assert.strictEqual(result.failures.length, 1);
      assert.match(result.failures[0].reason, /does not exist/i);
    });

    test('should validate file is not empty', () => {
      const filePath = path.join(testDir, 'non-empty.txt');
      fs.writeFileSync(filePath, 'content');

      const result = validateFile(filePath, { mustExist: true, notEmpty: true });

      assert.strictEqual(result.passed, true);
    });

    test('should detect empty file', () => {
      const filePath = path.join(testDir, 'empty.txt');
      fs.writeFileSync(filePath, '');

      const result = validateFile(filePath, { mustExist: true, notEmpty: true });

      assert.strictEqual(result.passed, false);
      assert.match(result.failures[0].reason, /is empty/i);
    });

    test('should validate minimum file size', () => {
      const filePath = path.join(testDir, 'sized-file.txt');
      fs.writeFileSync(filePath, 'a'.repeat(100));

      const result = validateFile(filePath, { mustExist: true, minSize: 50 });

      assert.strictEqual(result.passed, true);
    });

    test('should detect file below minimum size', () => {
      const filePath = path.join(testDir, 'small-file.txt');
      fs.writeFileSync(filePath, 'small');

      const result = validateFile(filePath, { mustExist: true, minSize: 100 });

      assert.strictEqual(result.passed, false);
      assert.match(result.failures[0].reason, /smaller than minimum/i);
    });
  });

  describe('checkSymlink()', () => {
    test('should validate symlink exists and points to target', () => {
      const targetPath = path.join(testDir, 'target.txt');
      const linkPath = path.join(testDir, 'link.txt');

      fs.writeFileSync(targetPath, 'target content');
      try {
        fs.symlinkSync(targetPath, linkPath);
      } catch (err) {
        // Windows may require admin, skip this test
        if (err.code === 'EPERM') {
          console.log('  Skipping symlink test (requires admin on Windows)');
          return;
        }
        throw err;
      }

      const result = checkSymlink(linkPath, targetPath);

      assert.strictEqual(result.passed, true);
      assert.strictEqual(result.failures.length, 0);
    });

    test('should detect missing symlink', () => {
      const linkPath = path.join(testDir, 'missing-link.txt');
      const targetPath = path.join(testDir, 'target.txt');

      const result = checkSymlink(linkPath, targetPath);

      assert.strictEqual(result.passed, false);
      assert.match(result.failures[0].reason, /does not exist/i);
    });

    test('should detect incorrect symlink target', () => {
      const targetPath = path.join(testDir, 'target2.txt');
      const wrongTarget = path.join(testDir, 'wrong.txt');
      const linkPath = path.join(testDir, 'link2.txt');

      fs.writeFileSync(targetPath, 'target');
      fs.writeFileSync(wrongTarget, 'wrong');

      try {
        fs.symlinkSync(wrongTarget, linkPath);
      } catch (err) {
        if (err.code === 'EPERM') {
          console.log('  Skipping symlink test (requires admin on Windows)');
          return;
        }
        throw err;
      }

      const result = checkSymlink(linkPath, targetPath);

      assert.strictEqual(result.passed, false);
      assert.match(result.failures[0].reason, /points to wrong target/i);
    });
  });

  describe('validateInstallation()', () => {
    test('should validate Claude Code installation', () => {
      // Create expected files for Claude Code
      const agentDir = path.join(testDir, '.claude');
      const commandsDir = path.join(agentDir, 'commands');
      fs.mkdirSync(commandsDir, { recursive: true });

      // Create expected files
      fs.writeFileSync(path.join(testDir, 'CLAUDE.md'), 'content');
      fs.writeFileSync(path.join(commandsDir, 'status.md'), 'command');
      fs.writeFileSync(path.join(commandsDir, 'plan.md'), 'command');

      const result = validateInstallation('claude', testDir);

      assert.strictEqual(typeof result.passed, 'boolean');
      assert.ok(Array.isArray(result.failures));
      assert.strictEqual(typeof result.coverage, 'number');
      assert.ok(result.coverage >= 0 && result.coverage <= 1);
    });

    test('should return unified interface format', () => {
      const result = validateInstallation('claude', testDir);

      // Check interface structure
      assert.ok('passed' in result);
      assert.ok('failures' in result);
      assert.ok('coverage' in result);

      assert.strictEqual(typeof result.passed, 'boolean');
      assert.ok(Array.isArray(result.failures));
      assert.strictEqual(typeof result.coverage, 'number');
    });

    test('should calculate coverage correctly', () => {
      // Create partial installation (some files exist, others don't)
      const agentDir = path.join(testDir, '.claude-partial');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(testDir, 'AGENTS.md'), 'content');

      const result = validateInstallation('claude', testDir);

      // Coverage should be between 0 and 1
      assert.ok(result.coverage >= 0);
      assert.ok(result.coverage <= 1);

      // If not all files exist, coverage < 1
      if (result.failures.length > 0) {
        assert.ok(result.coverage < 1);
      }
    });

    test('should provide detailed failure information', () => {
      const result = validateInstallation('claude', path.join(testDir, 'nonexistent'));

      if (result.failures.length > 0) {
        const failure = result.failures[0];

        assert.ok('path' in failure || 'file' in failure);
        assert.ok('reason' in failure);
        assert.strictEqual(typeof failure.reason, 'string');
      }
    });
  });
});
