// Test: validateRollbackInput()
// GREEN phase - Tests should pass with implementation

import { describe, test, expect } from 'bun:test';
const path = require('node:path');

// Mock projectRoot for testing
const projectRoot = process.cwd();

// IMPLEMENTATION (GREEN phase - make tests pass)

// Helper: Validate commit hash format
function validateCommitHash(hash) {
  if (hash === 'HEAD') return true;
  return /^[0-9a-f]{4,40}$/i.test(hash);
}

// Helper: Validate file path
function validateFilePath(file, root) {
  if (/[;|&$`()<>\r\n]/.test(file)) {
    return { valid: false, error: `Invalid characters in path: ${file}` };
  }
  const resolved = path.resolve(root, file);
  if (!resolved.startsWith(root)) {
    return { valid: false, error: `Path outside project: ${file}` };
  }
  return { valid: true };
}

// Helper: Validate branch range
function validateBranchRange(target) {
  if (!target.includes('..')) {
    return { valid: false, error: 'Branch range must use format: start..end' };
  }
  const [start, end] = target.split('..');
  if (!validateCommitHash(start) || !validateCommitHash(end)) {
    return { valid: false, error: 'Invalid commit hashes in range' };
  }
  return { valid: true };
}

// Helper: Validate partial rollback files
function validatePartialFiles(target, root) {
  const files = target.split(',').map(f => f.trim());
  for (const file of files) {
    const result = validateFilePath(file, root);
    if (!result.valid) return result;
  }
  return { valid: true };
}

// Main validation function (reduced complexity)
function validateRollbackInput(method, target) {
  const validMethods = ['commit', 'pr', 'partial', 'branch'];
  if (!validMethods.includes(method)) {
    return { valid: false, error: 'Invalid method' };
  }

  if (method === 'commit' || method === 'pr') {
    if (!validateCommitHash(target)) {
      return { valid: false, error: 'Invalid commit hash format' };
    }
  }

  if (method === 'partial') {
    return validatePartialFiles(target, projectRoot);
  }

  if (method === 'branch') {
    return validateBranchRange(target);
  }

  return { valid: true };
}

describe('GREEN Phase: Rollback Validation Tests', () => {
  test('Valid commit hash', () => {
    const result = validateRollbackInput('commit', 'a1b2c3d');
    expect(result.valid).toBe(true);
  });

  test('HEAD is valid', () => {
    const result = validateRollbackInput('commit', 'HEAD');
    expect(result.valid).toBe(true);
  });

  test('Invalid commit hash with semicolon', () => {
    const result = validateRollbackInput('commit', 'abc;rm -rf /');
    expect(result.valid).toBe(false);
    expect(result.error.includes('Invalid')).toBeTruthy();
  });

  test('Invalid method', () => {
    const result = validateRollbackInput('invalid', 'HEAD');
    expect(result.valid).toBe(false);
  });

  test('Path validation - reject path traversal', () => {
    const result = validateRollbackInput('partial', '../../../etc/passwd');
    expect(result.valid).toBe(false);
  });

  test('Valid file paths', () => {
    const result = validateRollbackInput('partial', 'AGENTS.md,package.json');
    expect(result.valid).toBe(true);
  });

  test('Branch range validation', () => {
    const result = validateRollbackInput('branch', 'abc123..def456');
    expect(result.valid).toBe(true);
  });
});
