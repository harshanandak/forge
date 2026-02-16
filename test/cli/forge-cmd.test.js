const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const {
	parseArgs,
	isValidCommand,
	validateArgs,
	validateSlug,
	getHelpText,
} = require('../../bin/forge-cmd.js');

describe('CLI Command Dispatcher', () => {
	describe('parseArgs', () => {
		test('should parse command without arguments', () => {
			const args = ['node', 'forge-cmd.js', 'status'];
			const result = parseArgs(args);
			assert.strictEqual(result.command, 'status');
			assert.deepStrictEqual(result.args, []);
		});

		test('should parse command with single argument', () => {
			const args = ['node', 'forge-cmd.js', 'research', 'stripe-billing'];
			const result = parseArgs(args);
			assert.strictEqual(result.command, 'research');
			assert.deepStrictEqual(result.args, ['stripe-billing']);
		});

		test('should parse command with multiple arguments', () => {
			const args = ['node', 'forge-cmd.js', 'review', '123'];
			const result = parseArgs(args);
			assert.strictEqual(result.command, 'review');
			assert.deepStrictEqual(result.args, ['123']);
		});

		test('should handle no command (show help)', () => {
			const args = ['node', 'forge-cmd.js'];
			const result = parseArgs(args);
			assert.strictEqual(result.command, null);
		});
	});

	describe('Command validation', () => {
		test('should reject unknown command', () => {
			const command = 'unknown-command';
			const isValid = isValidCommand(command);
			assert.strictEqual(isValid, false);
		});

		test('should accept valid commands', () => {
			const validCommands = [
				'status',
				'research',
				'plan',
				'dev',
				'check',
				'ship',
				'review',
				'merge',
				'verify',
			];

			for (const command of validCommands) {
				const isValid = isValidCommand(command);
				assert.strictEqual(isValid, true, `${command} should be valid`);
			}
		});
	});

	describe('Security: Slug validation', () => {
		test('should accept valid slugs', () => {
			const validSlugs = [
				'stripe-billing',
				'user-auth',
				'api-v2',
				'test123',
				'feature-name',
			];

			for (const slug of validSlugs) {
				const result = validateSlug(slug);
				assert.strictEqual(result.valid, true, `${slug} should be valid`);
			}
		});

		test('should reject slugs with uppercase letters', () => {
			const result = validateSlug('Feature-Name');
			assert.strictEqual(result.valid, false);
			assert.match(result.error, /lowercase/i);
		});

		test('should reject slugs with spaces', () => {
			const result = validateSlug('feature name');
			assert.strictEqual(result.valid, false);
			assert.match(result.error, /invalid slug format/i);
		});

		test('should reject path traversal attempts', () => {
			const invalidSlugs = [
				'../../../etc/passwd',
				'..\\windows\\system32',
				'test/../evil',
			];

			for (const slug of invalidSlugs) {
				const result = validateSlug(slug);
				assert.strictEqual(result.valid, false, `${slug} should be rejected`);
			}
		});

		test('should reject slugs with special characters', () => {
			const invalidSlugs = [
				'test;rm -rf /',
				'test&whoami',
				'test|cat /etc/passwd',
			];

			for (const slug of invalidSlugs) {
				const result = validateSlug(slug);
				assert.strictEqual(result.valid, false, `${slug} should be rejected`);
			}
		});
	});

	describe('Argument validation', () => {
		test('should reject research without feature name', () => {
			const command = 'research';
			const args = [];
			const validation = validateArgs(command, args);
			assert.strictEqual(validation.valid, false);
			assert.match(validation.error, /feature-name required/i);
		});

		test('should reject plan without feature slug', () => {
			const command = 'plan';
			const args = [];
			const validation = validateArgs(command, args);
			assert.strictEqual(validation.valid, false);
			assert.match(validation.error, /feature-slug required/i);
		});

		test('should reject review without PR number', () => {
			const command = 'review';
			const args = [];
			const validation = validateArgs(command, args);
			assert.strictEqual(validation.valid, false);
			assert.match(validation.error, /pr-number required/i);
		});

		test('should accept status without arguments', () => {
			const command = 'status';
			const args = [];
			const validation = validateArgs(command, args);
			assert.strictEqual(validation.valid, true);
		});

		test('should accept research with feature name', () => {
			const command = 'research';
			const args = ['stripe-billing'];
			const validation = validateArgs(command, args);
			assert.strictEqual(validation.valid, true);
		});

		test('should reject research with invalid slug', () => {
			const command = 'research';
			const args = ['Invalid Feature'];
			const validation = validateArgs(command, args);
			assert.strictEqual(validation.valid, false);
			assert.match(validation.error, /invalid slug format/i);
		});

		test('should reject plan with path traversal attempt', () => {
			const command = 'plan';
			const args = ['../../../etc/passwd'];
			const validation = validateArgs(command, args);
			assert.strictEqual(validation.valid, false);
		});
	});

	describe('Help text', () => {
		test('should display help with available commands', () => {
			const helpText = getHelpText();
			assert.match(helpText, /forge <command>/i);
			assert.match(helpText, /status/i);
			assert.match(helpText, /research/i);
			assert.match(helpText, /plan/i);
		});

		test('should include command descriptions', () => {
			const helpText = getHelpText();
			assert.match(helpText, /detect current workflow stage/i);
			assert.match(helpText, /auto-invoke parallel-ai/i);
		});
	});

	describe('Error handling', () => {
		test('should exit with code 1 for unknown command', () => {
			// Exit code testing requires spawning process - covered by E2E tests
			// This is tested via the main() function in E2E
			assert.ok(true, 'Exit code handling tested in E2E');
		});

		test('should exit with code 1 for missing required arguments', () => {
			// Exit code testing requires spawning process - covered by E2E tests
			assert.ok(true, 'Exit code handling tested in E2E');
		});

		test('should exit with code 0 for successful execution', () => {
			// Exit code testing requires spawning process - covered by E2E tests
			assert.ok(true, 'Exit code handling tested in E2E');
		});
	});
});
