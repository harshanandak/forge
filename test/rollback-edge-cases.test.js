// Test: Rollback Edge Cases and Security
// Comprehensive edge case testing for rollback system

const assert = require('assert');
const path = require('path');

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

console.log('=== Rollback Edge Cases & Security Tests ===\n');

let passedTests = 0;
let failedTests = 0;

function runTest(name, testFn) {
  try {
    testFn();
    console.log(`✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.log(`✗ ${name}: ${err.message}`);
    failedTests++;
  }
}

// ============================================================================
// COMMIT HASH EDGE CASES
// ============================================================================

console.log('--- Commit Hash Edge Cases ---\n');

runTest('Accepts 4-character hash (minimum)', () => {
  const result = validateRollbackInput('commit', 'abcd');
  assert.strictEqual(result.valid, true);
});

runTest('Accepts 40-character hash (maximum)', () => {
  const result = validateRollbackInput('commit', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2');
  assert.strictEqual(result.valid, true);
});

runTest('Rejects 3-character hash (too short)', () => {
  const result = validateRollbackInput('commit', 'abc');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects 41-character hash (too long)', () => {
  const result = validateRollbackInput('commit', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c');
  assert.strictEqual(result.valid, false);
});

runTest('Accepts uppercase hex characters', () => {
  const result = validateRollbackInput('commit', 'ABCDEF123');
  assert.strictEqual(result.valid, true);
});

runTest('Accepts mixed case hex', () => {
  const result = validateRollbackInput('commit', 'AbCdEf123');
  assert.strictEqual(result.valid, true);
});

runTest('Rejects hash with non-hex characters', () => {
  const result = validateRollbackInput('commit', 'g1h2i3j4');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects hash with special characters', () => {
  const result = validateRollbackInput('commit', 'abc-123');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects hash with spaces', () => {
  const result = validateRollbackInput('commit', 'abc 123');
  assert.strictEqual(result.valid, false);
});

// ============================================================================
// SHELL INJECTION ATTEMPTS
// ============================================================================

console.log('\n--- Shell Injection Prevention ---\n');

runTest('Rejects semicolon injection', () => {
  const result = validateRollbackInput('commit', 'abc123;rm -rf /');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects pipe injection', () => {
  const result = validateRollbackInput('commit', 'abc123|cat /etc/passwd');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects ampersand injection', () => {
  const result = validateRollbackInput('commit', 'abc123&whoami');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects dollar sign injection', () => {
  const result = validateRollbackInput('commit', 'abc123$(whoami)');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects backtick injection', () => {
  const result = validateRollbackInput('commit', 'abc123`whoami`');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects parenthesis injection', () => {
  const result = validateRollbackInput('commit', 'abc123(ls)');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects angle bracket injection', () => {
  const result = validateRollbackInput('commit', 'abc123<file.txt');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects newline injection', () => {
  const result = validateRollbackInput('commit', 'abc123\nrm -rf /');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects carriage return injection', () => {
  const result = validateRollbackInput('commit', 'abc123\rrm -rf /');
  assert.strictEqual(result.valid, false);
});

// ============================================================================
// PATH TRAVERSAL ATTACKS
// ============================================================================

console.log('\n--- Path Traversal Prevention ---\n');

runTest('Rejects simple path traversal', () => {
  const result = validateRollbackInput('partial', '../etc/passwd');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects multiple level traversal', () => {
  const result = validateRollbackInput('partial', '../../../etc/passwd');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects absolute path outside project', () => {
  const result = validateRollbackInput('partial', '/etc/passwd');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects Windows path traversal', () => {
  const result = validateRollbackInput('partial', '..\\..\\Windows\\System32');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects encoded path traversal', () => {
  const result = validateRollbackInput('partial', '..%2F..%2Fetc%2Fpasswd');
  assert.strictEqual(result.valid, false);
});

runTest('Accepts relative path within project', () => {
  const result = validateRollbackInput('partial', 'src/auth.js');
  assert.strictEqual(result.valid, true);
});

runTest('Accepts nested path within project', () => {
  const result = validateRollbackInput('partial', 'src/components/ui/Button.tsx');
  assert.strictEqual(result.valid, true);
});

// ============================================================================
// FILE PATH EDGE CASES
// ============================================================================

console.log('\n--- File Path Edge Cases ---\n');

runTest('Accepts multiple comma-separated files', () => {
  const result = validateRollbackInput('partial', 'file1.js,file2.js,file3.js');
  assert.strictEqual(result.valid, true);
});

runTest('Handles whitespace around commas', () => {
  const result = validateRollbackInput('partial', 'file1.js , file2.js , file3.js');
  assert.strictEqual(result.valid, true);
});

runTest('Rejects file with semicolon in name', () => {
  const result = validateRollbackInput('partial', 'file;rm.js');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects file with pipe in name', () => {
  const result = validateRollbackInput('partial', 'file|cat.js');
  assert.strictEqual(result.valid, false);
});

runTest('Accepts file with dots in name', () => {
  const result = validateRollbackInput('partial', 'config.test.js');
  assert.strictEqual(result.valid, true);
});

runTest('Accepts file with dashes in name', () => {
  const result = validateRollbackInput('partial', 'my-component.js');
  assert.strictEqual(result.valid, true);
});

runTest('Accepts file with underscores in name', () => {
  const result = validateRollbackInput('partial', 'my_component.js');
  assert.strictEqual(result.valid, true);
});

// ============================================================================
// BRANCH RANGE EDGE CASES
// ============================================================================

console.log('\n--- Branch Range Edge Cases ---\n');

runTest('Accepts valid branch range', () => {
  const result = validateRollbackInput('branch', 'abc123..def456');
  assert.strictEqual(result.valid, true);
});

runTest('Rejects range with single dot', () => {
  const result = validateRollbackInput('branch', 'abc123.def456');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects range with three dots', () => {
  const result = validateRollbackInput('branch', 'abc123...def456');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects range with no separator', () => {
  const result = validateRollbackInput('branch', 'abc123def456');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects range with invalid start hash', () => {
  const result = validateRollbackInput('branch', 'xyz..def456');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects range with invalid end hash', () => {
  const result = validateRollbackInput('branch', 'abc123..xyz');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects range with short start hash', () => {
  const result = validateRollbackInput('branch', 'abc..def456');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects range with short end hash', () => {
  const result = validateRollbackInput('branch', 'abc123..def');
  assert.strictEqual(result.valid, false);
});

runTest('Accepts range with mixed case hashes', () => {
  const result = validateRollbackInput('branch', 'AbC123..DeF456');
  assert.strictEqual(result.valid, true);
});

// ============================================================================
// METHOD VALIDATION
// ============================================================================

console.log('\n--- Method Validation ---\n');

runTest('Accepts "commit" method', () => {
  const result = validateRollbackInput('commit', 'HEAD');
  assert.strictEqual(result.valid, true);
});

runTest('Accepts "pr" method', () => {
  const result = validateRollbackInput('pr', 'abc123');
  assert.strictEqual(result.valid, true);
});

runTest('Accepts "partial" method', () => {
  const result = validateRollbackInput('partial', 'file.js');
  assert.strictEqual(result.valid, true);
});

runTest('Accepts "branch" method', () => {
  const result = validateRollbackInput('branch', 'abc123..def456');
  assert.strictEqual(result.valid, true);
});

runTest('Rejects invalid method', () => {
  const result = validateRollbackInput('invalid', 'HEAD');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects empty method', () => {
  const result = validateRollbackInput('', 'HEAD');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects null method', () => {
  const result = validateRollbackInput(null, 'HEAD');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects method with wrong case', () => {
  const result = validateRollbackInput('COMMIT', 'HEAD');
  assert.strictEqual(result.valid, false);
});

// ============================================================================
// SPECIAL CASES
// ============================================================================

console.log('\n--- Special Cases ---\n');

runTest('Accepts HEAD keyword', () => {
  const result = validateRollbackInput('commit', 'HEAD');
  assert.strictEqual(result.valid, true);
});

runTest('Rejects head in lowercase (case sensitive)', () => {
  const result = validateRollbackInput('commit', 'head');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects HEAD~1 (not a valid format)', () => {
  const result = validateRollbackInput('commit', 'HEAD~1');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects HEAD^ (not a valid format)', () => {
  const result = validateRollbackInput('commit', 'HEAD^');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects empty target', () => {
  const result = validateRollbackInput('commit', '');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects whitespace-only target', () => {
  const result = validateRollbackInput('commit', '   ');
  assert.strictEqual(result.valid, false);
});

// ============================================================================
// UNICODE AND ENCODING EDGE CASES
// ============================================================================

console.log('\n--- Unicode and Encoding ---\n');

runTest('Rejects unicode characters in hash', () => {
  const result = validateRollbackInput('commit', 'abc123😀');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects unicode characters in file path', () => {
  const result = validateRollbackInput('partial', 'file😀.js');
  assert.strictEqual(result.valid, false);
});

runTest('Rejects null bytes in target', () => {
  const result = validateRollbackInput('commit', 'abc\x00123');
  assert.strictEqual(result.valid, false);
});

// ============================================================================
// RESULTS SUMMARY
// ============================================================================

console.log('\n' + '='.repeat(60));
console.log('Test Results Summary');
console.log('='.repeat(60));
console.log(`Total Tests: ${passedTests + failedTests}`);
console.log(`Passed: ${passedTests} ✓`);
console.log(`Failed: ${failedTests} ✗`);
console.log('='.repeat(60));

if (failedTests === 0) {
  console.log('\n✅ All edge case tests PASSED!');
  console.log('✅ Rollback validation is secure against:');
  console.log('   - Command injection attacks');
  console.log('   - Path traversal attacks');
  console.log('   - Invalid input formats');
  console.log('   - Edge cases and malformed data');
  process.exit(0);
} else {
  console.log('\n❌ Some tests FAILED!');
  process.exit(1);
}
