// Test: validateRollbackInput()
// GREEN phase - Tests should pass with implementation

const assert = require('assert');
const path = require('path');

// Mock projectRoot for testing
const projectRoot = process.cwd();

// IMPLEMENTATION (GREEN phase - make tests pass)
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

console.log('=== GREEN Phase: Rollback Validation Tests ===\n');

// Test 1: Valid commit hash
try {
  const result = validateRollbackInput('commit', 'a1b2c3d');
  assert.strictEqual(result.valid, true, 'Should accept valid commit hash');
  console.log('✓ Test 1 PASSED: Valid commit hash');
} catch (err) {
  console.log('✗ Test 1 FAILED:', err.message);
}

// Test 2: HEAD is valid
try {
  const result = validateRollbackInput('commit', 'HEAD');
  assert.strictEqual(result.valid, true, 'Should accept HEAD');
  console.log('✓ Test 2 PASSED: HEAD accepted');
} catch (err) {
  console.log('✗ Test 2 FAILED:', err.message);
}

// Test 3: Invalid commit hash with semicolon
try {
  const result = validateRollbackInput('commit', 'abc;rm -rf /');
  assert.strictEqual(result.valid, false, 'Should reject shell metacharacters');
  assert.ok(result.error.includes('Invalid'), 'Should have error message');
  console.log('✓ Test 3 PASSED: Rejects shell metacharacters');
} catch (err) {
  console.log('✗ Test 3 FAILED:', err.message);
}

// Test 4: Invalid method
try {
  const result = validateRollbackInput('invalid', 'HEAD');
  assert.strictEqual(result.valid, false, 'Should reject invalid method');
  console.log('✓ Test 4 PASSED: Rejects invalid method');
} catch (err) {
  console.log('✗ Test 4 FAILED:', err.message);
}

// Test 5: Path validation - reject path traversal
try {
  const result = validateRollbackInput('partial', '../../../etc/passwd');
  assert.strictEqual(result.valid, false, 'Should reject path traversal');
  console.log('✓ Test 5 PASSED: Rejects path traversal');
} catch (err) {
  console.log('✗ Test 5 FAILED:', err.message);
}

// Test 6: Valid file paths
try {
  const result = validateRollbackInput('partial', 'AGENTS.md,package.json');
  assert.strictEqual(result.valid, true, 'Should accept valid file paths');
  console.log('✓ Test 6 PASSED: Accepts valid file paths');
} catch (err) {
  console.log('✗ Test 6 FAILED:', err.message);
}

// Test 7: Branch range validation
try {
  const result = validateRollbackInput('branch', 'abc123..def456');
  assert.strictEqual(result.valid, true, 'Should accept valid range');
  console.log('✓ Test 7 PASSED: Accepts valid branch range');
} catch (err) {
  console.log('✗ Test 7 FAILED:', err.message);
}

console.log('\n=== Expected: All tests should PASS (GREEN phase) ===');
console.log('✅ Validation function implemented with security checks');
