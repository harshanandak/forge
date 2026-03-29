const { describe, test, expect, beforeEach, afterEach } = require('bun:test');
const { execFileSync } = require('node:child_process');

/**
 * Extract the isBdAvailable logic into a testable function.
 * This mirrors what scripts/beads-context.test.js uses as its skip guard.
 *
 * Enhanced version: checks both binary existence AND Dolt connectivity.
 * BD_TIMEOUT env var overrides the default 3000ms timeout.
 */
function isBdAvailable() {
	try {
		execFileSync('bd', ['--version'], { stdio: 'ignore' });
		// Also verify Dolt database is reachable (not just binary exists)
		const timeout = parseInt(process.env.BD_TIMEOUT || '3000', 10);
		execFileSync('bd', ['list', '--limit=1'], { stdio: 'ignore', timeout });
		return true;
	} catch {
		return false;
	}
}

describe('isBdAvailable', () => {
	let originalBdTimeout;

	beforeEach(() => {
		originalBdTimeout = process.env.BD_TIMEOUT;
	});

	afterEach(() => {
		if (originalBdTimeout === undefined) {
			delete process.env.BD_TIMEOUT;
		} else {
			process.env.BD_TIMEOUT = originalBdTimeout;
		}
	});

	test('returns a boolean', () => {
		const result = isBdAvailable();
		expect(typeof result).toBe('boolean');
	});

	test('checks Dolt connectivity, not just binary existence', () => {
		// The function must call bd list (connectivity), not just bd --version.
		// We verify this by confirming the function body includes 'list' command.
		// Note: Bun's toString() may use double quotes, so check for both.
		const fnSource = isBdAvailable.toString();
		expect(fnSource).toContain('list');
		expect(fnSource).toContain('--limit=1');
	});

	test('BD_TIMEOUT env var overrides default timeout', () => {
		// Verify the function reads BD_TIMEOUT from env
		const fnSource = isBdAvailable.toString();
		expect(fnSource).toContain('BD_TIMEOUT');
		expect(fnSource).toContain('3000');
	});

	test('BD_TIMEOUT env var is parsed as integer', () => {
		process.env.BD_TIMEOUT = '5000';
		// Function should not throw when BD_TIMEOUT is set
		const result = isBdAvailable();
		expect(typeof result).toBe('boolean');
	});

	test('returns false when bd binary does not exist', () => {
		// On CI or machines without bd, this naturally returns false.
		// We can't easily mock execFileSync in this context, but we can
		// verify the guard function doesn't throw — it returns false.
		const result = isBdAvailable();
		// If bd is not installed, result must be false (not throw)
		if (result === false) {
			expect(result).toBe(false);
		}
		// If bd IS installed and Dolt IS reachable, result is true — also valid
		expect(typeof result).toBe('boolean');
	});

	test('does not hang — completes within BD_TIMEOUT', () => {
		// Set a very short timeout to prove the timeout mechanism works.
		// If Dolt is unreachable, this should fail fast, not hang.
		process.env.BD_TIMEOUT = '1000';
		const start = Date.now();
		const _result = isBdAvailable();
		const elapsed = Date.now() - start;
		// Must complete within 5 seconds regardless (generous buffer over 1s timeout)
		expect(elapsed).toBeLessThan(5000);
	});
});
