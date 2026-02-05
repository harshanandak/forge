// Test: Security Validation Edge Cases
// Comprehensive security validation (shell injection, path traversal, unicode attacks)
// Reuses patterns from test/rollback-edge-cases.test.js

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Security validation function (will be added to bin/forge.js)
function validateUserInput(input, type) {
  // Shell injection check - common shell metacharacters
  if (/[;|&$`()<>\r\n]/.test(input)) {
    return { valid: false, error: 'Invalid characters detected (shell metacharacters)' };
  }

  // URL encoding check - prevent encoded path traversal
  if (/%2[eE]|%2[fF]|%5[cC]/.test(input)) {
    return { valid: false, error: 'URL-encoded characters not allowed' };
  }

  // ASCII-only check - prevent unicode attacks
  if (!/^[\x20-\x7E]+$/.test(input)) {
    return { valid: false, error: 'Only ASCII printable characters allowed' };
  }

  // Type-specific validation
  if (type === 'path') {
    // For testing, use current directory as project root
    const projectRoot = process.cwd();
    const resolved = path.resolve(projectRoot, input);
    if (!resolved.startsWith(projectRoot)) {
      return { valid: false, error: 'Path outside project root' };
    }
  } else if (type === 'agent') {
    // Agent names: lowercase alphanumeric with hyphens only
    if (!/^[a-z0-9-]+$/.test(input)) {
      return { valid: false, error: 'Agent name must be lowercase alphanumeric with hyphens' };
    }
  } else if (type === 'hash') {
    // Git commit hash: 4-40 hexadecimal characters
    if (!/^[0-9a-f]{4,40}$/i.test(input)) {
      return { valid: false, error: 'Invalid commit hash format (must be 4-40 hex chars)' };
    }
  }

  return { valid: true };
}

describe('security-validation', () => {
  describe('Shell Injection Prevention', () => {
    test('should reject semicolon injection', () => {
      const result = validateUserInput('test;rm -rf /', 'path');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('shell metacharacters'));
    });

    test('should reject pipe injection', () => {
      const result = validateUserInput('test|cat /etc/passwd', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject ampersand injection', () => {
      const result = validateUserInput('test&whoami', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject backtick injection', () => {
      const result = validateUserInput('test`whoami`', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject dollar sign command substitution', () => {
      const result = validateUserInput('test$(whoami)', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject newline injection', () => {
      const result = validateUserInput('test\nrm -rf /', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject carriage return injection', () => {
      const result = validateUserInput('test\rrm -rf /', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject output redirection', () => {
      const result = validateUserInput('test>/etc/passwd', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject input redirection', () => {
      const result = validateUserInput('test</etc/passwd', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject append operator', () => {
      const result = validateUserInput('test>>/etc/passwd', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject AND operator', () => {
      const result = validateUserInput('test&&whoami', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject OR operator', () => {
      const result = validateUserInput('test||whoami', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject parentheses', () => {
      const result = validateUserInput('test(ls)', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject angle brackets', () => {
      const result = validateUserInput('<script>alert(1)</script>', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject multiple operators', () => {
      const result = validateUserInput('test;|&&&||', 'path');
      assert.strictEqual(result.valid, false);
    });
  });

  describe('Path Traversal Prevention', () => {
    test('should reject parent directory traversal', () => {
      const result = validateUserInput('../../../etc/passwd', 'path');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('outside project root'));
    });

    test('should reject absolute Unix paths', () => {
      const result = validateUserInput('/etc/passwd', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject URL-encoded dot', () => {
      const result = validateUserInput('%2e%2e/passwd', 'path');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('URL-encoded'));
    });

    test('should reject URL-encoded slash', () => {
      const result = validateUserInput('..%2fpasswd', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject URL-encoded backslash', () => {
      const result = validateUserInput('..%5cpasswd', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject mixed URL encoding', () => {
      const result = validateUserInput('..%2F..%2Fetc', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject Windows path traversal', () => {
      const result = validateUserInput('..\\..\\windows\\system32', 'path');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('ASCII') || result.error.includes('outside'));
    });

    test('should reject Windows drive letters', () => {
      const result = validateUserInput('C:\\Windows\\System32', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject UNC paths', () => {
      const result = validateUserInput('\\\\server\\share', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should allow safe relative paths', () => {
      const result = validateUserInput('docs/readme.md', 'path');
      assert.strictEqual(result.valid, true, 'Safe relative paths should be allowed');
    });
  });

  describe('Unicode Injection', () => {
    test('should reject zero-width space', () => {
      const result = validateUserInput('test\u200Bfile', 'path');
      assert.strictEqual(result.valid, false);
      assert.ok(result.error.includes('ASCII'));
    });

    test('should reject right-to-left override', () => {
      const result = validateUserInput('test\u202Efile', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject emoji in path', () => {
      const result = validateUserInput('📁folder/file.txt', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject Chinese characters', () => {
      const result = validateUserInput('路径/file.txt', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject Cyrillic lookalikes', () => {
      const result = validateUserInput('аdmin', 'path'); // First 'а' is Cyrillic
      assert.strictEqual(result.valid, false);
    });

    test('should reject homoglyph attacks', () => {
      const result = validateUserInput('раypal', 'path'); // 'а' and 'р' are Cyrillic
      assert.strictEqual(result.valid, false);
    });

    test('should reject non-printable ASCII', () => {
      const result = validateUserInput('test\x00file', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should reject high-bit characters', () => {
      const result = validateUserInput('test\xFFfile', 'path');
      assert.strictEqual(result.valid, false);
    });
  });

  describe('Input Sanitization by Type', () => {
    test('agent name - should allow valid format', () => {
      const result = validateUserInput('claude-code', 'agent');
      assert.strictEqual(result.valid, true);
    });

    test('agent name - should reject uppercase', () => {
      const result = validateUserInput('Claude-Code', 'agent');
      assert.strictEqual(result.valid, false);
    });

    test('agent name - should reject underscores', () => {
      const result = validateUserInput('claude_code', 'agent');
      assert.strictEqual(result.valid, false);
    });

    test('agent name - should reject special characters', () => {
      const result = validateUserInput('claude@code', 'agent');
      assert.strictEqual(result.valid, false);
    });

    test('commit hash - should allow valid short hash', () => {
      const result = validateUserInput('abc123', 'hash');
      assert.strictEqual(result.valid, true);
    });

    test('commit hash - should allow valid long hash', () => {
      const result = validateUserInput('abc123def456abc123def456abc123def456abcd', 'hash');
      assert.strictEqual(result.valid, true);
    });

    test('commit hash - should reject non-hex characters', () => {
      const result = validateUserInput('xyz123', 'hash');
      assert.strictEqual(result.valid, false);
    });

    test('commit hash - should reject too short', () => {
      const result = validateUserInput('abc', 'hash');
      assert.strictEqual(result.valid, false);
    });

    test('commit hash - should reject too long', () => {
      const result = validateUserInput('a'.repeat(41), 'hash');
      assert.strictEqual(result.valid, false);
    });

    test('path - should allow alphanumeric with dash', () => {
      const result = validateUserInput('my-project-123', 'path');
      assert.strictEqual(result.valid, true);
    });
  });

  describe('Edge Case Combinations', () => {
    test('should reject multiple attack vectors combined', () => {
      const result = validateUserInput(';../../../etc\npässwd', 'path');
      assert.strictEqual(result.valid, false);
    });

    test('should handle empty string', () => {
      const result = validateUserInput('', 'path');
      // Empty string is technically valid ASCII, behavior may vary
      // Just verify it doesn't crash
      assert.ok(typeof result.valid === 'boolean');
    });

    test('should handle very long input', () => {
      const result = validateUserInput('a'.repeat(10000), 'path');
      // Should not crash on long input
      assert.ok(typeof result.valid === 'boolean');
    });
  });
});
