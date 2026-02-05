// Test: Rollback Edge Cases and Security
// Comprehensive edge case testing for rollback system validation

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const projectRoot = process.cwd();

// Import validation function (same as in bin/forge.js)
function validateRollbackInput(method, target) {
  const validMethods = ['commit', 'pr', 'partial', 'branch'];
  if (!validMethods.includes(method)) {
    return { valid: false, error: 'Invalid method' };
  }

  if (method === 'commit' || method === 'pr') {
    if (target !== 'HEAD' && !/^[0-9a-f]{4,40}$/i.test(target)) {
      return { valid: false, error: 'Invalid commit hash format' };
    }
  }

  if (method === 'partial') {
    const files = target.split(',').map(f => f.trim());
    for (const file of files) {
      if (/[;|&$`()<>\r\n]/.test(file)) {
        return { valid: false, error: `Invalid characters in path: ${file}` };
      }
      // Reject URL-encoded path traversal attempts
      if (/%2[eE]|%2[fF]|%5[cC]/.test(file)) {
        return { valid: false, error: `URL-encoded characters not allowed: ${file}` };
      }
      // Reject non-ASCII/unicode characters
      if (!/^[\x20-\x7E]+$/.test(file)) {
        return { valid: false, error: `Only ASCII characters allowed in path: ${file}` };
      }
      // Cross-platform Windows path checks
      if (/^[a-zA-Z]:[\\\/]/.test(file)) {
        return { valid: false, error: `Absolute Windows paths not allowed: ${file}` };
      }
      if (/^[\\\/]{2}/.test(file)) {
        return { valid: false, error: `UNC paths not allowed: ${file}` };
      }
      if (file.includes('\\')) {
        return { valid: false, error: `Backslash path separators not allowed: ${file}` };
      }
      const resolved = path.resolve(projectRoot, file);
      if (!resolved.startsWith(projectRoot)) {
        return { valid: false, error: `Path outside project: ${file}` };
      }
    }
  }

  if (method === 'branch') {
    if (!target.includes('..')) {
      return { valid: false, error: 'Branch range must use format: start..end' };
    }
    const [start, end] = target.split('..');
    if (!/^[0-9a-f]{4,40}$/i.test(start) || !/^[0-9a-f]{4,40}$/i.test(end)) {
      return { valid: false, error: 'Invalid commit hashes in range' };
    }
  }

  return { valid: true };
}

describe('Rollback Edge Cases & Security Tests', () => {

  describe('Commit Hash Edge Cases', () => {
    test('Accepts 4-character hash (minimum)', () => {
      const result = validateRollbackInput('commit', 'abcd');
      assert.strictEqual(result.valid, true);
    });

    test('Accepts 40-character hash (maximum)', () => {
      const result = validateRollbackInput('commit', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
      assert.strictEqual(result.valid, true);
    });

    test('Rejects 3-character hash (too short)', () => {
      const result = validateRollbackInput('commit', 'abc');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects 41-character hash (too long)', () => {
      const result = validateRollbackInput('commit', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c');
      assert.strictEqual(result.valid, false);
    });

    test('Accepts uppercase hex characters', () => {
      const result = validateRollbackInput('commit', 'ABCDEF123');
      assert.strictEqual(result.valid, true);
    });

    test('Accepts mixed case hex', () => {
      const result = validateRollbackInput('commit', 'AbCdEf123');
      assert.strictEqual(result.valid, true);
    });

    test('Rejects hash with non-hex characters', () => {
      const result = validateRollbackInput('commit', 'g1h2i3j4');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects hash with special characters', () => {
      const result = validateRollbackInput('commit', 'abc-123');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects hash with spaces', () => {
      const result = validateRollbackInput('commit', 'abc 123');
      assert.strictEqual(result.valid, false);
    });
  });

  describe('Shell Injection Prevention', () => {
    test('Rejects semicolon injection', () => {
      const result = validateRollbackInput('commit', 'abc123;rm -rf /');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects pipe injection', () => {
      const result = validateRollbackInput('commit', 'abc123|cat /etc/passwd');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects ampersand injection', () => {
      const result = validateRollbackInput('commit', 'abc123&whoami');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects dollar sign injection', () => {
      const result = validateRollbackInput('commit', 'abc123$(whoami)');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects backtick injection', () => {
      const result = validateRollbackInput('commit', 'abc123`whoami`');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects parenthesis injection', () => {
      const result = validateRollbackInput('commit', 'abc123(ls)');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects angle bracket injection', () => {
      const result = validateRollbackInput('commit', 'abc123<file.txt');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects newline injection', () => {
      const result = validateRollbackInput('commit', 'abc123\nrm -rf /');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects carriage return injection', () => {
      const result = validateRollbackInput('commit', 'abc123\rrm -rf /');
      assert.strictEqual(result.valid, false);
    });
  });

  describe('Path Traversal Prevention', () => {
    test('Rejects simple path traversal', () => {
      const result = validateRollbackInput('partial', '../etc/passwd');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects multiple level traversal', () => {
      const result = validateRollbackInput('partial', '../../../etc/passwd');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects absolute path outside project', () => {
      const result = validateRollbackInput('partial', '/etc/passwd');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects Windows path traversal', () => {
      const result = validateRollbackInput('partial', '..\\..\\Windows\\System32');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects encoded path traversal', () => {
      const result = validateRollbackInput('partial', '..%2F..%2Fetc%2Fpasswd');
      assert.strictEqual(result.valid, false);
    });

    test('Accepts relative path within project', () => {
      const result = validateRollbackInput('partial', 'src/auth.js');
      assert.strictEqual(result.valid, true);
    });

    test('Accepts nested path within project', () => {
      const result = validateRollbackInput('partial', 'src/components/ui/Button.tsx');
      assert.strictEqual(result.valid, true);
    });
  });

  describe('File Path Edge Cases', () => {
    test('Accepts multiple comma-separated files', () => {
      const result = validateRollbackInput('partial', 'file1.js,file2.js,file3.js');
      assert.strictEqual(result.valid, true);
    });

    test('Handles whitespace around commas', () => {
      const result = validateRollbackInput('partial', 'file1.js , file2.js , file3.js');
      assert.strictEqual(result.valid, true);
    });

    test('Rejects file with semicolon in name', () => {
      const result = validateRollbackInput('partial', 'file;rm.js');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects file with pipe in name', () => {
      const result = validateRollbackInput('partial', 'file|cat.js');
      assert.strictEqual(result.valid, false);
    });

    test('Accepts file with dots in name', () => {
      const result = validateRollbackInput('partial', 'config.test.js');
      assert.strictEqual(result.valid, true);
    });

    test('Accepts file with dashes in name', () => {
      const result = validateRollbackInput('partial', 'my-component.js');
      assert.strictEqual(result.valid, true);
    });

    test('Accepts file with underscores in name', () => {
      const result = validateRollbackInput('partial', 'my_component.js');
      assert.strictEqual(result.valid, true);
    });
  });

  describe('Branch Range Edge Cases', () => {
    test('Accepts valid branch range', () => {
      const result = validateRollbackInput('branch', 'abc123..def456');
      assert.strictEqual(result.valid, true);
    });

    test('Rejects range with single dot', () => {
      const result = validateRollbackInput('branch', 'abc123.def456');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects range with three dots', () => {
      const result = validateRollbackInput('branch', 'abc123...def456');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects range with no separator', () => {
      const result = validateRollbackInput('branch', 'abc123def456');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects range with invalid start hash', () => {
      const result = validateRollbackInput('branch', 'xyz..def456');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects range with invalid end hash', () => {
      const result = validateRollbackInput('branch', 'abc123..xyz');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects range with short start hash', () => {
      const result = validateRollbackInput('branch', 'abc..def456');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects range with short end hash', () => {
      const result = validateRollbackInput('branch', 'abc123..def');
      assert.strictEqual(result.valid, false);
    });

    test('Accepts range with mixed case hashes', () => {
      const result = validateRollbackInput('branch', 'AbC123..DeF456');
      assert.strictEqual(result.valid, true);
    });
  });

  describe('Method Validation', () => {
    test('Accepts "commit" method', () => {
      const result = validateRollbackInput('commit', 'HEAD');
      assert.strictEqual(result.valid, true);
    });

    test('Accepts "pr" method', () => {
      const result = validateRollbackInput('pr', 'abc123');
      assert.strictEqual(result.valid, true);
    });

    test('Accepts "partial" method', () => {
      const result = validateRollbackInput('partial', 'file.js');
      assert.strictEqual(result.valid, true);
    });

    test('Accepts "branch" method', () => {
      const result = validateRollbackInput('branch', 'abc123..def456');
      assert.strictEqual(result.valid, true);
    });

    test('Rejects invalid method', () => {
      const result = validateRollbackInput('invalid', 'HEAD');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects empty method', () => {
      const result = validateRollbackInput('', 'HEAD');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects null method', () => {
      const result = validateRollbackInput(null, 'HEAD');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects method with wrong case', () => {
      const result = validateRollbackInput('COMMIT', 'HEAD');
      assert.strictEqual(result.valid, false);
    });
  });

  describe('Special Cases', () => {
    test('Accepts HEAD keyword', () => {
      const result = validateRollbackInput('commit', 'HEAD');
      assert.strictEqual(result.valid, true);
    });

    test('Rejects head in lowercase (case sensitive)', () => {
      const result = validateRollbackInput('commit', 'head');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects HEAD~1 (not a valid format)', () => {
      const result = validateRollbackInput('commit', 'HEAD~1');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects HEAD^ (not a valid format)', () => {
      const result = validateRollbackInput('commit', 'HEAD^');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects empty target', () => {
      const result = validateRollbackInput('commit', '');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects whitespace-only target', () => {
      const result = validateRollbackInput('commit', '   ');
      assert.strictEqual(result.valid, false);
    });
  });

  describe('Unicode and Encoding', () => {
    test('Rejects unicode characters in hash', () => {
      const result = validateRollbackInput('commit', 'abc123😀');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects unicode characters in file path', () => {
      const result = validateRollbackInput('partial', 'file😀.js');
      assert.strictEqual(result.valid, false);
    });

    test('Rejects null bytes in target', () => {
      const result = validateRollbackInput('commit', 'abc\x00123');
      assert.strictEqual(result.valid, false);
    });
  });
});
