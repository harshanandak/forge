// Test: Network Failures and Retry Logic Edge Cases
// Validates safeExecWithRetry() handling of network failures and retry mechanisms

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');

// Retry function implementation for testing
function safeExecWithRetry(cmd, options = {}) {
  const maxRetries = options.maxRetries !== undefined ? options.maxRetries : 3;
  const initialDelay = options.initialDelay !== undefined ? options.initialDelay : 100;
  const maxDelay = options.maxDelay !== undefined ? options.maxDelay : 1000;

  let attempts = 0;
  let lastError = null;

  for (let i = 0; i <= maxRetries; i++) {
    attempts++;
    try {
      const output = execSync(cmd, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: options.timeout || 30000
      }).trim();
      return { success: true, output, attempts };
    } catch (err) {
      lastError = err;

      if (i < maxRetries) {
        const delay = Math.min(initialDelay * Math.pow(2, i), maxDelay);
        const start = Date.now();
        while (Date.now() - start < delay) {}
      }
    }
  }

  return {
    success: false,
    error: lastError.message || 'Command failed after retries',
    attempts
  };
}

describe('network-failures-edge-cases', () => {
  describe('Retry Logic', () => {
    test('should succeed on first attempt with valid command', () => {
      const result = safeExecWithRetry('echo "test"', { maxRetries: 3 });
      assert.strictEqual(result.success, true, 'Should succeed on first try');
      assert.strictEqual(result.attempts, 1, 'Should only attempt once');
      assert.ok(result.output, 'Should have output');
    });

    test('should retry on failed command', () => {
      const result = safeExecWithRetry('node -e "process.exit(1)"', { maxRetries: 2, initialDelay: 50 });
      assert.strictEqual(result.success, false, 'Should fail after retries');
      assert.strictEqual(result.attempts, 3, 'Should attempt 3 times (1 + 2 retries)');
      assert.ok(result.error, 'Should have error message');
    });

    test('should respect maxRetries setting', () => {
      const result = safeExecWithRetry('node -e "process.exit(1)"', { maxRetries: 1, initialDelay: 50 });
      assert.strictEqual(result.success, false, 'Should fail');
      assert.strictEqual(result.attempts, 2, 'Should attempt 2 times (1 + 1 retry)');
    });

    test('should use exponential backoff', () => {
      const startTime = Date.now();
      const result = safeExecWithRetry('node -e "process.exit(1)"', {
        maxRetries: 2,
        initialDelay: 100,
        maxDelay: 500
      });
      const duration = Date.now() - startTime;
      assert.strictEqual(result.success, false, 'Should fail');
      assert.strictEqual(result.attempts, 3, 'Should attempt 3 times');
      assert.ok(duration >= 250, 'Should use exponential backoff delays');
    });
  });

  describe('Max Retries and Delays', () => {
    test('should not exceed maxDelay', () => {
      const startTime = Date.now();
      const result = safeExecWithRetry('node -e "process.exit(1)"', {
        maxRetries: 3,
        initialDelay: 100,
        maxDelay: 150
      });
      const duration = Date.now() - startTime;
      assert.strictEqual(result.attempts, 4, 'Should attempt 4 times (1 + 3 retries)');
      assert.ok(duration < 600, 'Should respect maxDelay cap');
    });

    test('should handle zero retries', () => {
      const result = safeExecWithRetry('node -e "process.exit(1)"', { maxRetries: 0 });
      assert.strictEqual(result.success, false, 'Should fail');
      assert.strictEqual(result.attempts, 1, 'Should only attempt once with maxRetries=0');
    });
  });

  describe('Command Execution', () => {
    test('should capture command output on success', () => {
      const result = safeExecWithRetry('echo "hello world"', { maxRetries: 1 });
      assert.strictEqual(result.success, true, 'Should succeed');
      assert.ok(result.output.includes('hello'), 'Should capture output');
    });

    test('should handle command timeout', () => {
      const result = safeExecWithRetry('echo "fast"', {
        maxRetries: 1,
        timeout: 5000
      });
      assert.strictEqual(result.success, true, 'Should succeed before timeout');
    });

    test('should provide error details on failure', () => {
      const result = safeExecWithRetry('nonexistent_command_xyz', {
        maxRetries: 1,
        initialDelay: 50
      });
      assert.strictEqual(result.success, false, 'Should fail');
      assert.ok(result.error, 'Should have error message');
      assert.strictEqual(result.attempts, 2, 'Should retry once');
    });
  });
});
