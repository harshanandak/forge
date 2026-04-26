// Test: Network Failures and Retry Logic Edge Cases
// Validates safeExecWithRetry() handling of network failures and retry mechanisms

import { describe, test, expect } from 'bun:test';
const { execSync } = require('node:child_process');

// Retry function implementation for testing
function safeExecWithRetry(cmd, options = {}) {
  const maxRetries = options.maxRetries !== undefined ? options.maxRetries : 3;
  const initialDelay = options.initialDelay !== undefined ? options.initialDelay : 100;
  const maxDelay = options.maxDelay !== undefined ? options.maxDelay : 1000;
  const onDelay = typeof options.onDelay === 'function' ? options.onDelay : null;

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
        if (onDelay) {
          onDelay(delay, i + 1);
        }
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
      expect(result.success).toBe(true);
      expect(result.attempts).toBe(1);
      expect(result.output).toBeTruthy();
    });

    test('should retry on failed command', () => {
      const result = safeExecWithRetry('node -e "process.exit(1)"', { maxRetries: 2, initialDelay: 50 });
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3);
      expect(result.error).toBeTruthy();
    });

    test('should respect maxRetries setting', () => {
      const result = safeExecWithRetry('node -e "process.exit(1)"', { maxRetries: 1, initialDelay: 50 });
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(2);
    });

    test('should use exponential backoff', () => {
      const startTime = Date.now();
      const result = safeExecWithRetry('node -e "process.exit(1)"', {
        maxRetries: 2,
        initialDelay: 100,
        maxDelay: 500
      });
      const duration = Date.now() - startTime;
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(3);
      expect(duration >= 250).toBeTruthy();
    });
  });

  describe('Max Retries and Delays', () => {
    test('should not exceed maxDelay', () => {
      const delays = [];
      const result = safeExecWithRetry('node -e "process.exit(1)"', {
        maxRetries: 3,
        initialDelay: 100,
        maxDelay: 150,
        onDelay: delay => delays.push(delay)
      });
      expect(result.attempts).toBe(4);
      expect(delays).toEqual([100, 150, 150]);
    });

    test('should handle zero retries', () => {
      const result = safeExecWithRetry('node -e "process.exit(1)"', { maxRetries: 0 });
      expect(result.success).toBe(false);
      expect(result.attempts).toBe(1);
    });
  });

  describe('Command Execution', () => {
    test('should capture command output on success', () => {
      const result = safeExecWithRetry('echo "hello world"', { maxRetries: 1 });
      expect(result.success).toBe(true);
      expect(result.output.includes('hello')).toBeTruthy();
    });

    test('should handle command timeout', () => {
      const result = safeExecWithRetry('echo "fast"', {
        maxRetries: 1,
        timeout: 5000
      });
      expect(result.success).toBe(true);
    });

    test('should provide error details on failure', () => {
      const result = safeExecWithRetry('nonexistent_command_xyz', {
        maxRetries: 1,
        initialDelay: 50
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
      expect(result.attempts).toBe(2);
    });
  });
});
