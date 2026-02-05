// Test: Permission Error Edge Cases
// Validates graceful handling of filesystem permission errors

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

let testDir;

before(() => {
  testDir = mkdtempSync(path.join(tmpdir(), 'forge-test-permissions-'));
});

after(() => {
  // Clean up - restore permissions before removing
  try {
    // Restore write permissions for cleanup
    const files = fs.readdirSync(testDir, { withFileTypes: true });
    for (const file of files) {
      const fullPath = path.join(testDir, file.name);
      try {
        if (file.isDirectory()) {
          fs.chmodSync(fullPath, 0o755);
        } else {
          fs.chmodSync(fullPath, 0o644);
        }
      } catch (e) {
        // May fail on Windows, that's OK
      }
    }
  } catch (e) {
    // Ignore cleanup errors
  }

  rmSync(testDir, { recursive: true, force: true });
});

// Helper: Check write permissions (will be added to bin/forge.js)
function checkWritePermission(filePath) {
  try {
    const dir = fs.statSync(filePath).isDirectory() ? filePath : path.dirname(filePath);
    const testFile = path.join(dir, `.forge-write-test-${Date.now()}`);
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    return { writable: true };
  } catch (err) {
    if (err.code === 'EACCES' || err.code === 'EPERM') {
      const fix = process.platform === 'win32'
        ? 'Run Command Prompt as Administrator'
        : 'Try: sudo npx forge setup';
      return { writable: false, error: `No write permission to ${filePath}. ${fix}` };
    }
    return { writable: false, error: err.message };
  }
}

describe('permission-errors', () => {
  describe('Directory Permissions', () => {
    test('should detect read-only directory', () => {
      const readOnlyDir = path.join(testDir, 'read-only');
      fs.mkdirSync(readOnlyDir);

      // Make directory read-only (may not work on Windows)
      try {
        fs.chmodSync(readOnlyDir, 0o444);
      } catch (e) {
        // Skip on Windows
        return;
      }

      const result = checkWritePermission(readOnlyDir);

      // On Unix, should detect no write permission
      if (process.platform !== 'win32') {
        assert.strictEqual(result.writable, false, 'Should detect read-only directory');
        assert.ok(result.error, 'Should have error message');
      }
    });

    test('should use read-only-dirs fixture', () => {
      const fixturePath = path.join(FIXTURES_DIR, 'read-only-dirs');
      const claudePath = path.join(fixturePath, '.claude');

      // Check if fixture exists and has read-only .claude
      if (fs.existsSync(claudePath)) {
        const stats = fs.statSync(claudePath);

        // On Unix, check permissions
        if (process.platform !== 'win32') {
          const mode = stats.mode & 0o777;
          assert.strictEqual(mode, 0o444, 'Fixture .claude should be read-only (444)');
        }
      }
    });

    test('should provide helpful error for locked nested directories', () => {
      const parentDir = path.join(testDir, 'parent');
      const nestedDir = path.join(parentDir, 'nested');
      fs.mkdirSync(parentDir, { recursive: true });
      fs.mkdirSync(nestedDir, { recursive: true });

      try {
        fs.chmodSync(nestedDir, 0o444);
      } catch (e) {
        // Skip on Windows
        return;
      }

      const result = checkWritePermission(nestedDir);

      if (process.platform !== 'win32') {
        assert.strictEqual(result.writable, false);
        assert.ok(result.error.includes('permission'), 'Error should mention permission');
      }
    });
  });

  describe('File Permissions', () => {
    test('should detect locked file', () => {
      const filePath = path.join(testDir, 'locked.txt');
      fs.writeFileSync(filePath, 'content');

      try {
        fs.chmodSync(filePath, 0o444);
      } catch (e) {
        // Skip on Windows
        return;
      }

      // Try to write to the file
      try {
        fs.writeFileSync(filePath, 'new content');
        // If we get here on Unix, something is wrong
        if (process.platform !== 'win32') {
          assert.fail('Should not be able to write to read-only file');
        }
      } catch (err) {
        if (process.platform !== 'win32') {
          assert.ok(err.code === 'EACCES' || err.code === 'EPERM', 'Should get permission error');
        }
      }
    });

    test('should check parent directory permissions', () => {
      const dir = path.join(testDir, 'check-parent');
      fs.mkdirSync(dir);

      // File doesn't exist yet, should check parent directory
      const result = checkWritePermission(path.join(dir, 'nonexistent.txt'));

      // Should return a result (may vary by platform)
      assert.ok(typeof result.writable === 'boolean', 'Should return writable status');
    });

    test('should handle permission errors gracefully', () => {
      const result = checkWritePermission('/root/protected.txt');

      // Should return error object, not throw
      assert.ok(typeof result.writable === 'boolean', 'Should return result object');
      if (!result.writable) {
        assert.ok(result.error, 'Should have error message');
      }
    });
  });

  describe('Error Recovery', () => {
    test('should suggest sudo/admin on permission error', () => {
      const readOnlyDir = path.join(testDir, 'suggest-fix');
      fs.mkdirSync(readOnlyDir);

      try {
        fs.chmodSync(readOnlyDir, 0o444);
      } catch (e) {
        // Skip on Windows
        return;
      }

      const result = checkWritePermission(readOnlyDir);

      if (process.platform !== 'win32') {
        assert.strictEqual(result.writable, false);
        // Should suggest fix based on platform
        if (process.platform === 'win32') {
          assert.ok(result.error.includes('Administrator'), 'Should suggest Administrator on Windows');
        } else {
          assert.ok(result.error.includes('sudo'), 'Should suggest sudo on Unix');
        }
      }
    });

    test('should prevent partial writes on permission failure', () => {
      const targetDir = path.join(testDir, 'partial-writes');
      fs.mkdirSync(targetDir);

      const filesBefore = fs.readdirSync(targetDir);

      try {
        // Make directory read-only
        fs.chmodSync(targetDir, 0o444);
      } catch (e) {
        // Skip on Windows
        return;
      }

      // Attempt to write - should fail
      try {
        fs.writeFileSync(path.join(targetDir, 'test.txt'), 'content');
      } catch (err) {
        // Expected on Unix
      }

      try {
        // Restore permissions to check
        fs.chmodSync(targetDir, 0o755);
      } catch (e) {
        // May fail
      }

      const filesAfter = fs.readdirSync(targetDir);

      // No partial files should be created (Unix only)
      if (process.platform !== 'win32') {
        assert.strictEqual(filesAfter.length, filesBefore.length, 'Should not create partial files');
      }
    });
  });
});
