const { describe, test, expect } = require('bun:test');

const {
  validateCommonSecurity,
  validateUserInput,
  validatePathInput,
  validateDirectoryPathInput,
  validateAgentInput,
  validateHashInput,
  _checkWritePermission
} = require('../lib/validation-utils');

describe('validation-utils', () => {
  describe('validateCommonSecurity', () => {
    test('rejects shell metacharacters', () => {
      expect(validateCommonSecurity('hello;world')).toEqual({
        valid: false,
        error: 'Invalid characters detected (shell metacharacters)'
      });
      expect(validateCommonSecurity('a|b')).toEqual({
        valid: false,
        error: 'Invalid characters detected (shell metacharacters)'
      });
      expect(validateCommonSecurity('$(cmd)')).toEqual({
        valid: false,
        error: 'Invalid characters detected (shell metacharacters)'
      });
    });

    test('rejects URL-encoded path traversal', () => {
      expect(validateCommonSecurity('hello%2e%2e')).toEqual({
        valid: false,
        error: 'URL-encoded characters not allowed'
      });
      expect(validateCommonSecurity('%2Fetc')).toEqual({
        valid: false,
        error: 'URL-encoded characters not allowed'
      });
    });

    test('rejects non-ASCII characters', () => {
      const result = validateCommonSecurity('hello\u00e9world');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Only ASCII printable characters allowed');
    });

    test('accepts valid ASCII input', () => {
      expect(validateCommonSecurity('hello-world_123')).toEqual({ valid: true });
      expect(validateCommonSecurity('path/to/file.txt')).toEqual({ valid: true });
    });
  });

  describe('validateUserInput', () => {
    test('delegates to validatePathInput for path type', () => {
      const projectRoot = process.cwd();
      const result = validateUserInput('src/index.js', 'path', projectRoot);
      expect(result.valid).toBe(true);
    });

    test('delegates to validateDirectoryPathInput for directory_path type', () => {
      const result = validateUserInput('./my-project', 'directory_path');
      expect(result.valid).toBe(true);
    });

    test('delegates to validateAgentInput for agent type', () => {
      const result = validateUserInput('claude', 'agent');
      expect(result.valid).toBe(true);
    });

    test('delegates to validateHashInput for hash type', () => {
      const result = validateUserInput('abc123', 'hash');
      expect(result.valid).toBe(true);
    });

    test('runs common security checks first', () => {
      const result = validateUserInput('hello;rm -rf /', 'path', process.cwd());
      expect(result.valid).toBe(false);
      expect(result.error).toContain('shell metacharacters');
    });

    test('returns valid for unknown type', () => {
      const result = validateUserInput('anything', 'unknown');
      expect(result.valid).toBe(true);
    });
  });

  describe('validatePathInput', () => {
    test('accepts paths within project root', () => {
      const projectRoot = process.cwd();
      const result = validatePathInput('src/index.js', projectRoot);
      expect(result.valid).toBe(true);
    });

    test('rejects path traversal outside project root', () => {
      const projectRoot = process.cwd();
      // Use enough ../ to escape project root
      const result = validatePathInput('../../../../etc/passwd', projectRoot);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Path outside project root');
    });
  });

  describe('validateDirectoryPathInput', () => {
    test('rejects null bytes', () => {
      const result = validateDirectoryPathInput('path\0/evil');
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Null bytes not allowed in path');
    });

    test('rejects system directories', () => {
      const systemDir = process.platform === 'win32'
        ? 'C:\\Windows\\System32'
        : '/etc/shadow';
      const result = validateDirectoryPathInput(systemDir);
      expect(result.valid).toBe(false);
    });

    test('accepts normal directories', () => {
      const result = validateDirectoryPathInput('./my-project');
      expect(result.valid).toBe(true);
    });
  });

  describe('validateAgentInput', () => {
    test('accepts lowercase alphanumeric with hyphens', () => {
      expect(validateAgentInput('claude')).toEqual({ valid: true });
      expect(validateAgentInput('my-agent-1')).toEqual({ valid: true });
    });

    test('rejects uppercase', () => {
      const result = validateAgentInput('Claude');
      expect(result.valid).toBe(false);
    });

    test('rejects special characters', () => {
      const result = validateAgentInput('my_agent');
      expect(result.valid).toBe(false);
    });
  });

  describe('validateHashInput', () => {
    test('accepts valid short hash', () => {
      expect(validateHashInput('abcd')).toEqual({ valid: true });
    });

    test('accepts valid full SHA-1 hash', () => {
      expect(validateHashInput('abc123def456abc123def456abc123def456abc1')).toEqual({ valid: true });
    });

    test('rejects too short hash', () => {
      const result = validateHashInput('abc');
      expect(result.valid).toBe(false);
    });

    test('rejects non-hex characters', () => {
      const result = validateHashInput('ghijklmn');
      expect(result.valid).toBe(false);
    });
  });

  describe('_checkWritePermission', () => {
    test('returns writable for temp directory', () => {
      const os = require('node:os');
      const result = _checkWritePermission(os.tmpdir());
      expect(result.writable).toBe(true);
    });

    test('returns not writable for non-existent path', () => {
      const result = _checkWritePermission('/nonexistent/path/that/does/not/exist');
      expect(result.writable).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
