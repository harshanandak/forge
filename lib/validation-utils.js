/**
 * Input validation utilities
 * Extracted from bin/forge.js for reuse and testability
 * @module lib/validation-utils
 */

const fs = require('node:fs');
const path = require('node:path');

/**
 * Run common security checks on input.
 * Checks for shell injection, URL encoding attacks, and non-ASCII characters.
 * @param {string} input - Input string to validate
 * @returns {{valid: boolean, error?: string}}
 */
function validateCommonSecurity(input) {
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

  return { valid: true }; // No security issues found
}

/**
 * Validate user input against security patterns.
 * Prevents shell injection, path traversal, and unicode attacks.
 * @param {string} input - User input to validate
 * @param {string} type - Input type: 'path', 'agent', 'hash', 'directory_path'
 * @param {string} [projectRoot] - Project root path (required for 'path' type)
 * @returns {{valid: boolean, error?: string}}
 */
function validateUserInput(input, type, projectRoot) {
  // Common security checks first
  const securityResult = validateCommonSecurity(input);
  if (!securityResult.valid) return securityResult;

  // Type-specific validation - delegated to helpers
  switch (type) {
    case 'path':
      return validatePathInput(input, projectRoot);
    case 'directory_path':
      return validateDirectoryPathInput(input);
    case 'agent':
      return validateAgentInput(input);
    case 'hash':
      return validateHashInput(input);
    default:
      return { valid: true };
  }
}

/**
 * Validate 'path' type input - ensures path stays within project root.
 * @param {string} input - Path to validate
 * @param {string} projectRoot - Project root directory
 * @returns {{valid: boolean, error?: string}}
 */
function validatePathInput(input, projectRoot) {
  const resolved = path.resolve(projectRoot, input);
  const resolvedRoot = path.resolve(projectRoot);
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    return { valid: false, error: 'Path outside project root' };
  }
  return { valid: true };
}

/**
 * Validate 'directory_path' type input - blocks system directories.
 * @param {string} input - Directory path to validate
 * @returns {{valid: boolean, error?: string}}
 */
function validateDirectoryPathInput(input) {
  // Block null bytes
  if (input.includes('\0')) {
    return { valid: false, error: 'Null bytes not allowed in path' };
  }

  // Block absolute paths to sensitive system directories
  const resolved = path.resolve(input);
  const normalizedResolved = path.normalize(resolved).toLowerCase();

  // Get platform-specific blocked paths
  const blockedPaths = process.platform === 'win32'
    ? [String.raw`c:\windows`, String.raw`c:\program files`, String.raw`c:\program files (x86)`]
    : ['/etc', '/bin', '/sbin', '/boot', '/sys', '/proc', '/dev'];
  const errorMsg = process.platform === 'win32'
    ? 'Cannot target Windows system directories'
    : 'Cannot target system directories';

  if (blockedPaths.some(blocked => normalizedResolved.startsWith(blocked))) {
    return { valid: false, error: errorMsg };
  }

  return { valid: true };
}

/**
 * Validate 'agent' type input - lowercase alphanumeric with hyphens only.
 * @param {string} input - Agent name to validate
 * @returns {{valid: boolean, error?: string}}
 */
function validateAgentInput(input) {
  if (!/^[a-z0-9-]+$/.test(input)) {
    return { valid: false, error: 'Agent name must be lowercase alphanumeric with hyphens' };
  }
  return { valid: true };
}

/**
 * Validate 'hash' type input - git commit hash (4-40 hex chars).
 * @param {string} input - Hash to validate
 * @returns {{valid: boolean, error?: string}}
 */
function validateHashInput(input) {
  if (!/^[0-9a-f]{4,40}$/i.test(input)) {
    return { valid: false, error: 'Invalid commit hash format (must be 4-40 hex chars)' };
  }
  return { valid: true };
}

/**
 * Check write permission to a directory or file.
 * @param {string} filePath - Path to check
 * @returns {{writable: boolean, error?: string}}
 */
function _checkWritePermission(filePath) {
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

module.exports = {
  validateCommonSecurity,
  validateUserInput,
  validatePathInput,
  validateDirectoryPathInput,
  validateAgentInput,
  validateHashInput,
  _checkWritePermission
};
